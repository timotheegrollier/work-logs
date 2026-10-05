import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDesktopServer } from '../server.mjs';

test('serveur desktop privé, persistant et fermé avec l’application', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-desktop-server-'));
  let server;
  try {
    server = await startDesktopServer({ dataDir, withSeed: false });
    assert.equal(new URL(server.origin).hostname, '127.0.0.1');
    assert.notEqual(new URL(server.origin).port, '8410');
    for (const headers of [{}, { 'x-worklogs-token': 'incorrect' }]) {
      const denied = await fetch(server.origin + '/api/export', { headers });
      assert.equal(denied.status, 403);
      assert.match((await denied.json()).error, /réservé/);
    }
    const headers = { 'x-worklogs-token': server.token, 'Content-Type': 'application/json' };
    const created = await fetch(server.origin + '/api/entries', {
      method: 'POST', headers, body: JSON.stringify({ title: 'Note desktop', content_md: '**Persistant**' }),
    });
    assert.equal(created.status, 201);
    assert.match(created.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    // Le renderer appelle l'endpoint IA en direct : la CSP doit le laisser passer,
    // sans ouvrir connect-src au-delà de l'hôte par défaut.
    assert.match(
      created.headers.get('content-security-policy'),
      /connect-src 'self' https:\/\/generativelanguage\.googleapis\.com/
    );
    const entry = await created.json();
    const oldOrigin = server.origin;
    const oldToken = server.token;
    await Promise.all([server.close(), server.close()]);
    await assert.rejects(fetch(oldOrigin + '/api/health', { headers }));
    server = await startDesktopServer({ dataDir, withSeed: false });
    assert.notEqual(server.token, oldToken);
    const loaded = await fetch(server.origin + '/api/entries/' + entry.id, {
      headers: { 'x-worklogs-token': server.token },
    });
    assert.equal((await loaded.json()).content_md, '**Persistant**');
  } finally {
    await server?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dossier partagé desktop : réglable par le dialogue seulement, conservé, et garde-fous', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-desktop-shared-'));
  const share = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-desktop-share-'));
  let server;
  try {
    server = await startDesktopServer({ dataDir, withSeed: false });
    const headers = { 'x-worklogs-token': server.token };
    const status = async () => (await fetch(server.origin + '/api/shared/status', { headers })).json();
    assert.deepEqual({ ...(await status()), since: null }, {
      available: true, configurable: true, root: null, address: null, label: '', mount: null, reach: 'unconfigured', since: null,
      displayName: (await status()).displayName, projects: {}, pending: 0, conflicts: 0,
    });
    // Trop large, ou pas un dossier : refusé avant d'être retenu.
    await assert.rejects(server.shared.configure('/'), /racine/);
    await assert.rejects(server.shared.configure(os.homedir()), /dossier personnel/);
    fs.writeFileSync(path.join(share, 'a.txt'), 'x');
    await assert.rejects(server.shared.configure(path.join(share, 'a.txt')), /pas un dossier/);
    await assert.rejects(server.shared.configure('relatif'), /absolu/);

    const configured = await server.shared.configure(share, { address: '\\\\tse01\\commun' });
    assert.equal(configured.root, fs.realpathSync(share));
    assert.equal(configured.reach, 'ok');
    assert.equal(configured.address, '\\\\tse01\\commun', 'retenue pour « Se reconnecter »');
    await server.close();
    server = await startDesktopServer({ dataDir, withSeed: false });
    const again = await (await fetch(server.origin + '/api/shared/status', { headers: { 'x-worklogs-token': server.token } })).json();
    assert.equal(again.root, fs.realpathSync(share), 'retenu dans la base locale');
    const listing = await (await fetch(server.origin + '/api/shared/list', { headers: { 'x-worklogs-token': server.token } })).json();
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['a.txt']);
    const forgotten = await server.shared.forget();
    assert.equal(forgotten.root, null);
    assert.equal(forgotten.address, null);
  } finally {
    await server?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(share, { recursive: true, force: true });
  }
});
