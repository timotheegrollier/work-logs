import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, hasPackageKit, hasPkexec, installedVersionCommand, installKind, installedMatches, isAuthorizationFailure, isNewer, logUpdateEvent, packageManager, parseManagerProgress, parsePkconCandidate, parseVersion, pkconProbeOutcome, pkconRefreshArgs, pkconUpdatesArgs, privilegedInstallCommand, releaseAgeMinutes, repoHint, shouldOfferUpdate, startPoll } from '../update.mjs';
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

test('hasPackageKit et hasPkexec détectent les deux outils du chemin de mise à jour', () => {
  assert.equal(hasPackageKit({ existsSync: () => true }), true);
  assert.equal(hasPackageKit({ existsSync: () => false }), false);
  assert.equal(hasPkexec({ existsSync: (p) => p === '/usr/bin/pkexec' }), true);
  assert.equal(hasPkexec({ existsSync: () => false }), false);
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

test('l’installation passe par pkexec, jamais par une transaction pkcon', () => {
  // Les deux formes de `pkcon update` sont sans issue depuis une application
  // graphique : sans --noninteractive il exige un vrai terminal pour sa
  // confirmation (« user declined simulation »), avec il interdit à polkit
  // d'afficher le moindre dialogue (« Failed to obtain authentication »).
  // `pkexec` demande l'autorisation à l'agent polkit de la session, puis
  // installe en root. Reproduit sur Mint 22, corrigé en 0.9.1.
  const apt = privilegedInstallCommand('apt');
  assert.equal(apt.file, 'pkexec');
  assert.deepEqual(apt.args, ['/usr/bin/apt-get', '-o', 'Dpkg::Use-Pty=0', 'install', '-y', '--only-upgrade', 'worklogs']);

  const dnf = privilegedInstallCommand('dnf');
  assert.equal(dnf.file, 'pkexec');
  assert.deepEqual(dnf.args, ['/usr/bin/dnf', 'upgrade', '-y', 'worklogs']);

  // Chemin absolu obligatoire : pkexec nettoie l'environnement, un nom court
  // dépendrait d'un PATH qui n'est plus celui de la session.
  for (const manager of ['apt', 'dnf']) {
    assert.ok(privilegedInstallCommand(manager).args[0].startsWith('/usr/bin/'));
    assert.equal(privilegedInstallCommand(manager).args.includes('--noninteractive'), false);
  }

  // Les deux étapes de lecture n'exigent aucune autorisation
  // (`system-sources-refresh` est en `implicit active: yes`) : elles peuvent
  // rester non interactives, et doivent le rester pour ne jamais bloquer.
  assert.ok(pkconRefreshArgs().includes('--noninteractive'));
  assert.ok(pkconUpdatesArgs().includes('--noninteractive'));
});

test('isAuthorizationFailure ne confond pas refus d’autorisation et abandon de pkcon', () => {
  // 126 : pkexec n'a pas obtenu l'autorisation (dialogue fermé, mot de passe faux).
  assert.equal(isAuthorizationFailure({ code: 126, output: '' }), true);
  assert.equal(isAuthorizationFailure({ code: 1, output: 'Error executing command as another user: Not authorized' }), true);
  assert.equal(isAuthorizationFailure({ code: 7, output: 'Erreur fatale: Failed to obtain authentication' }), true);

  // Le piège corrigé : ce message n'a rien d'une autorisation refusée, c'est
  // pkcon qui renonce faute de terminal. Annoncer « autorisation administrateur
  // non accordée » envoyait chercher du mauvais côté — signalé en 0.9.0.
  assert.equal(isAuthorizationFailure({ code: 7, output: 'Erreur fatale: user declined simulation' }), false);
  // 127 est ambigu chez pkexec : refus d'autorisation *ou* erreur d'exécution.
  // Seul le message tranche, sinon toute panne serait annoncée comme un refus.
  assert.equal(isAuthorizationFailure({ code: 127, output: 'pkexec: /usr/bin/apt-get: No such file or directory' }), false);
  assert.equal(isAuthorizationFailure({ code: 127, output: 'Error executing command as another user: Not authorized' }), true);
  assert.equal(isAuthorizationFailure({ code: 100, output: 'E: Impossible de récupérer worklogs' }), false);
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

test('parseManagerProgress lit la phase d’une installation apt ou dnf', () => {
  // Sortie relevée sur la machine de production (locale française, via pkexec).
  assert.deepEqual(
    parseManagerProgress('Réception de :1 https://…/deb ./ worklogs 0.9.0 [98,1 MB]\n'),
    { phase: 'download', percent: null },
  );
  assert.deepEqual(
    parseManagerProgress('Réception de :1 …\nPréparation du dépaquetage de …/worklogs_0.9.0_amd64.deb ...\nDépaquetage de worklogs (0.9.0) sur (0.8.0) ...\n'),
    { phase: 'install', percent: null },
  );
  // Et en anglais : la commande hérite de la locale système, pas de la nôtre.
  assert.deepEqual(parseManagerProgress('Get:1 https://…\n'), { phase: 'download', percent: null });
  assert.deepEqual(parseManagerProgress('Running transaction\n'), { phase: 'install', percent: null });
  assert.deepEqual(parseManagerProgress('Upgrading   : worklogs-0.9.0-1.x86_64\n'), { phase: 'install', percent: null });
  assert.equal(parseManagerProgress('Lecture des listes de paquets…\n'), null);
  assert.equal(parseManagerProgress(''), null);
});
