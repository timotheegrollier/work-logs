import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoogleClient, googleApiError } from '../google.mjs';

const scope = 'https://www.googleapis.com/auth/drive.file';
function fixture({ backend = 'gnome_libsecret', token = {}, response = 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-google-test-'));
  const calls = [];
  let opened;
  const client = createGoogleClient({ profileDir: dir,
    secureStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend,
      encryptString: value => Buffer.from(Buffer.from(value).toString('base64')), decryptString: value => Buffer.from(value.toString(), 'base64').toString() },
    openExternal: async url => { opened = new URL(url); },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/token')) return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, scope, ...token });
      return Response.json({ ok: true }, { status: response });
    },
  });
  client.configure({ installed: { client_id: 'unit-test.apps.googleusercontent.com', client_secret: 'public-desktop-value' } });
  return { client, calls, dir, url: () => opened, async authorize() {
    await client.connect();
    const callback = new URL(opened.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: opened.searchParams.get('state'), code: 'test-code', picked_file_ids: 'doc-test' }).toString();
    const res = await fetch(callback);
    await res.text();
    return res.status;
  }, close() { client.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('OAuth desktop : navigateur système, PKCE, état contrôlé et jetons hors du renderer', async () => {
  const f = fixture();
  try {
    await f.client.connect();
    const opened = f.url();
    assert.equal(opened.origin, 'https://accounts.google.com');
    assert.equal(opened.searchParams.get('scope'), scope);
    assert.equal(opened.searchParams.get('trigger_onepick'), 'true');
    const callback = new URL(opened.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1');
    callback.search = '?state=incorrect&code=test-code';
    assert.equal((await fetch(callback)).status, 400);
    assert.equal(f.calls.length, 0);
    assert.equal(f.client.status().pending, true);
    assert.equal(await f.authorize(), 200);
    const params = f.calls[0].options.body;
    assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), f.url().searchParams.get('code_challenge'));
    assert.equal(f.client.status().connected, true);
    assert.deepEqual(f.client.status().selectedIds, ['doc-test']);
    assert.ok(!JSON.stringify(f.client.status()).includes('test-access'));
    const file = fs.readFileSync(path.join(f.dir, 'google-tokens.enc'), 'utf8');
    assert.ok(!file.includes('test-refresh'));
    assert.equal(fs.statSync(path.join(f.dir, 'google-tokens.enc')).mode & 0o777, 0o600);
    const restored = createGoogleClient({ profileDir: f.dir, openExternal: async () => {},
      secureStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
        decryptString: value => Buffer.from(value.toString(), 'base64').toString() } });
    assert.deepEqual(restored.status().selectedIds, ['doc-test'], 'retrouve la sélection après redémarrage');
    restored.close();
    await assert.rejects(f.client.request('https://example.com'), /non autorisée/);
  } finally { f.close(); }
});

test('distingue API désactivée, scope, quota et droits du fichier sans exposer le message brut Google', () => {
  for (const service of ['drive', 'docs']) {
    const error = googleApiError(403, { error: { details: [{ reason: 'SERVICE_DISABLED', metadata: {
      service: `${service}.googleapis.com`, consumer: 'projects/1234', activationUrl: 'https://untrusted.example' } }] } }, `/${service}/v1/documents`);
    assert.equal(error.code, 'GOOGLE_API_DISABLED');
    assert.match(error.message, /désactivée/);
    assert.equal(error.help_url, `https://console.cloud.google.com/apis/library/${service}.googleapis.com?project=1234`);
  }
  assert.equal(googleApiError(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } }, '/drive/v3/files', '1234-client.apps.googleusercontent.com').code, 'GOOGLE_API_DISABLED');
  assert.equal(googleApiError(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, '/drive/v3/files').code, 'GOOGLE_RATE_LIMIT');
  assert.equal(googleApiError(403, { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, '/docs/v1/documents').code, 'GOOGLE_SCOPE_REQUIRED');
  assert.match(googleApiError(403, { error: { message: 'private upstream detail' } }, '/drive/v3/files').message, /droit de modification/);
});

test('refuse le stockage Linux basic_text avant de lancer la connexion', async () => {
  const f = fixture({ backend: 'basic_text' });
  try {
    await assert.rejects(f.client.connect(), /trousseau/);
    assert.equal(f.url(), undefined);
    assert.equal(fs.existsSync(path.join(f.dir, 'google-tokens.enc')), false);
  } finally { f.close(); }
});

test('renouvelle un jeton expiré une seule fois pour des appels simultanés', async () => {
  const f = fixture({ token: { expires_in: 0.001 } });
  try {
    await f.authorize();
    await Promise.all([f.client.request('/drive/v3/files'), f.client.request('/drive/v3/files')]);
    const grants = f.calls.filter(c => c.url.endsWith('/token')).map(c => c.options.body.get('grant_type'));
    assert.deepEqual(grants, ['authorization_code', 'refresh_token']);
    assert.equal(f.calls.at(-1).options.headers.Authorization, 'Bearer test-access');
  } finally { f.close(); }
});

test('autorise les uploads Drive multipart et les téléchargements texte sans élargir les hôtes', async () => {
  const f = fixture();
  try {
    await f.authorize();
    const uploaded = await f.client.request('/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=test' },
      body: Buffer.from('backup'),
    });
    assert.deepEqual(uploaded, { ok: true });
    const upload = f.calls.find(call => call.url.includes('/upload/drive/v3/files'));
    assert.equal(upload.options.headers['Content-Type'], 'multipart/related; boundary=test');
    assert.equal(upload.options.headers.Authorization, 'Bearer test-access');
    assert.ok(Buffer.isBuffer(upload.options.body));
    const downloaded = await f.client.request('/drive/v3/files/backup-1?alt=media', { responseType: 'text' });
    assert.equal(downloaded, '{"ok":true}');
    const binary = await f.client.request('/drive/v3/files/photo-1?alt=media', { responseType: 'arraybuffer' });
    assert.ok(Buffer.isBuffer(binary));
    assert.equal(JSON.parse(binary.toString('utf8')).ok, true);
  } finally { f.close(); }
});

test('révocation distante et déconnexion locale effacent les identifiants enregistrés', async () => {
  const f = fixture({ response: 401 });
  try {
    await f.authorize();
    await assert.rejects(f.client.request('/drive/v3/files'), /expirée/);
    assert.equal(f.client.status().connected, false);
    assert.equal(fs.existsSync(path.join(f.dir, 'google-tokens.enc')), false);
    await f.authorize();
    await f.client.disconnect();
    assert.equal(f.client.status().connected, false);
    assert.equal(fs.existsSync(path.join(f.dir, 'google-tokens.enc')), false);
    assert.ok(f.calls.some(c => c.url.endsWith('/revoke')));
  } finally { f.close(); }
});

test('un refus utilisateur ou un scope manquant ne connecte pas le compte', async () => {
  const f = fixture({ token: { scope: 'unrelated' } });
  try {
    assert.equal(await f.authorize(), 400);
    assert.equal(f.client.status().connected, false);
    assert.match(f.client.status().error, /pas été accordé/);
    await f.client.connect();
    const callback = new URL(f.url().searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: f.url().searchParams.get('state'), error: 'access_denied' }).toString();
    assert.equal((await fetch(callback)).status, 400);
    assert.match(f.client.status().error, /annulée/);
  } finally { f.close(); }
});
