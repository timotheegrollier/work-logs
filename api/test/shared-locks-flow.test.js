import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApi, make, officeOwnerFile } from './helpers.js';
import { createSharedIo } from '../src/shared-io.js';
import { formatWorkLogsLock } from '../src/shared-locks.js';

const q = encodeURIComponent;

/**
 * Lot 2 : notre verrou (pris à la première frappe), celui des autres, le bail,
 * les sous-dossiers par projet, la restauration d'une version, « Ouvrir avec… ».
 * Le « partage » est un dossier temporaire ; l'horloge est injectée.
 */
describe('dossier partagé — verrous, projets, versions', () => {
  let api;
  let share;
  let now;

  const write = (rel, contents) => {
    fs.mkdirSync(path.dirname(path.join(share, rel)), { recursive: true });
    fs.writeFileSync(path.join(share, rel), contents);
  };
  const lockFile = (name) => path.join(share, `.~lock.${name}#`);
  const lock = (rel, body = {}) => api.post(`/api/shared/lock?path=${q(rel)}`, body);
  const unlock = (rel) => api.del(`/api/shared/lock?path=${q(rel)}`);
  const open = (rel) => api.get(`/api/shared/file?path=${q(rel)}`);
  const otherWorkLogs = (name) => formatWorkLogsLock({ displayName: 'Hélène Martin', user: 'hmartin', host: 'pc-helene', instance: 'autre-poste', nonce: 'n1', date: new Date() });

  beforeEach(async () => {
    share = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-share-lock-'));
    now = Date.now();
    api = await startApi({ shared: { root: share, io: createSharedIo(), clock: () => now } });
    await api.put('/api/shared/settings', { display_name: 'Timothée Grollier' });
  });
  afterEach(async () => {
    await api.close();
    fs.rmSync(share, { recursive: true, force: true });
  });

  test('prendre la main pose un verrou LibreOffice à notre nom ; renouveler le garde ; rendre le retire', async () => {
    write('notes.md', 'v1');
    const taken = await lock('notes.md');
    assert.equal(taken.status, 200);
    assert.equal(taken.body.held, true);
    const content = fs.readFileSync(lockFile('notes.md'), 'utf8');
    assert.match(content, /^Timothée Grollier \(WorkLogs\),[^,]+,[^,]+,\d\d\.\d\d\.\d{4} \d\d:\d\d,worklogs:test-instance:[0-9a-f]+;$/);
    // Notre verrou ne bloque ni la lecture, ni l'envoi, ni un renouvellement.
    assert.equal((await open('notes.md')).body.lock.self, true);
    assert.equal((await lock('notes.md')).status, 200);
    assert.equal(fs.readFileSync(lockFile('notes.md'), 'utf8').split(',').pop(), content.split(',').pop(), 'même verrou');
    const file = (await open('notes.md')).body;
    const sent = await fetch(`${api.base}/api/shared/push?path=notes.md&base=${file.base_hash}`, { method: 'POST', body: 'v2' });
    assert.equal((await sent.json()).state, 'written');

    const released = await unlock('notes.md');
    assert.equal(released.body.held, false);
    assert.equal(fs.existsSync(lockFile('notes.md')), false);
  });

  test('LibreOffice chez un collègue, ou Word (`~$`) : la main est refusée, avec son nom', async () => {
    write('relevés.csv', 'a;b');
    write('.~lock.relevés.csv#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/x;');
    const refused = await lock('relevés.csv');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'SHARED_LOCKED');
    assert.equal(refused.body.error, 'Ouvert par Hélène Martin dans LibreOffice.');
    assert.equal(refused.body.lock.app, 'libreoffice');

    write('Procédure filtration.docx', 'docx');
    write('~$océdure filtration.docx', officeOwnerFile('Jean Dupont'));
    const word = await lock('Procédure filtration.docx');
    assert.equal(word.status, 409);
    assert.equal(word.body.error, 'Ouvert par Jean Dupont dans Word.');
    // Reprise explicite : notre verrou est posé, le `~$` de Word n'est jamais touché.
    const forced = await lock('Procédure filtration.docx', { take_over: true });
    assert.equal(forced.status, 200);
    assert.ok(fs.existsSync(path.join(share, '~$océdure filtration.docx')));
    assert.equal(forced.body.lock.app, 'word', 'le verrou d’un autre reste affiché avant le nôtre');
  });

  test('verrou WorkLogs d’un autre poste : oublié après 3 min sans renouvellement, repris sur demande', async () => {
    write('notes.md', 'v1');
    write('.~lock.notes.md#', otherWorkLogs());
    const fresh = await lock('notes.md');
    assert.equal(fresh.body.code, 'SHARED_LOCKED');
    assert.equal(fresh.body.lock.by, 'Hélène Martin');
    now += 2 * 60 * 1000;
    assert.equal((await lock('notes.md')).body.code, 'SHARED_LOCKED', 'deux minutes : encore le sien');
    now += 2 * 60 * 1000;
    const stale = await lock('notes.md');
    assert.equal(stale.body.code, 'SHARED_LOCK_STALE');
    assert.equal(stale.body.lock.stale, true);
    assert.equal((await api.get('/api/shared/list')).body.entries[0].lock.stale, true);
    const taken = await lock('notes.md', { take_over: true });
    assert.equal(taken.status, 200);
    assert.match(fs.readFileSync(lockFile('notes.md'), 'utf8'), /worklogs:test-instance:/);
  });

  test('un verrou renouvelé par l’autre poste n’est jamais jugé oublié', async () => {
    write('notes.md', 'v1');
    write('.~lock.notes.md#', otherWorkLogs());
    await lock('notes.md');
    now += 2 * 60 * 1000;
    fs.utimesSync(lockFile('notes.md'), new Date(), new Date(Date.now() + 60_000));
    await lock('notes.md');
    now += 2 * 60 * 1000;
    assert.equal((await lock('notes.md')).body.code, 'SHARED_LOCKED');
  });

  test('bail : sans renouvellement depuis 3 min, la main est rendue', async () => {
    write('notes.md', 'v1');
    await lock('notes.md');
    now += 2 * 60 * 1000;
    await api.shared.expireLocks();
    assert.ok(fs.existsSync(lockFile('notes.md')), 'deux minutes : gardé');
    now += 2 * 60 * 1000;
    await api.shared.expireLocks();
    assert.equal(fs.existsSync(lockFile('notes.md')), false);
    assert.equal((await open('notes.md')).body.held, false);
  });

  test('on ne retire jamais un verrou qui n’est plus le nôtre', async () => {
    write('notes.md', 'v1');
    await lock('notes.md');
    write('.~lock.notes.md#', otherWorkLogs());
    await unlock('notes.md');
    assert.match(fs.readFileSync(lockFile('notes.md'), 'utf8'), /autre-poste/);
    const renewed = await lock('notes.md');
    assert.equal(renewed.status, 409, 'perdu : la main est à l’autre');
  });

  test('restes d’une session précédente : rendus au démarrage, comme à l’arrêt', async () => {
    write('notes.md', 'v1');
    await lock('notes.md');
    assert.ok(fs.existsSync(lockFile('notes.md')));
    await api.shared.stop();
    assert.equal(fs.existsSync(lockFile('notes.md')), false, 'l’arrêt rend la main');

    // Fermeture brutale : le verrou et la ligne restent ; le prochain démarrage les rend.
    write('.~lock.notes.md#', formatWorkLogsLock({ displayName: 'Moi', user: 'timo', host: 'pc', instance: 'test-instance', nonce: 'vieux', date: new Date() }));
    api.db.prepare("UPDATE shared_files SET lock_nonce='vieux', lock_renewed_at=? WHERE rel_path='notes.md'").run(new Date().toISOString());
    const { createSharedService } = await import('../src/shared-service.js');
    const again = createSharedService({ db: api.db, blobDir: path.join(api.dir, 'shared-blobs'), root: share, retryMs: 0, probeMs: 0, mountCheckMs: 0, instance: 'test-instance' });
    for (let i = 0; i < 50 && fs.existsSync(lockFile('notes.md')); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(lockFile('notes.md')), false);
    await again.stop();
  });

  test('LibreOffice ouvert sur cet ordinateur (« Ouvrir avec… ») met aussi l’envoi en attente', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    write('.~lock.notes.md#', `Moi,${os.userInfo().username},${os.hostname()},05.10.2026 09:00,file:///home/x;`);
    const sent = await fetch(`${api.base}/api/shared/push?path=notes.md&base=${file.base_hash}`, { method: 'POST', body: 'v2' });
    const body = await sent.json();
    assert.equal(body.state, 'pending');
    assert.equal(body.lock.self, true);
    assert.equal(fs.readFileSync(path.join(share, 'notes.md'), 'utf8'), 'v1');
  });

  test('un projet se relie à un sous-dossier existant du partage, et s’en délie', async () => {
    const project = await make.project(api, 'Piscine');
    write('Piscine/consignes.md', '# Consignes');
    write('fichier.txt', 'x');
    const linked = await api.put(`/api/shared/projects/${project.id}/folder`, { dir: 'Piscine' });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.body.projects, { [project.id]: 'Piscine' });
    assert.equal((await api.put(`/api/shared/projects/${project.id}/folder`, { dir: 'fichier.txt' })).body.code, 'SHARED_NOT_DIR');
    assert.equal((await api.put(`/api/shared/projects/${project.id}/folder`, { dir: 'absent' })).status, 404);
    assert.equal((await api.put(`/api/shared/projects/${project.id}/folder`, { dir: '../x' })).status, 400);
    assert.equal((await api.put('/api/shared/projects/pr_inconnu/folder', { dir: 'Piscine' })).status, 404);
    assert.deepEqual((await api.del(`/api/shared/projects/${project.id}/folder`)).body.projects, {});
  });

  test('restaurer une version en fait le brouillon, sans rien envoyer', async () => {
    write('notes.md', 'version 1');
    const first = (await open('notes.md')).body;
    write('notes.md', 'version 2, plus longue');
    await open('notes.md');
    const old = (await api.get('/api/shared/versions?path=notes.md')).body.versions.find((v) => v.hash === first.hash);
    const restored = await api.post(`/api/shared/versions/${old.id}/restore?path=notes.md`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.draft.template_hash, first.hash);
    assert.equal(restored.body.draft.model, null);
    assert.equal(restored.body.state, 'draft');
    assert.equal(fs.readFileSync(path.join(share, 'notes.md'), 'utf8'), 'version 2, plus longue');
    const sent = await fetch(`${api.base}/api/shared/push?path=notes.md`, { method: 'POST', body: 'version 1' });
    assert.equal((await sent.json()).state, 'written', 'la base est la version actuelle du partage');
    assert.equal(fs.readFileSync(path.join(share, 'notes.md'), 'utf8'), 'version 1');
    assert.equal((await api.post(`/api/shared/versions/sv_inconnue/restore?path=notes.md`)).status, 404);
  });

  test('« Ouvrir avec… » : le vrai fichier, refusé tant qu’un brouillon n’est pas envoyé, notre verrou rendu', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    await lock('notes.md');
    await api.put('/api/shared/draft?path=notes.md', { model: { text: 'v2' }, template_hash: file.hash, base_hash: file.base_hash });
    await assert.rejects(api.shared.openTarget('notes.md'), /brouillon/);
    await fetch(`${api.base}/api/shared/draft/discard?path=notes.md`, { method: 'POST' });
    assert.equal(await api.shared.openTarget('notes.md'), path.join(fs.realpathSync(share), 'notes.md'));
    assert.equal(fs.existsSync(lockFile('notes.md')), false);
    await assert.rejects(api.shared.openTarget('../etc/passwd'), /Chemin/);
  });
});
