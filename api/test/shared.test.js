import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startApi, make, officeOwnerFile } from './helpers.js';
import { createSharedIo } from '../src/shared-io.js';
import { buildBackup, restoreBackup } from '../src/backup.js';
import { formatWorkLogsLock } from '../src/shared-locks.js';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const q = encodeURIComponent;

/**
 * Le « partage » est un dossier temporaire : le test y joue le collègue
 * (réécrit un fichier, dépose un `~$` de Word, un verrou LibreOffice…).
 */
describe('dossier partagé', () => {
  let api;
  let share;
  let io;

  const write = (rel, contents) => {
    fs.mkdirSync(path.dirname(path.join(share, rel)), { recursive: true });
    fs.writeFileSync(path.join(share, rel), contents);
  };
  const read = (rel) => fs.readFileSync(path.join(share, rel), 'utf8');
  const open = (rel) => api.get(`/api/shared/file?path=${q(rel)}`);
  const push = async (rel, contents, base = '') => {
    const res = await fetch(`${api.base}/api/shared/push?path=${q(rel)}${base ? `&base=${base}` : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(contents),
    });
    return { status: res.status, body: await res.json() };
  };
  const draft = (rel, model, file) =>
    api.put(`/api/shared/draft?path=${q(rel)}`, { model, template_hash: file.hash, base_hash: file.base_hash });

  beforeEach(async () => {
    share = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-share-'));
    io = createSharedIo();
    api = await startApi({ shared: { root: share, io } });
  });
  afterEach(async () => {
    await api.close();
    fs.rmSync(share, { recursive: true, force: true });
  });

  test('sans partage, la route dit seulement « indisponible »', async () => {
    const plain = await startApi();
    try {
      assert.deepEqual((await plain.get('/api/shared/status')).body, { available: false });
      assert.equal((await plain.get('/api/shared/list')).status, 404);
    } finally {
      await plain.close();
    }
  });

  test('état : joignable, système de fichiers local, rien en attente', async () => {
    const { status, body } = await api.get('/api/shared/status');
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.equal(body.reach, 'ok');
    assert.equal(body.mount, 'local');
    assert.equal(body.label, path.basename(share));
    assert.equal(body.configurable, false, 'le chemin ne se règle pas par HTTP');
    assert.equal(body.pending, 0);
    assert.equal(body.conflicts, 0);
  });

  test('réservé à cet ordinateur : un autre hôte ou un site tiers est refusé', async () => {
    // `fetch` impose son propre `Host` : il faut une requête brute pour en envoyer un autre.
    const foreign = await new Promise((resolve, reject) => {
      http.get(`${api.base}/api/shared/status`, { headers: { Host: 'worklogs.example.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(foreign, 403);
    const crossSite = await fetch(`${api.base}/api/shared/status`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).code, 'SHARED_LOCAL_ONLY');
  });

  test('liste un niveau : dossiers d’abord, fichiers techniques et liens masqués, verrous lus', async () => {
    write('Procédures/filtration.docx', 'docx');
    write('relevés.csv', 'a;b\n');
    write('notes.md', '# Notes\n');
    write('Thumbs.db', 'x');
    write('~$levés.csv', 'faux');
    write('~$relevés.csv', officeOwnerFile('Jean Dupont', { excel: true }));
    write('.~lock.notes.md#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/x;');
    fs.symlinkSync('/etc', path.join(share, 'raccourci'));

    const { status, body } = await api.get('/api/shared/list');
    assert.equal(status, 200);
    assert.deepEqual(body.entries.map((entry) => [entry.name, entry.type]), [
      ['Procédures', 'dir'], ['notes.md', 'file'], ['relevés.csv', 'file'],
    ]);
    const csv = body.entries.find((entry) => entry.name === 'relevés.csv');
    assert.equal(csv.lock.app, 'excel');
    assert.equal(csv.lock.by, 'Jean Dupont');
    assert.equal(csv.ext, 'csv');
    const md = body.entries.find((entry) => entry.name === 'notes.md');
    assert.equal(md.lock.app, 'libreoffice');
    assert.equal(md.lock.by, 'Hélène Martin');

    const inner = await api.get(`/api/shared/list?dir=${q('Procédures')}`);
    assert.deepEqual(inner.body.entries.map((entry) => entry.path), ['Procédures/filtration.docx']);
  });

  test('refuse les chemins qui sortent du partage', async () => {
    fs.symlinkSync(os.tmpdir(), path.join(share, 'dehors'));
    for (const bad of ['../x', '/etc/passwd', 'a//b', 'a\\b']) {
      assert.equal((await open(bad)).status, 400, bad);
    }
    const outside = await api.get(`/api/shared/list?dir=dehors`);
    assert.equal(outside.status, 403);
    assert.equal(outside.body.code, 'SHARED_OUTSIDE');
  });

  test('ouvrir : empreinte, octets servis depuis le magasin local, version « lue » gardée', async () => {
    write('notes.md', '# Bonjour\n');
    const { status, body } = await open('notes.md');
    assert.equal(status, 200);
    assert.equal(body.hash, sha256('# Bonjour\n'));
    assert.equal(body.base_hash, body.hash);
    assert.equal(body.source, 'share');
    assert.equal(body.draft, null);
    const content = await fetch(`${api.base}/api/shared/content?hash=${body.hash}`);
    assert.equal(await content.text(), '# Bonjour\n');
    const versions = await api.get(`/api/shared/versions?path=notes.md`);
    assert.deepEqual(versions.body.versions.map((v) => [v.origin, v.state]), [['base', 'read']]);
  });

  test('un brouillon reste sur cet ordinateur ; l’envoi l’écrit et le consomme', async () => {
    write('notes.md', 'v1\n');
    const file = (await open('notes.md')).body;
    const saved = await draft('notes.md', { text: 'v1\nmoi\n' }, file);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.state, 'draft');
    assert.deepEqual(saved.body.draft.model, { text: 'v1\nmoi\n' });
    assert.equal(read('notes.md'), 'v1\n', 'le brouillon ne touche jamais le partage');
    const listed = await api.get('/api/shared/list');
    assert.equal(listed.body.entries[0].local.draft, true);

    const sent = await push('notes.md', 'v1\nmoi\n', file.base_hash);
    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, 'written');
    assert.equal(read('notes.md'), 'v1\nmoi\n');
    assert.equal(sent.body.file.draft, null, 'brouillon consommé');
    assert.equal(sent.body.file.base_hash, sha256('v1\nmoi\n'));
    const versions = await api.get('/api/shared/versions?path=notes.md');
    assert.deepEqual(versions.body.versions.map((v) => [v.origin, v.state]), [['mine', 'written'], ['base', 'read']]);
  });

  test('conflit : un collègue a enregistré entre-temps — rien n’est écrasé', async () => {
    write('relevés.csv', 'a;b\n');
    const file = (await open('relevés.csv')).body;
    await draft('relevés.csv', { rows: [0] }, file);
    write('relevés.csv', 'a;b\nduc;2\n');

    const sent = await push('relevés.csv', 'a;b\nmoi;1\n', file.base_hash);
    assert.equal(sent.status, 409);
    assert.equal(sent.body.code, 'SHARED_CONFLICT');
    assert.equal(sent.body.theirs.hash, sha256('a;b\nduc;2\n'));
    assert.equal(read('relevés.csv'), 'a;b\nduc;2\n');
    assert.equal((await api.get('/api/shared/status')).body.conflicts, 1);
    // Tant que le conflit n'est pas réglé, pas de nouvel envoi.
    assert.equal((await push('relevés.csv', 'autre', file.base_hash)).status, 409);
    // Choix périmé : le fichier a encore bougé.
    const stale = await api.post('/api/shared/resolve', { path: 'relevés.csv', choice: 'mine', theirs: file.base_hash });
    assert.equal(stale.body.code, 'SHARED_STALE');

    const mine = await api.post('/api/shared/resolve', { path: 'relevés.csv', choice: 'mine', theirs: sent.body.theirs.hash });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.state, 'written');
    assert.equal(read('relevés.csv'), 'a;b\nmoi;1\n');
    const versions = (await api.get(`/api/shared/versions?path=${q('relevés.csv')}`)).body.versions;
    assert.ok(versions.some((v) => v.origin === 'theirs' && v.hash === sent.body.theirs.hash), 'leur version reste dans l’historique');
  });

  test('conflit : « prendre la leur » garde ma version de côté', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    write('notes.md', 'v2 collègue');
    const sent = await push('notes.md', 'v1 moi', file.base_hash);
    const theirs = await api.post('/api/shared/resolve', { path: 'notes.md', choice: 'theirs', theirs: sent.body.theirs.hash });
    assert.equal(theirs.body.state, 'theirs');
    assert.equal(theirs.body.file.base_hash, sha256('v2 collègue'));
    assert.equal(theirs.body.file.state, '');
    assert.equal(read('notes.md'), 'v2 collègue');
    const versions = (await api.get('/api/shared/versions?path=notes.md')).body.versions;
    assert.ok(versions.some((v) => v.origin === 'mine' && v.hash === sha256('v1 moi')), 'ma version n’est pas perdue');
  });

  test('conflit : « garder les deux » crée une copie nommée à côté', async () => {
    write('Équipe/relevés.csv', 'a');
    const file = (await open('Équipe/relevés.csv')).body;
    write('Équipe/relevés.csv', 'b');
    const sent = await push('Équipe/relevés.csv', 'c', file.base_hash);
    await api.put('/api/shared/settings', { display_name: 'T. Grollier' });
    const both = await api.post('/api/shared/resolve', { path: 'Équipe/relevés.csv', choice: 'both', theirs: sent.body.theirs.hash });
    assert.equal(both.status, 200);
    assert.equal(both.body.state, 'copied');
    assert.match(both.body.copyPath, /^Équipe\/relevés \(copie T\. Grollier \d{4}-\d\d-\d\d \d\dh\d\d\)\.csv$/);
    assert.equal(read(both.body.copyPath), 'c');
    assert.equal(read('Équipe/relevés.csv'), 'b');
  });

  test('verrou LibreOffice d’un collègue : envoi en attente, puis parti quand il ferme', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    write('.~lock.notes.md#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/x;');
    const sent = await push('notes.md', 'v1 moi', file.base_hash);
    assert.equal(sent.status, 202);
    assert.equal(sent.body.state, 'pending');
    assert.equal(sent.body.note, 'Ouvert par Hélène Martin dans LibreOffice');
    assert.equal(read('notes.md'), 'v1');
    assert.equal((await api.get('/api/shared/status')).body.pending, 1);

    fs.rmSync(path.join(share, '.~lock.notes.md#'));
    await api.shared.retryPending();
    assert.equal(read('notes.md'), 'v1 moi');
    assert.equal((await api.get('/api/shared/status')).body.pending, 0);
  });

  test('notre propre verrou WorkLogs ne bloque pas notre envoi', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    write('.~lock.notes.md#', formatWorkLogsLock({ displayName: 'Moi', user: 'timo', host: 'pc', instance: 'test-instance', nonce: 'n', date: new Date() }));
    assert.equal((await push('notes.md', 'v2', file.base_hash)).body.state, 'written');
  });

  test('fichier ouvert sous Windows (Word) : en attente avec le nom tiré du `~$`', async () => {
    // Le système de fichiers local ne sait pas refuser une ouverture comme Windows :
    // on injecte la réponse `EBUSY` du worker.
    await api.close();
    const busy = { on: true };
    const real = createSharedIo();
    const faulty = {
      ...real,
      call: (op, args, options) => (op === 'writeGuarded' && busy.on ? Promise.resolve({ result: 'busy', code: 'EBUSY' }) : real.call(op, args, options)),
    };
    api = await startApi({ shared: { root: share, io: faulty } });
    write('Procédure filtration.docx', 'v1');
    write('~$océdure filtration.docx', officeOwnerFile('Jean Dupont'));
    const file = (await open('Procédure filtration.docx')).body;
    assert.equal(file.lock.app, 'word');
    const sent = await push('Procédure filtration.docx', 'v2', file.base_hash);
    assert.equal(sent.status, 202);
    assert.equal(sent.body.note, 'Ouvert par Jean Dupont dans Word');
    busy.on = false;
    fs.rmSync(path.join(share, '~$océdure filtration.docx'));
    await api.shared.retryPending();
    assert.equal(read('Procédure filtration.docx'), 'v2');
  });

  test('pas le droit d’écrire, sans verrou : refus explicite, brouillon gardé', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    await draft('notes.md', { text: 'v2' }, file);
    fs.chmodSync(path.join(share, 'notes.md'), 0o444);
    try {
      if (process.getuid?.() === 0) return; // root écrit partout : test sans objet.
      const sent = await push('notes.md', 'v2', file.base_hash);
      assert.equal(sent.status, 403);
      assert.equal(sent.body.code, 'SHARED_DENIED');
      const reopened = (await open('notes.md')).body;
      assert.deepEqual(reopened.draft.model, { text: 'v2' });
      assert.equal(reopened.send.requested, false);
    } finally {
      fs.chmodSync(path.join(share, 'notes.md'), 0o644);
    }
  });

  test('hors ligne : copie locale, envoi gardé, parti au retour du partage', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    const away = share + '-ailleurs';
    fs.renameSync(share, away);
    try {
      const status = (await api.get('/api/shared/status')).body;
      assert.equal(status.reach, 'unmounted', 'le dossier a disparu');
      const cached = await open('notes.md');
      assert.equal(cached.status, 200);
      assert.equal(cached.body.source, 'cache');
      const listing = await api.get('/api/shared/list');
      assert.equal(listing.status, 503);
      assert.deepEqual(listing.body.entries.map((entry) => entry.name), ['notes.md']);
      const sent = await push('notes.md', 'v2 hors ligne', file.base_hash);
      assert.equal(sent.status, 202);
      assert.equal(sent.body.state, 'offline');
    } finally {
      fs.renameSync(away, share);
    }
    await api.shared.retryPending();
    assert.equal(read('notes.md'), 'v2 hors ligne');
    assert.equal((await api.get('/api/shared/status')).body.pending, 0);
  });

  test('un point de montage vide n’est pas le partage : rien n’y est écrit', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    // Le partage avait été relevé comme montage CIFS ; le dossier répond maintenant en local.
    api.db.prepare("UPDATE local_settings SET value=? WHERE key='shared.fs_type'").run(String(0xff534d42));
    assert.equal((await api.get('/api/shared/status')).body.reach, 'unmounted');
    const sent = await push('notes.md', 'v2', file.base_hash);
    assert.equal(sent.body.state, 'offline');
    assert.equal(read('notes.md'), 'v1');
  });

  test('fichier supprimé sur le partage : conflit « supprimé », « garder ma version » le recrée', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    fs.rmSync(path.join(share, 'notes.md'));
    const sent = await push('notes.md', 'v2', file.base_hash);
    assert.equal(sent.status, 409);
    assert.equal(sent.body.deleted, true);
    const mine = await api.post('/api/shared/resolve', { path: 'notes.md', choice: 'mine', theirs: null });
    assert.equal(mine.body.state, 'written');
    assert.equal(read('notes.md'), 'v2');
  });

  test('abandonner un brouillon le garde dans l’historique', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    await draft('notes.md', { text: 'essai' }, file);
    const res = await fetch(`${api.base}/api/shared/draft/discard?path=notes.md`, { method: 'POST', body: 'essai' });
    const body = await res.json();
    assert.equal(body.draft, null);
    assert.equal(body.state, '');
    const versions = (await api.get('/api/shared/versions?path=notes.md')).body.versions;
    assert.ok(versions.some((v) => v.state === 'archived' && v.hash === sha256('essai')));
  });

  test('sans brouillon, une modification du collègue devient la nouvelle base', async () => {
    write('notes.md', 'v1');
    await open('notes.md');
    write('notes.md', 'v2 collègue, plus long');
    const reopened = (await open('notes.md')).body;
    assert.equal(reopened.base_hash, sha256('v2 collègue, plus long'));
    const listed = (await api.get('/api/shared/list')).body.entries[0];
    assert.equal(listed.local.modified, false, 'déjà relu');
  });

  test('avec un brouillon, la base reste celle d’où il part', async () => {
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    await draft('notes.md', { text: 'v1 moi' }, file);
    write('notes.md', 'v2 collègue, plus long');
    const listed = (await api.get('/api/shared/list')).body.entries[0];
    assert.equal(listed.local.modified, true);
    const reopened = (await open('notes.md')).body;
    assert.equal(reopened.base_hash, sha256('v1'));
    assert.equal(reopened.hash, sha256('v2 collègue, plus long'));
  });

  test('données propres à cet ordinateur : ni exportées, ni effacées par une restauration', async () => {
    const project = await make.project(api, 'Piscine');
    api.db.prepare('INSERT INTO shared_project_folders (project_id, rel_dir, updated_at) VALUES (?,?,?)').run(project.id, 'Piscine', new Date().toISOString());
    write('notes.md', 'v1');
    await open('notes.md');
    const backup = buildBackup(api.db);
    assert.equal(JSON.stringify(backup).includes('shared'), false);
    restoreBackup(api.db, backup);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM shared_files').get().n, 1);
    assert.deepEqual((await api.get('/api/shared/status')).body.projects, { [project.id]: 'Piscine' });
    await api.del(`/api/projects/${project.id}`);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM shared_project_folders').get().n, 0);
  });

  test('une écriture dans le partage ne déclenche pas la synchro Drive', async () => {
    let scheduled = 0;
    api.app.locals.googleSync = { schedule: () => { scheduled++; }, stop() {} };
    write('notes.md', 'v1');
    const file = (await open('notes.md')).body;
    await draft('notes.md', { text: 'v2' }, file);
    await push('notes.md', 'v2', file.base_hash);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduled, 0);
    await make.entry(api);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduled, 1, 'une entrée, elle, déclenche la synchro');
  });

  test('rétention : 30 versions par fichier, la base toujours gardée', async () => {
    for (let i = 0; i < 35; i++) {
      write('notes.md', `version ${i}`);
      fs.utimesSync(path.join(share, 'notes.md'), new Date(), new Date(Date.now() + i * 1000));
      await open('notes.md');
    }
    const versions = (await api.get('/api/shared/versions?path=notes.md')).body.versions;
    assert.equal(versions.length, 30);
    assert.equal(versions[0].hash, sha256('version 34'));
    const blobs = fs.readdirSync(path.join(api.dir, 'shared-blobs')).flatMap((dir) => fs.readdirSync(path.join(api.dir, 'shared-blobs', dir)));
    assert.equal(blobs.length, 30, 'les octets des versions effacées partent aussi');
  });
});
