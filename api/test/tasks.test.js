import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, make } from './helpers.js';

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
    assert.deepEqual(created.body.documents.map((document) => document.id), [entry.id]);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM task_entries WHERE task_id=? AND entry_id=?').get(created.body.id, entry.id).n, 1);
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

  test('404 sur une tâche inconnue', async () => {
    assert.equal((await api.put('/api/tasks/tk_nope', { title: 'x' })).status, 404);
    assert.equal((await api.patch('/api/tasks/tk_nope/move', { status: 'done' })).status, 404);
    assert.equal((await api.del('/api/tasks/tk_nope')).status, 404);
  });
});
