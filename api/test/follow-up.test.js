import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { make, startApi } from './helpers.js';
import { openDb } from '../src/db.js';
import { buildBackup, restoreBackup } from '../src/backup.js';
import { followUpKey, mergeFollowUp, readFollowUp } from '../src/follow-up.js';

const REPORT = {
  status: 'blocked', summary: 'Le devis est prêt ; la signature reste attendue.',
  completed: ['Devis préparé'], next_steps: ['Obtenir la signature'],
  blockers: ['Signature attendue'], warnings: [],
};

describe('suivi IA enregistré', () => {
  let api;
  before(async () => { api = await startApi(); });
  after(() => api.close());
  beforeEach(() => api.db.exec('DELETE FROM task_entries; DELETE FROM google_documents; DELETE FROM tasks; DELETE FROM entries; DELETE FROM categories; DELETE FROM projects;'));

  const snapshot = async (kind, id) => (await api.get(`/api/follow-up/${kind}/${id}`)).body;
  const report = async (kind, id, draft = REPORT) => {
    const source = await snapshot(kind, id);
    return api.put(`/api/follow-up/${kind}/${id}`, { report: draft, source_key: source.source_key });
  };

  test('lit seulement la note ou les documents explicitement liés, y compris leur copie riche locale', async () => {
    const project = await make.project(api, 'Rénovation');
    const rich = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Devis validé' }] }] };
    const note = await make.entry(api, { title: 'Avancées', content_md: 'Texte daté', project_id: project.id });
    const local = await make.entry(api, { title: 'Copie Google', content_json: rich });
    await make.entry(api, { title: 'Secret sans lien', content_md: 'Ne doit jamais être une source' });
    api.db.prepare('INSERT INTO google_documents (entry_id,document_id,revision_id,synced_content_json) VALUES (?,?,?,?)')
      .run(local.id, 'document-google', 'r1', JSON.stringify(rich));
    const task = await make.task(api, { title: 'Signer', project_id: project.id });
    await api.post(`/api/tasks/${task.id}/documents/${note.id}`);
    await api.post(`/api/tasks/${task.id}/documents/${local.id}`);
    const before = (await api.get(`/api/entries/${note.id}`)).body.updated_at;

    const entrySource = await snapshot('entry', note.id);
    assert.equal(entrySource.follow_up, null);
    assert.equal(entrySource.source.project, 'Rénovation');
    assert.equal(entrySource.source.documents[0].content_md, 'Texte daté');
    assert.equal(entrySource.source.documents.length, 1);
    assert.equal((await api.get(`/api/entries/${note.id}`)).body.updated_at, before, 'la préparation ne modifie rien');

    const taskSource = await snapshot('task', task.id);
    assert.deepEqual(taskSource.source.documents.map((entry) => entry.id).sort(), [note.id, local.id].sort());
    assert.deepEqual(taskSource.source.documents.find((entry) => entry.id === local.id).content_json, rich);
    assert.equal(taskSource.source.documents.find((entry) => entry.id === local.id).google, true);
    assert.equal(JSON.stringify(taskSource).includes('Ne doit jamais être une source'), false);
  });

  test('conserve le bilan dans le détail et l’état global sans modifier le texte, le statut ni les archives', async () => {
    const note = await make.entry(api, { content_md: '- [x] Devis préparé\nSignature attendue' });
    const task = await make.task(api, { title: 'Signer' });
    await api.post(`/api/tasks/${task.id}/documents/${note.id}`);
    const beforeEntry = (await api.get(`/api/entries/${note.id}`)).body.updated_at;
    const beforeTask = api.db.prepare('SELECT updated_at FROM tasks WHERE id=?').get(task.id).updated_at;
    const configured = await api.put(`/api/follow-up/entry/${note.id}`, { enabled: true });
    const saved = await report('entry', note.id);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.follow_up.enabled, true);
    assert.equal(saved.body.follow_up.enabled_at, configured.body.follow_up.enabled_at, 'un bilan ne rajeunit pas le choix de suivi');
    assert.ok(Number.isFinite(Date.parse(saved.body.follow_up.report.generated_at)));
    assert.equal(saved.body.follow_up.report.source_key, saved.body.source_key);

    const taskSaved = await report('task', task.id, { ...REPORT, status: 'done' });
    assert.equal(taskSaved.status, 200);
    const detail = (await api.get(`/api/entries/${note.id}`)).body;
    const state = (await api.get('/api/state')).body;
    assert.deepEqual(detail.follow_up, saved.body.follow_up);
    assert.deepEqual(state.entries.find((entry) => entry.id === note.id).follow_up, saved.body.follow_up);
    assert.equal(state.tasks.find((item) => item.id === task.id).follow_up.report.status, 'done');
    assert.equal(state.tasks.find((item) => item.id === task.id).status, 'todo');
    assert.equal(detail.archived, 0);
    assert.equal(detail.content_md, note.content_md);
    assert.equal(detail.updated_at, beforeEntry, 'configuration et bilan ont leurs propres horloges');
    assert.equal(state.tasks.find((item) => item.id === task.id).updated_at, beforeTask);
    const copy = (await api.post(`/api/entries/${note.id}/copy`)).body;
    assert.equal(copy.follow_up, null, 'une nouvelle copie n’active pas les envois automatiques');
  });

  test('modifier un bilan, l’épingle ou la date technique ne le rend pas obsolète ; modifier les sources le rend obsolète', async () => {
    const project = await make.project(api, 'Chantier');
    const note = await make.entry(api, { title: 'Journal', content_md: 'Devis préparé', project_id: project.id });
    const task = await make.task(api, { title: 'Signer', project_id: project.id });
    await api.post(`/api/tasks/${task.id}/documents/${note.id}`);
    const original = await snapshot('task', task.id);
    await api.put(`/api/follow-up/task/${task.id}`, { enabled: true });
    await report('task', task.id);
    await api.put(`/api/tasks/${task.id}`, { pinned: 1, priority: 'high' });
    assert.equal((await snapshot('task', task.id)).source_key, original.source_key);
    await api.put(`/api/follow-up/task/${task.id}`, { enabled: false });
    assert.equal((await snapshot('task', task.id)).source_key, original.source_key);
    assert.equal((await snapshot('task', task.id)).follow_up.report.summary, REPORT.summary);

    await api.put(`/api/entries/${note.id}`, { content_md: 'Devis préparé\nSignature obtenue' });
    const changed = await snapshot('task', task.id);
    assert.notEqual(changed.source_key, original.source_key);
    const stale = await api.put(`/api/follow-up/task/${task.id}`, { report: REPORT, source_key: original.source_key });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'FOLLOW_UP_STALE');
    assert.equal((await snapshot('task', task.id)).follow_up.report.source_key, original.source_key, 'l’ancien bilan reste disponible');
    const state = (await api.get('/api/state')).body;
    assert.equal(state.tasks.find((item) => item.id === task.id).follow_up_key, changed.source_key);

    await api.put(`/api/projects/${project.id}`, { name: 'Nouveau chantier' });
    assert.notEqual((await snapshot('task', task.id)).source_key, changed.source_key);
  });

  test('lier, délier un document ou renommer la tâche invalide son suivi ; statut et échéance restent lus sans l’invalider', async () => {
    const task = await make.task(api);
    const note = await make.entry(api, { content_md: 'Avancement' });
    const initial = await snapshot('task', task.id);
    await api.post(`/api/tasks/${task.id}/documents/${note.id}`);
    const linked = await snapshot('task', task.id);
    assert.notEqual(linked.source_key, initial.source_key);
    await api.put(`/api/tasks/${task.id}`, { status: 'doing', due_date: '2026-12-01' });
    await api.patch(`/api/tasks/${task.id}/move`, { status: 'done', position: 0 });
    const closed = await snapshot('task', task.id);
    assert.equal(closed.source_key, linked.source_key);
    assert.equal(closed.source.status, 'done');
    assert.equal(closed.source.due_date, '2026-12-01');
    await api.put(`/api/tasks/${task.id}`, { title: 'Nouveau titre' });
    assert.notEqual((await snapshot('task', task.id)).source_key, linked.source_key);
    await api.del(`/api/tasks/${task.id}/documents/${note.id}`);
    assert.equal((await snapshot('task', task.id)).source.documents.length, 0);
  });

  test('distingue une procédure d’une note et invalide les bilans quand le type de leur source change', async () => {
    const note = await make.entry(api, { content_md: 'Vérifier la signature obtenue' });
    const task = await make.task(api, { title: 'Signer' });
    await api.post(`/api/tasks/${task.id}/documents/${note.id}`);
    const entryBefore = await snapshot('entry', note.id);
    const taskBefore = await snapshot('task', task.id);
    assert.equal(entryBefore.source.documents[0].kind, 'note');
    assert.equal(taskBefore.source.documents[0].kind, 'note');

    await api.put(`/api/entries/${note.id}`, { kind: 'procedure' });
    const entryAfter = await snapshot('entry', note.id);
    const taskAfter = await snapshot('task', task.id);
    assert.equal(entryAfter.source.documents[0].kind, 'procedure');
    assert.equal(taskAfter.source.documents[0].kind, 'procedure');
    assert.notEqual(entryAfter.source_key, entryBefore.source_key);
    assert.notEqual(taskAfter.source_key, taskBefore.source_key);
  });

  test('refuse les suivis mal formés, les réponses trop grandes et les références absentes', async () => {
    const note = await make.entry(api);
    const url = `/api/follow-up/entry/${note.id}`;
    for (const body of [{}, { enabled: 'oui' }, { report: { ...REPORT, status: 'urgent' } },
      { report: { ...REPORT, summary: 'a'.repeat(1501) } }, { report: { ...REPORT, completed: Array(9).fill('Fait') } },
      { report: { ...REPORT, blockers: ['a'.repeat(501)] } }, { report: { ...REPORT, warnings: Array(13).fill('Attention') } },
      { report: null }, { enabled: true, report: null }]) {
      const response = await api.put(url, body);
      assert.equal(response.status, 400);
      assert.equal(typeof response.body.error, 'string');
    }
    assert.equal((await api.get('/api/follow-up/task/inconnue')).status, 404);
    assert.equal((await api.put('/api/follow-up/entry/inconnue', { enabled: true })).status, 404);
    assert.equal((await api.get(`/api/follow-up/project/${note.id}`)).status, 400);
    assert.equal((await snapshot('entry', note.id)).follow_up, null);
  });

  test('« Désactiver » coupe l’automatisme et retire le bilan sans toucher au texte ; le suivi peut repartir', async () => {
    const note = await make.entry(api, { content_md: 'Rien à suivre ici.' });
    const before = (await api.get(`/api/entries/${note.id}`)).body;
    await api.put(`/api/follow-up/entry/${note.id}`, { enabled: true });
    await report('entry', note.id);
    // Décocher l'automatisme n'est pas désactiver : le bilan reste, aucune date de retrait.
    const paused = await api.put(`/api/follow-up/entry/${note.id}`, { enabled: false });
    assert.equal(paused.body.follow_up.report.summary, REPORT.summary);
    assert.equal(paused.body.follow_up.cleared_at, undefined);
    const off = await api.put(`/api/follow-up/entry/${note.id}`, { enabled: false, report: null });
    assert.equal(off.status, 200);
    assert.equal(off.body.follow_up.enabled, false);
    assert.equal(off.body.follow_up.report, null);
    assert.equal(off.body.follow_up.cleared_at, off.body.follow_up.enabled_at);
    const state = (await api.get('/api/state')).body;
    assert.deepEqual(state.entries.find((entry) => entry.id === note.id).follow_up, off.body.follow_up);
    const after = (await api.get(`/api/entries/${note.id}`)).body;
    assert.equal(after.content_md, before.content_md);
    assert.equal(after.updated_at, before.updated_at);
    const again = await api.put(`/api/follow-up/entry/${note.id}`, { enabled: true });
    assert.deepEqual([again.body.follow_up.enabled, again.body.follow_up.report], [true, null]);
    assert.equal(again.body.follow_up.cleared_at, off.body.follow_up.cleared_at);
  });

  test('les sauvegardes conservent les suivis et les anciennes versions restent importables', async () => {
    const note = await make.entry(api, { content_md: 'Devis préparé' });
    const task = await make.task(api);
    await api.put(`/api/follow-up/entry/${note.id}`, { enabled: true });
    await report('entry', note.id);
    await report('task', task.id);
    const backup = buildBackup(api.db);
    assert.equal(typeof backup.entries[0].follow_up, 'object');
    assert.equal(typeof backup.tasks[0].follow_up, 'object');
    restoreBackup(api.db, backup);
    assert.deepEqual((await snapshot('entry', note.id)).follow_up, backup.entries[0].follow_up);
    assert.deepEqual((await snapshot('task', task.id)).follow_up, backup.tasks[0].follow_up);

    const invalid = structuredClone(backup);
    invalid.entries[0].follow_up.report.status = 'inventé';
    assert.throws(() => restoreBackup(api.db, invalid), /suivi IA invalide/);
    assert.equal((await snapshot('entry', note.id)).follow_up.report.summary, REPORT.summary);

    for (const row of [...backup.entries, ...backup.tasks]) delete row.follow_up;
    restoreBackup(api.db, backup);
    assert.equal((await snapshot('entry', note.id)).follow_up, null);
    assert.equal((await snapshot('task', task.id)).follow_up, null);
  });
});

test('empreinte du suivi : celle d’une entrée n’a pas bougé, ses bilans restent à jour', () => {
  const entry = { kind: 'entry', id: 'en_1', title: 'Journal', project: 'Chantier', documents: [{ id: 'en_1', title: 'Journal', kind: 'note', content_md: 'Devis prêt', content_json: null, entry_date: '2026-11-01', google: false }] };
  assert.equal(followUpKey(entry), 'fu_24f76b4dfead8769', 'valeur d’avant le retrait du statut et de l’échéance');
});

test('fusion indépendante du suivi : choix et bilan gardent leur horloge et les égalités sont déterministes', () => {
  const early = '2026-11-02T10:00:00.000Z';
  const late = '2026-11-02T10:02:00.000Z';
  const report = (summary, generated_at) => ({ ...REPORT, summary, generated_at, source_key: 'fu_test' });
  const local = { enabled: false, enabled_at: late, report: report('Ancien bilan', early) };
  const remote = { enabled: true, enabled_at: early, report: report('Nouveau bilan', late) };
  const expected = { enabled: false, enabled_at: late, report: remote.report };
  assert.deepEqual(mergeFollowUp(local, remote), expected);
  assert.deepEqual(mergeFollowUp(remote, local), expected);
  assert.deepEqual(mergeFollowUp(local, null), local);
  assert.deepEqual(readFollowUp({ enabled: true, report: null }), {
    enabled: true, enabled_at: '1970-01-01T00:00:00.000Z', report: null,
  });
  assert.equal(readFollowUp({ enabled: true, report: remote.report }).enabled_at, late);

  const tied = { ...remote, enabled_at: late, report: report('Z bilan au même instant', early) };
  const forward = mergeFollowUp(local, tied);
  assert.equal(forward.enabled, false, 'désactiver gagne si le choix tombe au même instant');
  assert.equal(forward.report.summary, tied.report.summary, 'les rapports égaux sont départagés par leur JSON canonique');
  assert.deepEqual(forward, mergeFollowUp(tied, local));
  assert.equal(local.report.summary, 'Ancien bilan', 'la fusion ne modifie pas ses entrées');

  // « Désactiver » sur un appareil : le bilan plus ancien de l'autre copie ne revient pas.
  const later = '2026-11-02T10:05:00.000Z';
  const cleared = { enabled: false, enabled_at: later, report: null, cleared_at: later };
  assert.deepEqual(mergeFollowUp(cleared, remote), cleared);
  assert.deepEqual(mergeFollowUp(remote, cleared), cleared);
  // Un bilan calculé après le retrait reste.
  const fresher = { enabled: true, enabled_at: early, report: report('Bilan postérieur', '2026-11-02T10:06:00.000Z') };
  assert.equal(mergeFollowUp(cleared, fresher).report.summary, 'Bilan postérieur');
  // Réactivé ailleurs avant d'apprendre le retrait : l'automatisme repart, l'ancien bilan reste retiré.
  const reactivated = { enabled: true, enabled_at: '2026-11-02T10:07:00.000Z', report: remote.report };
  const expectedBack = { enabled: true, enabled_at: reactivated.enabled_at, report: null, cleared_at: later };
  assert.deepEqual(mergeFollowUp(cleared, reactivated), expectedBack);
  assert.deepEqual(mergeFollowUp(reactivated, cleared), expectedBack);
  // Une simple pause avant le premier bilan n'est pas un retrait : le bilan de l'autre copie reste.
  const paused = { enabled: false, enabled_at: later, report: null };
  assert.equal(mergeFollowUp(paused, remote).report.summary, 'Nouveau bilan');
  assert.deepEqual(mergeFollowUp(paused, remote), mergeFollowUp(remote, paused));
  assert.equal(readFollowUp(JSON.stringify(cleared)).cleared_at, later);
});

test('migration additive des suivis : conserve textes, liens et intégrité d’une base antérieure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-follow-up-migration-'));
  const file = path.join(dir, 'worklogs.db');
  let db = openDb(file, { withSeed: true });
  try {
    const entry = db.prepare('SELECT * FROM entries LIMIT 1').get();
    const task = db.prepare('SELECT * FROM tasks LIMIT 1').get();
    db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run(task.id, entry.id, entry.created_at);
    db.exec('ALTER TABLE entries DROP COLUMN follow_up; ALTER TABLE tasks DROP COLUMN follow_up;');
    db.close();
    db = openDb(file, { withSeed: false });
    assert.equal(db.prepare('SELECT content_md FROM entries WHERE id=?').get(entry.id).content_md, entry.content_md);
    assert.equal(db.prepare('SELECT follow_up FROM entries WHERE id=?').get(entry.id).follow_up, null);
    assert.equal(db.prepare('SELECT follow_up FROM tasks WHERE id=?').get(task.id).follow_up, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM task_entries').get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
