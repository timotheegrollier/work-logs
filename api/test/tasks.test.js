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
  beforeEach(() => api.db.exec('DELETE FROM tasks'));

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

  test('404 sur une tâche inconnue', async () => {
    assert.equal((await api.put('/api/tasks/tk_nope', { title: 'x' })).status, 404);
    assert.equal((await api.patch('/api/tasks/tk_nope/move', { status: 'done' })).status, 404);
    assert.equal((await api.del('/api/tasks/tk_nope')).status, 404);
  });
});
