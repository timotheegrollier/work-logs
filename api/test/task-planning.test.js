import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { make, startApi } from './helpers.js';

const expected = (task) => ({
  title: task.title, status: task.status, priority: task.priority, due_date: task.due_date,
  project_id: task.project_id, pinned: task.pinned, follow_up_key: task.follow_up_key ?? null,
});

describe('application atomique d’une replanification IA', () => {
  let api;
  before(async () => { api = await startApi(); });
  after(() => api.close());
  beforeEach(() => api.db.exec('DELETE FROM task_entries; DELETE FROM google_documents; DELETE FROM tasks; DELETE FROM entries; DELETE FROM categories; DELETE FROM projects;'));
  const current = (id) => api.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);

  test('une proposition relue change seulement la date et la priorité ; le contrôle attendu reste optionnel', async () => {
    const task = await make.task(api, { title: 'Contrôler', status: 'doing' });
    const result = await api.put(`/api/tasks/${task.id}`, { priority: 'high', due_date: '2026-11-06', expected_planning: expected(task) });
    assert.equal(result.status, 200);
    assert.equal(result.body.priority, 'high');
    assert.equal(result.body.due_date, '2026-11-06');
    assert.equal(result.body.status, 'doing');
    assert.equal(result.body.title, task.title);
    assert.equal(Object.hasOwn(current(task.id), 'expected_planning'), false);
    assert.equal((await api.put(`/api/tasks/${task.id}`, { title: 'Contrôler la vanne' })).status, 200);
  });

  test('un changement après la lecture de la proposition est refusé sans écraser les données courantes', async () => {
    const project = await make.project(api, 'Autre');
    for (const patch of [{ status: 'done' }, { priority: 'high' }, { due_date: '2026-11-20' }, { title: 'Autre titre' }, { project_id: project.id }, { pinned: 1 }]) {
      const task = await make.task(api, { title: 'Action à dater' });
      await api.put(`/api/tasks/${task.id}`, patch);
      const before = current(task.id);
      const refused = await api.put(`/api/tasks/${task.id}`, { priority: 'low', due_date: '2026-11-07', expected_planning: expected(task) });
      assert.equal(refused.status, 409, JSON.stringify(patch));
      assert.equal(refused.body.code, 'TASK_PLANNING_STALE');
      assert.match(refused.body.error, /a changé/);
      assert.deepEqual(current(task.id), before, 'aucun champ ni updated_at touché par le refus');
    }
  });

  test('la source d’un suivi modifiée après la proposition invalide aussi les dates', async () => {
    const note = await make.entry(api, { title: 'Avancées', content_md: 'Pièce attendue.' });
    const task = await make.task(api);
    await api.post(`/api/tasks/${task.id}/documents/${note.id}`);
    await api.put(`/api/follow-up/task/${task.id}`, { enabled: true });
    const snapshot = (await api.get('/api/state')).body.tasks.find((row) => row.id === task.id);
    await api.put(`/api/entries/${note.id}`, { content_md: 'Pièce reçue.' });
    const before = current(task.id);
    const refused = await api.put(`/api/tasks/${task.id}`, { due_date: '2026-11-07', priority: 'high', expected_planning: expected(snapshot) });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'TASK_PLANNING_STALE');
    assert.deepEqual(current(task.id), before);
  });

  test('un classement changé ou un nouveau document lié invalide la proposition', async () => {
    const project = await make.project(api);
    const { body: category } = await api.post('/api/categories', { name: 'Planning', project_id: project.id });
    const task = await make.task(api, { project_id: project.id });
    const url = `/api/tasks/${task.id}`;
    await api.put(url, { category_id: category.id });
    const staleCategory = await api.put(url, { category_id: null, expected_planning: { ...expected(task), category_id: null } });
    assert.equal(staleCategory.status, 409);
    assert.equal(current(task.id).category_id, category.id);

    const entry = await make.entry(api, { project_id: project.id });
    await api.post(`${url}/documents/${entry.id}`);
    const snapshot = { ...expected(task), category_id: category.id };
    const staleDocuments = await api.put(url, { status: 'done', expected_planning: { ...snapshot, active_document_ids: [] } });
    assert.equal(staleDocuments.status, 409);
    assert.equal(current(task.id).status, 'todo');
    assert.equal((await api.get(`/api/entries/${entry.id}`)).body.archived, 0);

    const finished = await api.put(url, { status: 'done', expected_planning: { ...snapshot, active_document_ids: [entry.id, task.documents[0].id] } });
    assert.equal(finished.status, 200);
    assert.equal((await api.get(`/api/entries/${entry.id}`)).body.archived, 1);
  });

  test('deux applications concurrentes du même instantané ne peuvent pas toutes deux écrire', async () => {
    const task = await make.task(api);
    const results = await Promise.all(['2026-11-06', '2026-11-07'].map((due_date) => api.put(`/api/tasks/${task.id}`, { priority: 'high', due_date, expected_planning: expected(task) })));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(current(task.id).due_date, results.find((result) => result.status === 200).body.due_date);
    // Même après une réponse perdue, renvoyer l'ancien instantané ne réécrit rien.
    const before = current(task.id);
    const retry = await api.put(`/api/tasks/${task.id}`, { priority: 'high', due_date: before.due_date, expected_planning: expected(task) });
    assert.equal(retry.status, 409);
    assert.deepEqual(current(task.id), before);
  });

  test('un instantané mal formé est refusé en 400 sans écriture et sans garder la transaction ouverte', async () => {
    const task = await make.task(api);
    const snapshot = expected(task);
    const before = current(task.id);
    for (const invalid of [null, [], {}, { priority: 'normal', due_date: null }, { ...snapshot, status: 'blocked' }, { ...snapshot, priority: 'urgent' }, { ...snapshot, due_date: 8 }, { ...snapshot, pinned: true }, { ...snapshot, follow_up_key: '' }, { ...snapshot, project_id: 5 }, { ...snapshot, title: '' }, { ...snapshot, typo: 'ignored?' }]) {
      const result = await api.put(`/api/tasks/${task.id}`, { due_date: '2026-11-07', expected_planning: invalid });
      assert.equal(result.status, 400, JSON.stringify(invalid));
      assert.deepEqual(current(task.id), before);
    }
    assert.equal((await api.put(`/api/tasks/${task.id}`, { title: 'Transaction libérée' })).status, 200);
  });
});
