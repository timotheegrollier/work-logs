import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newToken, relayConfig, sameToken, startRelay } from '../src/relay.js';

const PWA = 'https://worklogs-google.cocodexcocoder.workers.dev';

describe('relais du dossier partagé (PWA)', () => {
  let share;
  let data;
  let relay;
  let base;
  const token = newToken();
  const call = (url, { headers = {}, ...init } = {}) =>
    fetch(base + url, { ...init, headers: { Authorization: `Bearer ${token}`, Origin: PWA, ...headers } });

  beforeEach(async () => {
    share = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-relais-partage-'));
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-relais-data-'));
    relay = startRelay({ root: share, token, origins: [PWA], dataDir: data, host: '127.0.0.1', port: 0, displayName: 'Timothée (mobile)', label: '00. PROCEDURE' });
    await new Promise((resolve) => relay.server.once('listening', resolve));
    base = `http://127.0.0.1:${relay.server.address().port}`;
  });
  afterEach(async () => {
    await relay.stop();
    fs.rmSync(share, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  test('sans le bon code : refusé ; /health répond sans code', async () => {
    assert.equal((await fetch(base + '/api/shared/status')).status, 401);
    const wrong = await fetch(base + '/api/shared/status', { headers: { Authorization: 'Bearer faux' } });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, 'RELAY_UNAUTHORIZED');
    assert.deepEqual(await (await fetch(base + '/health')).json(), { ok: true, service: 'worklogs-relais' });
    const status = await (await call('/api/shared/status')).json();
    assert.equal(status.available, true);
    assert.equal(status.reach, 'ok');
    assert.equal(status.configurable, false, 'la racine ne se règle jamais à distance');
    assert.equal(status.displayName, 'Timothée (mobile)');
    assert.equal(status.label, '00. PROCEDURE', 'le nom du dossier, pas celui du point de montage');
    // Un nom changé depuis le téléphone survit au redémarrage du relais.
    await call('/api/shared/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ display_name: 'T. G. (téléphone)' }) });
    await relay.stop();
    relay = startRelay({ root: share, token, origins: [PWA], dataDir: data, host: '127.0.0.1', port: 0, displayName: 'Timothée (mobile)', label: '00. PROCEDURE' });
    await new Promise((resolve) => relay.server.once('listening', resolve));
    base = `http://127.0.0.1:${relay.server.address().port}`;
    assert.equal((await (await call('/api/shared/status')).json()).displayName, 'T. G. (téléphone)');
  });

  test('CORS : la PWA seulement, préliminaire « réseau privé » compris', async () => {
    const preflight = await fetch(base + '/api/shared/list', {
      method: 'OPTIONS',
      headers: { Origin: PWA, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization', 'Access-Control-Request-Private-Network': 'true' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), PWA);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
    const other = await fetch(base + '/api/shared/list', { method: 'OPTIONS', headers: { Origin: 'https://ailleurs.example', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(other.status, 403);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const listed = await call('/api/shared/list');
    assert.equal(listed.headers.get('access-control-allow-origin'), PWA);
  });

  test('de bout en bout : créer, ouvrir, envoyer, relier un dossier à un projet du téléphone', async () => {
    fs.mkdirSync(path.join(share, '2. TSE'));
    const created = await call(`/api/shared/create?path=${encodeURIComponent('2. TSE/Redémarrage.md')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('# Redémarrage\n\n'),
    });
    assert.equal(created.status, 200);
    const file = await created.json();
    const pushed = await call(`/api/shared/push?path=${encodeURIComponent('2. TSE/Redémarrage.md')}&base=${file.base_hash}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('# Redémarrage\n\nRedémarrer le service.\n'),
    });
    assert.equal((await pushed.json()).state, 'written');
    assert.equal(fs.readFileSync(path.join(share, '2. TSE', 'Redémarrage.md'), 'utf8'), '# Redémarrage\n\nRedémarrer le service.\n');
    // Les projets vivent sur le téléphone : un identifiant inconnu du relais se relie quand même.
    const linked = await call('/api/shared/projects/pr_muatn4uej2g098/folder', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: '2. TSE' }),
    });
    assert.deepEqual((await linked.json()).projects, { pr_muatn4uej2g098: '2. TSE' });
  });

  test('réglages : racine et code obligatoires, origine de la PWA par défaut', () => {
    assert.throws(() => relayConfig({}), /WORKLOGS_SHARED_ROOT/);
    assert.throws(() => relayConfig({ WORKLOGS_SHARED_ROOT: share, WORKLOGS_RELAY_TOKEN: 'court', WORKLOGS_RELAY_TOKEN_FILE: path.join(data, 'absent') }), /Code d’accès/);
    const config = relayConfig({ WORKLOGS_SHARED_ROOT: share, WORKLOGS_RELAY_TOKEN: token });
    assert.deepEqual(config.origins, [PWA]);
    assert.equal(config.host, '127.0.0.1', 'écoute locale : tailscale serve seul est exposé');
    assert.equal(sameToken(token, token), true);
    assert.equal(sameToken(token, token.slice(1)), false);
    assert.equal(sameToken('', token), false);
  });
});
