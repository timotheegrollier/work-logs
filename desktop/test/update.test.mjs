import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, hasPackageKit, installKind, installedMatches, isNewer, logUpdateEvent, parsePkconCandidate, parseVersion, pkconInstallArgs, pkconRefreshArgs, pkconUpdatesArgs, shouldOfferUpdate, startPoll } from '../update.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stubFetch = (payload, ok = true) => async () => ({ ok, json: async () => payload });

test('parseVersion ne retient que les versions stables', () => {
  assert.deepEqual(parseVersion('v0.3.0'), [0, 3, 0]);
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('v0.3.0-rc.1'), null);
  assert.equal(parseVersion('nawak'), null);
});

test('isNewer compare chaque segment', () => {
  assert.equal(isNewer('v0.3.0', '0.2.0'), true);
  assert.equal(isNewer('v0.2.1', '0.2.0'), true);
  assert.equal(isNewer('v1.0.0', '0.9.9'), true);
  assert.equal(isNewer('v0.2.0', '0.2.0'), false);
  assert.equal(isNewer('v0.1.9', '0.2.0'), false);
  assert.equal(isNewer('v0.10.0', '0.9.0'), true);
});

test('installKind distingue AppImage, paquet système et dev', () => {
  assert.equal(installKind({ appimage: '/tmp/Wl.AppImage', execPath: '/tmp/x' }), 'appimage');
  assert.equal(installKind({ appimage: '', execPath: '/opt/WorkLogs/worklogs' }), 'system');
  assert.equal(installKind({ appimage: undefined, execPath: '/home/timo/app' }), 'dev');
});

test('checkForUpdate signale une release plus récente', async () => {
  const found = await checkForUpdate({
    currentVersion: '0.2.0',
    fetchImpl: stubFetch({ tag_name: 'v0.3.0' }),
  });
  assert.deepEqual(found, {
    version: '0.3.0',
    url: 'https://github.com/timotheegrollier/work-logs/releases/tag/v0.3.0',
  });
});

test('checkForUpdate reste silencieuse quand il n’y a rien à signaler', async () => {
  assert.equal(
    await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: stubFetch({ tag_name: 'v0.3.0' }) }),
    null,
  );
  assert.equal(
    await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: stubFetch({ tag_name: 'v0.2.0' }) }),
    null,
  );
  assert.equal(
    await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: async () => ({ ok: false }) }),
    null,
  );
  assert.equal(
    await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: async () => { throw new Error('hors ligne'); } }),
    null,
  );
  assert.equal(
    await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: stubFetch({ pas_de_tag: true }) }),
    null,
  );
});

test('hasPackageKit détecte pkcon, pkconInstallArgs vise le paquet', () => {
  assert.equal(hasPackageKit({ existsSync: () => true }), true);
  assert.equal(hasPackageKit({ existsSync: () => false }), false);
  assert.deepEqual(pkconInstallArgs(), ['--noninteractive', '--cache-age', '1', 'install', 'worklogs']);
  assert.deepEqual(pkconUpdatesArgs(), ['--noninteractive', '--plain', 'get-updates']);
  assert.deepEqual(pkconRefreshArgs(), ['--noninteractive', 'refresh', 'force']);
});

test('parsePkconCandidate lit la version proposée par PackageKit', () => {
  assert.equal(parsePkconCandidate('Available\tworklogs-0.6.8-1.x86_64 (wl)\n'), '0.6.8');
  assert.equal(parsePkconCandidate('Available\tfirefox-144.0-1.x86_64 (fedora)\nAvailable\tworklogs-0.6.5-1.x86_64 (worklogs)\n'), '0.6.5');
  assert.equal(parsePkconCandidate('There are no updates available\n'), null);
  assert.equal(parsePkconCandidate(''), null);
});

test('installedMatches refuse une version surprise après install', () => {
  assert.equal(installedMatches('0.6.2\n', '0.6.2'), true);
  assert.equal(installedMatches('0.5.0\n', '0.6.2'), false);
  assert.equal(installedMatches('', '0.6.2'), false);
});

test('startPoll espace les ticks et ignore les chevauchements', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const timers = [];
  const timer = {
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval(id) { timers[id - 1] = null; },
  };
  const stop = startPoll({ intervalMs: 1, tick: async () => { calls++; await gate; }, timer });
  const first = timers[0]();
  timers[0](); // chevauchement : ignoré
  assert.equal(calls, 1);
  release();
  await first;
  await timers[0]();
  assert.equal(calls, 2);
  stop();
  assert.equal(timers[0], null);
});

test('shouldOfferUpdate évite les repropositions et les fausses alertes', () => {
  assert.equal(shouldOfferUpdate('0.6.4', '0.6.3', null), true);
  assert.equal(shouldOfferUpdate('0.6.4', '0.6.3', '0.6.4'), false);
  assert.equal(shouldOfferUpdate('0.6.3', '0.6.3', null), false);
  assert.equal(shouldOfferUpdate(null, '0.6.3', null), false);
});

test('checkForUpdate remonte les erreurs via onError', async () => {
  const errors = [];
  const onError = (message) => errors.push(message);
  assert.equal(await checkForUpdate({ currentVersion: '0.6.3', fetchImpl: async () => { throw new Error('DNS HS'); }, onError }), null);
  assert.equal(await checkForUpdate({ currentVersion: '0.6.3', fetchImpl: async () => ({ ok: false, status: 403 }), onError }), null);
  assert.deepEqual(errors, ['réseau: DNS HS', 'HTTP 403']);
});

test('logUpdateEvent écrit et pivote sans casser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-log-'));
  logUpdateEvent(dir, 'check: current=0.6.3');
  assert.match(fs.readFileSync(path.join(dir, 'update.log'), 'utf8'), /check: current=0\.6\.3/);
  fs.writeFileSync(path.join(dir, 'update.log'), 'x'.repeat(60 * 1024));
  logUpdateEvent(dir, 'check: current=0.6.4');
  assert.ok(fs.statSync(path.join(dir, 'update.log')).size < 60 * 1024);
  fs.rmSync(dir, { recursive: true, force: true });
});
