import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newToken, relayConfig, relayVersion, sameToken, startRelay } from '../src/relay.js';

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

  test('dossiers par le relais : créer, renommer, supprimer (préliminaire CORS compris)', async () => {
    const preflight = await fetch(base + '/api/shared/dir?path=x', {
      method: 'OPTIONS', headers: { Origin: PWA, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'authorization' },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/);
    assert.equal((await call('/api/shared/dir?path=Nouveau', { method: 'POST' })).status, 201);
    const renamed = await call('/api/shared/dir/rename?path=Nouveau', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '3. Sauvegardes' }),
    });
    assert.deepEqual(await renamed.json(), { path: '3. Sauvegardes', name: '3. Sauvegardes' });
    const { token } = await (await call(`/api/shared/dir?path=${encodeURIComponent('3. Sauvegardes')}`)).json();
    const removed = await call(`/api/shared/dir?path=${encodeURIComponent('3. Sauvegardes')}&expect=${token}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(fs.readdirSync(share), []);
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

  test('/health dit la version déployée par la mise à jour automatique (api/VERSION)', async () => {
    const file = path.join(data, 'VERSION');
    assert.equal(relayVersion(file), null, 'depuis les sources : pas de version');
    fs.writeFileSync(file, '0.52.0\n');
    assert.equal(relayVersion(file), '0.52.0');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-relais-data-'));
    const deployed = startRelay({ root: share, token, origins: [PWA], dataDir, host: '127.0.0.1', port: 0, version: '0.52.0' });
    try {
      await new Promise((resolve) => deployed.server.once('listening', resolve));
      const health = await (await fetch(`http://127.0.0.1:${deployed.server.address().port}/health`)).json();
      assert.deepEqual(health, { ok: true, service: 'worklogs-relais', version: '0.52.0' });
    } finally {
      await deployed.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
