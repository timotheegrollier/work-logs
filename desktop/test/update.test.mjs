import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, hasPackageKit, installedVersionCommand, installKind, installedMatches, isNewer, logUpdateEvent, packageManager, parsePkconCandidate, parsePkconProgress, parseVersion, pkconInstallArgs, pkconProbeOutcome, pkconRefreshArgs, pkconUpdatesArgs, releaseAgeMinutes, repoHint, shouldOfferUpdate, startPoll } from '../update.mjs';
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
    publishedAt: null,
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
  assert.deepEqual(pkconInstallArgs(), ['--cache-age', '1', 'update', 'worklogs']);
  assert.deepEqual(pkconUpdatesArgs(), ['--noninteractive', '--plain', 'get-updates']);
  assert.deepEqual(pkconRefreshArgs(), ['--noninteractive', 'refresh', 'force']);
});

test('parsePkconCandidate lit la version proposée par PackageKit', () => {
  assert.equal(parsePkconCandidate('Available\tworklogs-0.6.8-1.x86_64 (wl)\n'), '0.6.8');
  assert.equal(parsePkconCandidate('Available\tfirefox-144.0-1.x86_64 (fedora)\nAvailable\tworklogs-0.6.5-1.x86_64 (worklogs)\n'), '0.6.5');
  assert.equal(parsePkconCandidate('There are no updates available\n'), null);
  assert.equal(parsePkconCandidate(''), null);
});

test('parsePkconCandidate lit aussi le format apt (Debian/Mint)', () => {
  // Relevé en conteneur ubuntu:24.04 : pas de révision `-1`, arch collée à la
  // version. L'ancienne expression exigeait la révision et ne trouvait rien.
  assert.equal(parsePkconCandidate('Normal       worklogs-0.6.13.amd64 (worklogs-stable-)\n'), '0.6.13');
  assert.equal(
    parsePkconCandidate('Bug fix      libc6-2.39-0ubuntu8.9.amd64 (ubuntu-noble-updates-main)\nNormal       worklogs-0.7.0.amd64 (worklogs-stable-)\n'),
    '0.7.0'
  );
});

test('pkconProbeOutcome n’autorise l’installation qu’avec le bon candidat', () => {
  const probe = (code, output) => pkconProbeOutcome({ code, output, expected: '0.6.13' });

  assert.equal(probe(0, 'Normal worklogs-0.6.13.amd64 (wl)').decision, 'ready');
  assert.equal(probe(0, 'Available\tworklogs-0.6.13-1.x86_64 (wl)').decision, 'ready');

  // Le cas Mint : `get-updates` sort en 5 quand il n'y a rien à installer.
  // Il faut un repli manuel, surtout pas une tentative d'installation.
  const nothing = probe(5, 'There are no updates available');
  assert.equal(nothing.decision, 'none');
  assert.equal(nothing.probeFailed, true);
  assert.equal(probe(0, 'There are no updates available').decision, 'none');

  // Dépôt en retard : on s'arrête et on le dit, sans rien installer.
  assert.deepEqual(
    { ...probe(0, 'Available\tworklogs-0.6.11-1.x86_64 (wl)') },
    { decision: 'mismatch', candidate: '0.6.11' }
  );
});

test('packageManager et repoHint parlent la langue du système', () => {
  const dnf = packageManager({ existsSync: (p) => p === '/usr/bin/dnf' });
  const apt = packageManager({ existsSync: (p) => p === '/usr/bin/apt-get' });
  assert.equal(dnf, 'dnf');
  assert.equal(apt, 'apt');
  assert.equal(packageManager({ existsSync: () => false }), null);

  assert.match(repoHint(dnf).update, /dnf update worklogs/);
  assert.match(repoHint(dnf).enable, /yum\.repos\.d/);
  assert.match(repoHint(apt).update, /apt install --only-upgrade worklogs/);
  assert.match(repoHint(apt).enable, /sources\.list\.d/);
  assert.match(repoHint(apt).url, /\/deb$/);
});

test('installedVersionCommand interroge la bonne base de paquets', () => {
  assert.deepEqual(installedVersionCommand('apt'), { file: 'dpkg-query', args: ['-W', '-f', '${Version}', 'worklogs'] });
  assert.deepEqual(installedVersionCommand('dnf'), { file: 'rpm', args: ['-q', '--qf', '%{VERSION}', 'worklogs'] });
});

test('la transaction de mise à jour laisse polkit demander le mot de passe', () => {
  // `system-update` est en `auth_admin_keep` : avec --noninteractive, polkit
  // refuse sans afficher de dialogue et la mise à jour échoue en silence.
  // C'est ce qui rendait la mise à jour in-app inopérante sur une vraie session.
  assert.equal(pkconInstallArgs().includes('--noninteractive'), false);
  assert.deepEqual(pkconInstallArgs(), ['--cache-age', '1', 'update', 'worklogs']);

  // Les deux étapes de lecture n'exigent aucune autorisation
  // (`system-sources-refresh` est en `implicit active: yes`) : elles peuvent
  // rester non interactives, et doivent le rester pour ne jamais bloquer.
  assert.ok(pkconRefreshArgs().includes('--noninteractive'));
  assert.ok(pkconUpdatesArgs().includes('--noninteractive'));
});

test('installedMatches refuse une version surprise après install', () => {
  assert.equal(installedMatches('0.6.2\n', '0.6.2'), true);
  assert.equal(installedMatches('0.5.0\n', '0.6.2'), false);
  assert.equal(installedMatches('', '0.6.2'), false);
  // dpkg-query peut ajouter la révision Debian : même version, pas un échec.
  assert.equal(installedMatches('0.6.2-1\n', '0.6.2'), true);
  assert.equal(installedMatches('0.6.1-9\n', '0.6.2'), false);
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

test('checkForUpdate expose la date de publication', async () => {
  const found = await checkForUpdate({
    currentVersion: '0.6.9',
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.6.10', published_at: '2026-09-12T21:00:00Z' }) }),
  });
  assert.deepEqual(found, {
    version: '0.6.10',
    url: 'https://github.com/timotheegrollier/work-logs/releases/tag/v0.6.10',
    publishedAt: '2026-09-12T21:00:00Z',
  });
});

test('releaseAgeMinutes mesure la fraîcheur dune release', () => {
  const now = Date.parse('2026-09-12T21:10:00Z');
  assert.equal(releaseAgeMinutes('2026-09-12T21:00:00Z', now), 10);
  assert.equal(releaseAgeMinutes(null, now), null);
  assert.equal(releaseAgeMinutes('nawak', now), null);
  assert.equal(releaseAgeMinutes('2026-09-12T22:00:00Z', now), null);
});

test('parsePkconProgress lit le statut et le pourcentage', () => {
  assert.deepEqual(
    parsePkconProgress('Status: \tDownloading packages\nPercentage:\t42\n'),
    { phase: 'download', percent: 42 },
  );
  assert.deepEqual(
    parsePkconProgress('Status: \tQuerying\nStatus: \tRunning\nPercentage:\t100\nStatus: \tFinished\n'),
    { phase: 'install', percent: 100 },
  );
  assert.deepEqual(parsePkconProgress('Status: \tWaiting in queue\n'), { phase: 'install', percent: null });
  assert.equal(parsePkconProgress('Results:\n'), null);
  assert.equal(parsePkconProgress(''), null);
});
