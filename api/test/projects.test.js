import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, make } from './helpers.js';

describe('projets', () => {
  let api;
  before(async () => { api = await startApi(); });
  after(() => api.close());
  beforeEach(() => api.db.exec('DELETE FROM tasks; DELETE FROM entries; DELETE FROM projects;'));

  test('crée un projet avec une couleur par défaut', async () => {
    const res = await api.post('/api/projects', { name: '  Maison  ' });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Maison');
    assert.equal(res.body.color, '#4f7cff');
  });

  test('refuse un nom vide', async () => {
    const res = await api.post('/api/projects', { name: '  ' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'nom requis');
  });

  test('renomme sans perdre la couleur', async () => {
    const project = await make.project(api, 'Avant', '#123456');
    const res = await api.put(`/api/projects/${project.id}`, { name: 'Après' });
    assert.equal(res.body.name, 'Après');
    assert.equal(res.body.color, '#123456');
  });

  test('liste les projets triés avec leurs compteurs', async () => {
    const zebre = await make.project(api, 'Zèbre');
    const alpha = await make.project(api, 'Alpha');
    await make.entry(api, { project_id: alpha.id });
    await make.task(api, { project_id: alpha.id });
    await make.task(api, { project_id: alpha.id, status: 'done' });
    await make.task(api, { project_id: zebre.id });

    const { body } = await api.get('/api/state');
    assert.deepEqual(body.projects.map((p) => p.name), ['Alpha', 'Zèbre']);
    assert.equal(body.projects[0].entries, 1);
    assert.equal(body.projects[0].open_tasks, 1, 'les tâches terminées ne comptent pas');
    assert.equal(body.projects[1].open_tasks, 1);
  });

  test('supprimer un projet détache ses tâches sans les perdre', async () => {
    const project = await make.project(api);
    await make.task(api, { title: 'Orpheline', project_id: project.id });

    await api.del(`/api/projects/${project.id}`);

    const { body } = await api.get('/api/state');
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].title, 'Orpheline');
    assert.equal(body.tasks[0].project_id, null);
  });

  test('404 sur un projet inconnu', async () => {
    assert.equal((await api.put('/api/projects/pr_nope', { name: 'x' })).status, 404);
    assert.equal((await api.del('/api/projects/pr_nope')).status, 404);
  });
});
