import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApi, make } from './helpers.js';
import { openDb } from '../src/db.js';
import { taskMergeSourceKey } from '../src/entry-merge.js';

/** Titres d'une colonne, dans l'ordre d'affichage. */
async function column(api, status) {
  const { body } = await api.get('/api/state');
  return body.tasks.filter((t) => t.status === status).map((t) => t.title);
}

describe('tâches', () => {
  let api;
  before(async () => { api = await startApi(); });
  after(() => api.close());
  beforeEach(() => api.db.exec('DELETE FROM task_entries; DELETE FROM google_documents; DELETE FROM tasks; DELETE FROM entries; DELETE FROM projects;'));

  test('crée une tâche en « à faire » par défaut', async () => {
    const res = await api.post('/api/tasks', { title: '  Rappeler le client  ' });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Rappeler le client');
    assert.equal(res.body.status, 'todo');
    assert.equal(res.body.pinned, 0);
    assert.equal(res.body.due_date, null);
    assert.equal(res.body.position, 0);
  });

  test('refuse un titre vide et un statut inconnu', async () => {
    assert.equal((await api.post('/api/tasks', { title: ' ' })).body.error, 'titre requis');
    const res = await api.post('/api/tasks', { title: 'x', status: 'in_progress' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'statut invalide');
  });

  test('empile les positions dans la colonne de création', async () => {
    await make.task(api, { title: 'A' });
    await make.task(api, { title: 'B' });
    await make.task(api, { title: 'C', status: 'doing' });

    assert.deepEqual(await column(api, 'todo'), ['A', 'B']);
    assert.deepEqual(await column(api, 'doing'), ['C']);
  });

  test('déplace une carte vers une autre colonne', async () => {
    const task = await make.task(api, { title: 'A' });
    const res = await api.patch(`/api/tasks/${task.id}/move`, { status: 'done', position: 0 });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'done');
    assert.deepEqual(await column(api, 'todo'), []);
    assert.deepEqual(await column(api, 'done'), ['A']);
  });

  test('termine une tâche et archive ses documents sans supprimer le contexte', async () => {
    const local = await make.entry(api, { title: 'Compte rendu local' });
    const google = await make.entry(api, { title: 'Onglet Google' });
    api.db.prepare(`INSERT INTO google_documents
      (entry_id,document_id,tab_id,revision_id,synced_content_json,document_title,tab_title)
      VALUES (?,?,?,?,?,?,?)`).run(google.id, 'google-doc', 'tab-1', 'r1', '{}', 'Dossier', 'Onglet');
    const task = await make.task(api, { title: 'Terminer le dossier' });
    await api.post(`/api/tasks/${task.id}/documents/${local.id}`);
    await api.post(`/api/tasks/${task.id}/documents/${google.id}`);

    const completed = await api.put(`/api/tasks/${task.id}`, { status: 'done' });
    assert.equal(completed.body.status, 'done');
    assert.equal(api.db.prepare('SELECT archived FROM entries WHERE id=?').get(local.id).archived, 1);
    assert.equal(api.db.prepare('SELECT archived FROM entries WHERE id=?').get(google.id).archived, 1);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM task_entries WHERE task_id=?').get(task.id).n, 2);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM google_documents WHERE entry_id=?').get(google.id).n, 1);

    const state = await api.get('/api/state');
    assert.equal(state.body.entries.find((entry) => entry.id === local.id).archived, 1);
    assert.equal(state.body.tasks.find((item) => item.id === task.id).documents.length, 2);

    // Rouvrir la tâche ne ressuscite pas une archive explicite/automatique.
    await api.put(`/api/tasks/${task.id}`, { status: 'todo' });
    assert.equal(api.db.prepare('SELECT archived FROM entries WHERE id=?').get(local.id).archived, 1);
  });

  test('le déplacement kanban vers Terminé archive aussi les documents liés', async () => {
    const entry = await make.entry(api, { title: 'Plan à livrer' });
    const task = await make.task(api, { title: 'Livrer' });
    await api.post(`/api/tasks/${task.id}/documents/${entry.id}`);

    const moved = await api.patch(`/api/tasks/${task.id}/move`, { status: 'done', position: 0 });
    assert.equal(moved.body.status, 'done');
    assert.equal(api.db.prepare('SELECT archived FROM entries WHERE id=?').get(entry.id).archived, 1);
  });

  test('un document lié après coup à une tâche déjà terminée est archivé', async () => {
    const entry = await make.entry(api, { title: 'Document tardif' });
    const task = await make.task(api, { title: 'Déjà terminé', status: 'done' });

    await api.post(`/api/tasks/${task.id}/documents/${entry.id}`);
    assert.equal(api.db.prepare('SELECT archived FROM entries WHERE id=?').get(entry.id).archived, 1);
  });

  test('insère à la bonne place et renumérote sans trou', async () => {
    await make.task(api, { title: 'A' });
    await make.task(api, { title: 'B' });
    const c = await make.task(api, { title: 'C' });

    await api.patch(`/api/tasks/${c.id}/move`, { status: 'todo', position: 0 });
    assert.deepEqual(await column(api, 'todo'), ['C', 'A', 'B']);

    const { body } = await api.get('/api/state');
    assert.deepEqual(
      body.tasks.map((t) => t.position),
      [0, 1, 2],
      'positions contiguës après déplacement'
    );
  });

  test('renumérote la colonne d’origine après un départ', async () => {
    const a = await make.task(api, { title: 'A' });
    await make.task(api, { title: 'B' });
    await make.task(api, { title: 'C' });

    await api.patch(`/api/tasks/${a.id}/move`, { status: 'doing', position: 0 });

    const { body } = await api.get('/api/state');
    const todo = body.tasks.filter((t) => t.status === 'todo');
    assert.deepEqual(todo.map((t) => t.position), [0, 1]);
  });

  test('renumérote aussi après une suppression', async () => {
    const a = await make.task(api, { title: 'A' });
    await make.task(api, { title: 'B' });
    await make.task(api, { title: 'C' });

    await api.del(`/api/tasks/${a.id}`);

    const { body } = await api.get('/api/state');
    assert.deepEqual(body.tasks.map((t) => [t.title, t.position]), [['B', 0], ['C', 1]]);
  });

  test('refuse un déplacement vers un statut invalide', async () => {
    const task = await make.task(api);
    const res = await api.patch(`/api/tasks/${task.id}/move`, { status: 'archived', position: 0 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'statut invalide');
  });

  test('bascule l’épinglage et l’échéance', async () => {
    const task = await make.task(api);

    let res = await api.put(`/api/tasks/${task.id}`, { pinned: true, due_date: '2026-03-01' });
    assert.equal(res.body.pinned, 1);
    assert.equal(res.body.due_date, '2026-03-01');

    res = await api.put(`/api/tasks/${task.id}`, { pinned: false, due_date: '' });
    assert.equal(res.body.pinned, 0);
    assert.equal(res.body.due_date, null);
  });

  test('priorité normale par défaut, basse ou haute sur demande', async () => {
    const defaut = await make.task(api, { title: 'Sans priorité' });
    assert.equal(defaut.priority, 'normal');

    const haute = await make.task(api, { title: 'Urgent', priority: 'high' });
    assert.equal(haute.priority, 'high');
    const basse = await make.task(api, { title: 'Plus tard', priority: 'low' });
    assert.equal(basse.priority, 'low');
    // `""` et l'absence valent « normale », comme les autres champs par défaut.
    assert.equal((await make.task(api, { title: 'Vide', priority: '' })).priority, 'normal');
  });

  test('refuse une priorité inconnue sans rien créer', async () => {
    const res = await api.post('/api/tasks', { title: 'Douteuse', priority: 'urgent' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'priorité invalide (basse, normale ou haute attendue)');
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 0);
  });

  test('modifie la priorité sans toucher au reste', async () => {
    const task = await make.task(api, { title: 'À trier', due_date: '2026-04-01', pinned: true });

    let res = await api.put(`/api/tasks/${task.id}`, { priority: 'high' });
    assert.equal(res.body.priority, 'high');
    assert.equal(res.body.title, 'À trier');
    assert.equal(res.body.due_date, '2026-04-01');
    assert.equal(res.body.pinned, 1);

    res = await api.put(`/api/tasks/${task.id}`, { title: 'Autre nom' });
    assert.equal(res.body.priority, 'high', 'non fournie = non écrasée');

    assert.equal((await api.put(`/api/tasks/${task.id}`, { priority: 'minimum' })).status, 400);
    assert.equal(api.db.prepare('SELECT priority FROM tasks WHERE id=?').get(task.id).priority, 'high');
  });

  test('une base antérieure sans colonne reçoit « normale » sans perdre ses tâches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-priority-migration-'));
    const file = path.join(dir, 'old.db');
    const initial = openDb(file, { withSeed: false });
    initial.exec(`DROP TABLE tasks;
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
        due_date TEXT, pinned INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO tasks (id,title,status,position,created_at,updated_at) VALUES ('tk_old','Ancienne','doing',0,'','');`);
    initial.close();
    const migrated = openDb(file, { withSeed: false });
    try {
      const row = migrated.prepare('SELECT * FROM tasks WHERE id=?').get('tk_old');
      assert.equal(row.priority, 'normal');
      assert.equal(row.title, 'Ancienne');
      assert.equal(row.status, 'doing');
      assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      migrated.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('conserve les champs non fournis lors d’une mise à jour', async () => {
    const task = await make.task(api, { title: 'A', due_date: '2026-03-01', pinned: true });
    const res = await api.put(`/api/tasks/${task.id}`, { status: 'done' });
    assert.equal(res.body.title, 'A');
    assert.equal(res.body.due_date, '2026-03-01');
    assert.equal(res.body.pinned, 1);
    assert.equal(res.body.status, 'done');
  });

  test('crée une tâche liée depuis une entrée en recopiant son projet et son contexte', async () => {
    const project = await make.project(api, 'Planning');
    const entry = await make.entry(api, { title: 'Préparer le comité', project_id: project.id });
    const created = await api.post(`/api/entries/${entry.id}/task`, { due_date: '2026-09-20' });
    assert.equal(created.status, 201);
    assert.equal(created.body.title, 'Préparer le comité');
    assert.equal(created.body.project_id, project.id);
    assert.equal(created.body.due_date, '2026-09-20');
    assert.equal(created.body.priority, 'normal');
    assert.deepEqual(created.body.documents.map((document) => document.id), [entry.id]);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM task_entries WHERE task_id=? AND entry_id=?').get(created.body.id, entry.id).n, 1);
  });

  test('crée une tâche liée avec sa priorité et refuse une priorité invalide sans écriture', async () => {
    const entry = await make.entry(api, { title: 'Maintenance' });
    for (const priority of ['high', 'low']) {
      const result = await api.post(`/api/entries/${entry.id}/task`, { title: `Tâche ${priority}`, priority });
      assert.equal(result.status, 201);
      assert.equal(result.body.priority, priority);
      assert.deepEqual(result.body.documents.map((document) => document.id), [entry.id]);
      assert.equal(api.db.prepare('SELECT priority FROM tasks WHERE id=?').get(result.body.id).priority, priority);
    }
    const counts = () => [api.db.prepare('SELECT count(*) n FROM tasks').get().n, api.db.prepare('SELECT count(*) n FROM task_entries').get().n];
    const before = counts();
    const invalid = await api.post(`/api/entries/${entry.id}/task`, { title: 'Invalide', priority: 'urgente' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'priorité invalide (basse, normale ou haute attendue)');
    assert.deepEqual(counts(), before);
  });

  test('crée une tâche liée directement dans la colonne demandée et refuse un statut invalide', async () => {
    const entry = await make.entry(api, { title: 'Intervention urgente' });
    const created = await api.post(`/api/entries/${entry.id}/task`, {
      title: 'Purger la pompe',
      status: 'doing',
      due_date: '2026-11-02',
      priority: 'high',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'doing');
    assert.equal(created.body.position, 0);
    assert.equal(created.body.priority, 'high');
    assert.equal(created.body.due_date, '2026-11-02');
    const invalid = await api.post(`/api/entries/${entry.id}/task`, { title: 'Mauvais statut', status: 'in_progress' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'statut invalide');
    assert.equal(api.db.prepare("SELECT COUNT(*) n FROM tasks WHERE title='Mauvais statut'").get().n, 0);
  });

  test('crée une tâche liée depuis un onglet Google et valide son échéance', async () => {
    const entry = await make.entry(api, { title: 'Onglet à planifier' });
    api.db.prepare(`INSERT INTO google_documents
      (entry_id, document_id, tab_id, revision_id, synced_content_json, document_title, tab_title)
      VALUES (?,?,?,?,?,?,?)`).run(entry.id, 'google-doc', 'tab-1', 'r1', '{"type":"doc","content":[{"type":"paragraph"}]}', 'Dossier', 'Onglet');
    const created = await api.post(`/api/entries/${entry.id}/task`, {});
    assert.equal(created.status, 201);
    assert.equal(created.body.documents[0].google_document_id, 'google-doc');
    assert.equal((await api.post(`/api/entries/${entry.id}/task`, { due_date: '20-09-2026' })).body.error, 'échéance invalide (AAAA-MM-JJ attendu)');
  });

  test('refuse la création liée depuis une entrée inconnue et ne crée rien pour un titre vide', async () => {
    assert.equal((await api.post('/api/entries/en_nope/task', {})).status, 404);
    const entry = await make.entry(api);
    assert.equal((await api.post(`/api/entries/${entry.id}/task`, { title: ' ' })).status, 400);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 0);
  });

  test('crée une entrée liée depuis une tâche en recopiant son projet, datée du jour', async () => {
    const project = await make.project(api, 'Chantier');
    const task = await make.task(api, { title: 'Préparer le dossier', project_id: project.id });
    const created = await api.post(`/api/tasks/${task.id}/entry`, { content_md: '## Sous-tâches\n- [ ] Relire\n' });
    assert.equal(created.status, 201);
    assert.equal(created.body.title, 'Préparer le dossier');
    assert.equal(created.body.project_id, project.id);
    assert.equal(created.body.entry_date, new Date().toISOString().slice(0, 10));
    assert.equal(created.body.content_md, '## Sous-tâches\n- [ ] Relire\n');
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM task_entries WHERE task_id=? AND entry_id=?').get(task.id, created.body.id).n, 1);
  });

  test('refuse la création liée depuis une tâche inconnue et ne crée rien pour un titre vide', async () => {
    assert.equal((await api.post('/api/tasks/tk_nope/entry', {})).status, 404);
    const task = await make.task(api);
    assert.equal((await api.post(`/api/tasks/${task.id}/entry`, { title: ' ' })).status, 400);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 0);
  });

  test('associe des entrées locales et Google, même hors du projet de la tâche', async () => {
    const taskProject = await make.project(api, 'Projet tâche');
    const documentProject = await make.project(api, 'Projet documents');
    const local = await make.entry(api, { title: 'Compte rendu local', project_id: documentProject.id });
    const google = await make.entry(api, { title: 'Onglet Google', project_id: documentProject.id });
    api.db.prepare(`INSERT INTO google_documents
      (entry_id, document_id, tab_id, revision_id, synced_content_json, document_title, tab_title)
      VALUES (?,?,?,?,?,?,?)`).run(google.id, 'google-doc', 'tab-1', 'r1', '{}', 'Document Google', 'Onglet 1');
    const task = await make.task(api, { project_id: taskProject.id });

    let res = await api.post(`/api/tasks/${task.id}/documents/${local.id}`);
    assert.equal(res.status, 201);
    assert.equal(res.body.task_id, task.id);
    assert.equal(res.body.entry_id, local.id);
    const firstCreatedAt = res.body.created_at;

    res = await api.post(`/api/tasks/${task.id}/documents/${google.id}`);
    assert.equal(res.status, 201);
    assert.equal((await api.post(`/api/tasks/${task.id}/documents/${local.id}`)).status, 200);
    assert.equal((await api.post(`/api/tasks/${task.id}/documents/${local.id}`)).body.created_at, firstCreatedAt);

    const state = await api.get(`/api/state?project_id=${taskProject.id}`);
    assert.equal(state.status, 200);
    assert.equal(state.body.tasks.length, 1);
    assert.deepEqual(state.body.tasks[0].documents.map((document) => document.id).sort(), [local.id, google.id].sort());
    const googleSummary = state.body.tasks[0].documents.find((document) => document.id === google.id);
    assert.deepEqual(googleSummary, {
      id: google.id,
      title: 'Onglet Google',
      entry_date: google.entry_date,
      project_id: documentProject.id,
      category_id: null,
      archived: 0,
      status: 'todo',
      updated_at: google.updated_at,
      google_document_id: 'google-doc',
      google_tab_id: 'tab-1',
      google_document_title: 'Document Google',
      google_tab_title: 'Onglet 1',
    });
  });

  test('refuse les associations vers une tâche ou une entrée inconnue', async () => {
    const entry = await make.entry(api);
    const task = await make.task(api);
    assert.equal((await api.post(`/api/tasks/tk_nope/documents/${entry.id}`)).status, 404);
    assert.equal((await api.post(`/api/tasks/${task.id}/documents/en_nope`)).status, 404);
    assert.equal((await api.del(`/api/tasks/tk_nope/documents/${entry.id}`)).status, 404);
    assert.equal((await api.del(`/api/tasks/${task.id}/documents/en_nope`)).status, 404);
  });

  test('retire une association et refuse son second retrait', async () => {
    const entry = await make.entry(api);
    const task = await make.task(api);
    await api.post(`/api/tasks/${task.id}/documents/${entry.id}`);

    const removed = await api.del(`/api/tasks/${task.id}/documents/${entry.id}`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { ok: true });
    assert.equal((await api.del(`/api/tasks/${task.id}/documents/${entry.id}`)).status, 404);
  });

  test('supprimer une tâche supprime ses associations', async () => {
    const entry = await make.entry(api);
    const task = await make.task(api);
    await api.post(`/api/tasks/${task.id}/documents/${entry.id}`);

    assert.equal((await api.del(`/api/tasks/${task.id}`)).status, 200);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM task_entries WHERE task_id=?').get(task.id).n, 0);
  });

  describe('fusion de tâches', () => {
    /** Demande telle que l'écran la construit : tâches de l'état, documents relus un à un. */
    const mergeRequest = async (ids, patch = {}) => {
      const { tasks } = (await api.get('/api/state')).body;
      const sources = await Promise.all(ids.map(async (id) => {
        const task = tasks.find((candidate) => candidate.id === id);
        const documents = await Promise.all(task.documents.map(async (document) => (await api.get(`/api/entries/${document.id}`)).body));
        return { id, source_key: taskMergeSourceKey(task, documents) };
      }));
      return { request_id: crypto.randomUUID(), sources, title: 'Tâche commune', content_md: 'Note commune', ...patch };
    };
    const stateTask = async (id) => (await api.get('/api/state')).body.tasks.find((task) => task.id === id);
    const link = (taskId, entryId) => api.post(`/api/tasks/${taskId}/documents/${entryId}`);

    test('une tâche et une note remplacent les sources ; pièces jointes, Google et procédures suivent', async () => {
      const project = await make.project(api, 'Atelier');
      const a = await make.task(api, { title: 'A', project_id: project.id, priority: 'low', due_date: '2026-12-10' });
      const b = await make.task(api, { title: 'B', project_id: project.id, priority: 'high', due_date: '2026-12-05', pinned: true });
      await api.patch(`/api/tasks/${b.id}/move`, { status: 'doing', position: 0 });
      const other = await make.task(api, { title: 'Autre' });
      const noteA = await make.entry(api, { title: 'Note A', content_md: 'a', project_id: project.id });
      await api.upload('photo.txt', 'image', { entry_id: noteA.id });
      const noteB = await make.entry(api, { title: 'Note B', content_md: 'b', project_id: project.id });
      const procedure = await make.entry(api, { title: 'Mode opératoire', content_md: 'étapes', kind: 'procedure' });
      const google = await make.entry(api, { title: 'Doc Google', content_md: 'g' });
      api.db.prepare(`INSERT INTO google_documents (entry_id,document_id,tab_id,revision_id,synced_content_json,synced_at)
        VALUES (?,?,?,?,?,?)`).run(google.id, 'doc', 't.0', 'rev', '{"type":"doc","content":[]}', new Date().toISOString());
      await link(a.id, noteA.id);
      await link(a.id, procedure.id);
      await link(b.id, noteB.id);
      await link(b.id, google.id);
      await link(other.id, noteB.id);

      const res = await api.post('/api/tasks/merge', await mergeRequest([a.id, b.id]));
      assert.equal(res.status, 200);
      assert.equal(res.body.title, 'Tâche commune');
      assert.equal(res.body.content_md, 'Note commune');
      assert.equal(res.body.project_id, project.id);
      assert.deepEqual((await api.get(`/api/entries/${res.body.id}`)).body.attachments.map((file) => file.filename), ['photo.txt']);

      const state = (await api.get('/api/state')).body;
      assert.deepEqual(state.tasks.map((task) => task.title).sort(), ['Autre', 'Tâche commune']);
      const merged = state.tasks.find((task) => task.title === 'Tâche commune');
      // Le plus urgent des sources : en cours, échéance la plus proche, priorité haute, épinglée.
      assert.equal(merged.status, 'doing');
      assert.equal(merged.due_date, '2026-12-05');
      assert.equal(merged.priority, 'high');
      assert.equal(merged.pinned, 1);
      assert.equal(merged.project_id, project.id);
      assert.deepEqual(merged.documents.map((document) => document.id).sort(), [res.body.id, procedure.id, google.id].sort());
      // Une tâche non choisie qui partageait une note suit la nouvelle, comme à la fusion d'entrées.
      assert.deepEqual(state.tasks.find((task) => task.id === other.id).documents.map((document) => document.id), [res.body.id]);
      assert.equal((await api.get(`/api/entries/${noteA.id}`)).status, 404);
      assert.equal((await api.get(`/api/entries/${noteB.id}`)).status, 404);
      assert.equal((await api.get(`/api/entries/${procedure.id}`)).status, 200);
      assert.equal((await api.get(`/api/entries/${google.id}`)).status, 200);
      // La synchro doit savoir que les sources ont disparu, sinon elles reviendraient.
      const tombstones = api.db.prepare('SELECT kind, id FROM sync_tombstones').all().map((row) => `${row.kind}:${row.id}`);
      for (const expected of [`task:${a.id}`, `task:${b.id}`, `entry:${noteA.id}`, `entry:${noteB.id}`]) assert.ok(tombstones.includes(expected), expected);
      assert.ok(!tombstones.includes(`entry:${procedure.id}`));
    });

    test('des tâches sans document donnent quand même une tâche avec sa note', async () => {
      const a = await make.task(api, { title: 'A' });
      const b = await make.task(api, { title: 'B' });
      const res = await api.post('/api/tasks/merge', await mergeRequest([a.id, b.id]));
      const merged = (await api.get('/api/state')).body.tasks.find((task) => task.title === 'Tâche commune');
      assert.deepEqual(merged.documents.map((document) => document.id), [res.body.id]);
    });

    test('rejouer la même demande rend la même note et ne crée rien de plus', async () => {
      const a = await make.task(api, { title: 'A' });
      const b = await make.task(api, { title: 'B' });
      const body = await mergeRequest([a.id, b.id]);
      const first = await api.post('/api/tasks/merge', body);
      const replay = await api.post('/api/tasks/merge', body);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.id, first.body.id);
      assert.equal((await api.get('/api/state')).body.tasks.length, 1);
    });

    test('une tâche, une note ou un lien modifiés depuis la proposition refusent tout', async () => {
      const a = await make.task(api, { title: 'A' });
      const b = await make.task(api, { title: 'B' });
      const note = await make.entry(api, { title: 'Note', content_md: 'n' });
      await link(a.id, note.id);
      const changes = [
        () => api.put(`/api/tasks/${b.id}`, { title: 'B modifiée' }),
        () => api.put(`/api/entries/${note.id}`, { content_md: 'n modifiée' }),
        async () => link(b.id, (await make.entry(api, { title: 'Nouvelle', content_md: 'x' })).id),
      ];
      for (const change of changes) {
        const body = await mergeRequest([a.id, b.id]);
        await change();
        const res = await api.post('/api/tasks/merge', body);
        assert.equal(res.status, 409);
        assert.match(res.body.error, /a changé/);
      }
      assert.ok(await stateTask(a.id));
      assert.ok(await stateTask(b.id));
      assert.equal((await api.get(`/api/entries/${note.id}`)).status, 200);
    });

    test('une tâche terminée ne décide pas si une autre reste ouverte', async () => {
      const done = await make.task(api, { title: 'Ancienne', due_date: '2020-01-01', priority: 'high', status: 'done' });
      const open = await make.task(api, { title: 'Ouverte', due_date: '2026-12-05' });
      await api.post('/api/tasks/merge', await mergeRequest([done.id, open.id]));
      const merged = (await api.get('/api/state')).body.tasks[0];
      assert.equal(merged.status, 'todo');
      assert.equal(merged.due_date, '2026-12-05');
      assert.equal(merged.priority, 'normal');
    });

    test('tout terminé : la tâche reste terminée et sa note est archivée', async () => {
      const a = await make.task(api, { title: 'A', status: 'done' });
      const b = await make.task(api, { title: 'B', status: 'done' });
      const res = await api.post('/api/tasks/merge', await mergeRequest([a.id, b.id]));
      assert.equal((await api.get('/api/state')).body.tasks[0].status, 'done');
      assert.equal((await api.get(`/api/entries/${res.body.id}`)).body.archived, 1);
    });

    test('refuse moins de deux tâches', async () => {
      const task = await make.task(api, { title: 'Seule' });
      const res = await api.post('/api/tasks/merge', await mergeRequest([task.id]));
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Fusion invalide : titre, texte, identifiant de demande et deux à huit tâches requis.');
    });
  });

  test('404 sur une tâche inconnue', async () => {
    assert.equal((await api.put('/api/tasks/tk_nope', { title: 'x' })).status, 404);
    assert.equal((await api.patch('/api/tasks/tk_nope/move', { status: 'done' })).status, 404);
    assert.equal((await api.del('/api/tasks/tk_nope')).status, 404);
  });
});
