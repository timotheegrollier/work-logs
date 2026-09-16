import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, make } from './helpers.js';

describe('état global et recherche', () => {
  let api;
  before(async () => { api = await startApi(); });
  after(() => api.close());
  beforeEach(() => api.db.exec('DELETE FROM tasks; DELETE FROM entries; DELETE FROM projects;'));

  test('répond ok sur /api/health', async () => {
    const res = await api.get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('404 en JSON sur une route inconnue', async () => {
    const res = await api.get('/api/nimporte-quoi');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'route inconnue');
  });

  test('renvoie tout l’écran en un seul appel', async () => {
    await make.project(api);
    await make.entry(api);
    await make.task(api);

    const { body } = await api.get('/api/state');
    assert.deepEqual(Object.keys(body).sort(), ['entries', 'projects', 'stats', 'tasks']);
    assert.equal(body.projects.length, 1);
    assert.equal(body.entries.length, 1);
    assert.equal(body.tasks.length, 1);
  });

  test('la liste des entrées porte un extrait, pas le corps entier', async () => {
    await make.entry(api, { title: 'Longue', content_md: 'x'.repeat(1000) });
    const { body } = await api.get('/api/state');

    assert.equal(body.entries[0].excerpt.length, 240);
    assert.equal(body.entries[0].content_md, undefined, 'le corps complet n’est pas transporté');
    assert.equal(body.entries[0].attachments, 0, 'compteur de pièces jointes');
  });

  test('trie les entrées de la plus récente à la plus ancienne', async () => {
    await make.entry(api, { title: 'Vieille', entry_date: '2026-01-01' });
    await make.entry(api, { title: 'Récente', entry_date: '2026-06-01' });
    await make.entry(api, { title: 'Moyenne', entry_date: '2026-03-01' });

    const { body } = await api.get('/api/state');
    assert.deepEqual(body.entries.map((e) => e.title), ['Récente', 'Moyenne', 'Vieille']);
  });

  test('filtre par recherche, sur le titre comme sur le corps', async () => {
    await make.entry(api, { title: 'Devis toiture' });
    await make.entry(api, { title: 'Autre', content_md: 'mention de la toiture ici' });
    await make.entry(api, { title: 'Sans rapport' });
    await make.task(api, { title: 'Relancer toiture' });
    await make.task(api, { title: 'Autre tâche' });

    const { body } = await api.get('/api/state?q=toiture');
    assert.deepEqual(body.entries.map((e) => e.title).sort(), ['Autre', 'Devis toiture']);
    assert.deepEqual(body.tasks.map((t) => t.title), ['Relancer toiture']);
  });

  test('filtre par projet, entrées et tâches ensemble', async () => {
    const a = await make.project(api, 'A');
    const b = await make.project(api, 'B');
    await make.entry(api, { title: 'Chez A', project_id: a.id });
    await make.entry(api, { title: 'Chez B', project_id: b.id });
    await make.task(api, { title: 'Tâche A', project_id: a.id });
    await make.task(api, { title: 'Tâche B', project_id: b.id });

    const { body } = await api.get(`/api/state?project_id=${a.id}`);
    assert.deepEqual(body.entries.map((e) => e.title), ['Chez A']);
    assert.deepEqual(body.tasks.map((t) => t.title), ['Tâche A']);
  });

  test('combine recherche et projet', async () => {
    const a = await make.project(api, 'A');
    await make.project(api, 'B');
    await make.entry(api, { title: 'toiture chez A', project_id: a.id });
    await make.entry(api, { title: 'toiture ailleurs' });

    const { body } = await api.get(`/api/state?q=toiture&project_id=${a.id}`);
    assert.deepEqual(body.entries.map((e) => e.title), ['toiture chez A']);
  });

  test('compte les statistiques de l’en-tête', async () => {
    const hier = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    await make.entry(api, { title: 'Cette semaine' });
    await make.entry(api, { title: 'L’an dernier', entry_date: '2025-01-01' });
    await make.task(api, { title: 'En retard', due_date: hier });
    await make.task(api, { title: 'En cours', status: 'doing' });
    await make.task(api, { title: 'Finie', status: 'done' });
    await make.task(api, { title: 'Finie en retard', status: 'done', due_date: hier });

    const { body } = await api.get('/api/state');
    assert.equal(body.stats.entries, 2);
    assert.equal(body.stats.entriesThisWeek, 1);
    assert.deepEqual(body.stats.tasks, { todo: 1, doing: 1, done: 2 });
    assert.equal(body.stats.overdue, 1, 'une tâche terminée n’est jamais « en retard »');
  });

  test('exporte toute la base en JSON', async () => {
    const project = await make.project(api, 'Export');
    const entry = await make.entry(api, { title: 'Entrée exportée', project_id: project.id });
    const task = await make.task(api, { title: 'Tâche exportée' });
    await api.post(`/api/tasks/${task.id}/documents/${entry.id}`);

    const { status, body } = await api.get('/api/export');
    assert.equal(status, 200);
    assert.equal(body.version, 2);
    assert.equal(body.projects.length, 1);
    assert.equal(body.entries[0].title, 'Entrée exportée');
    assert.equal(body.entries[0].content_md, '', 'l’export contient bien le corps');
    assert.equal(body.tasks.length, 1);
    assert.equal(body.task_entries.length, 1);
    assert.equal(body.task_entries[0].task_id, task.id);
    assert.equal(body.task_entries[0].entry_id, entry.id);
    assert.ok(body.task_entries[0].created_at);
  });
});

describe('données de démarrage', () => {
  test('la base vierge est amorcée avec de quoi commencer', async () => {
    const api = await startApi({ withSeed: true });
    try {
      const { body } = await api.get('/api/state');
      assert.ok(body.projects.length >= 2);
      assert.ok(body.entries.length >= 1);
      assert.ok(body.tasks.length >= 1);
    } finally {
      await api.close();
    }
  });

  test('l’amorçage ne se rejoue pas au redémarrage', async () => {
    const api = await startApi({ withSeed: true });
    try {
      const before = (await api.get('/api/state')).body.entries.length;
      const { openDb } = await import('../src/db.js');
      openDb(`${api.dir}/worklogs.db`, { withSeed: true }).close();
      assert.equal((await api.get('/api/state')).body.entries.length, before);
    } finally {
      await api.close();
    }
  });
});
