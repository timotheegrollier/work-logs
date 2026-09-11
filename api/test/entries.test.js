import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, make } from './helpers.js';

describe('entrées de journal', () => {
  let api;
  before(async () => { api = await startApi(); });
  after(() => api.close());

  test('crée une entrée datée d’aujourd’hui par défaut', async () => {
    const res = await api.post('/api/entries', { title: '  Réunion client  ' });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Réunion client', 'le titre est nettoyé');
    assert.equal(res.body.entry_date, new Date().toISOString().slice(0, 10));
    assert.equal(res.body.content_md, '');
    assert.equal(res.body.project_id, null);
  });

  test('refuse un titre vide ou absent', async () => {
    for (const body of [{}, { title: '' }, { title: '   ' }, { title: 42 }]) {
      const res = await api.post('/api/entries', body);
      assert.equal(res.status, 400, `titre ${JSON.stringify(body)}`);
      assert.equal(res.body.error, 'titre requis');
    }
  });

  test('refuse une date mal formée', async () => {
    const res = await api.post('/api/entries', { title: 'x', entry_date: '12/03/2026' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /date invalide/);
  });

  test('refuse un projet inexistant', async () => {
    const res = await api.post('/api/entries', { title: 'x', project_id: 'pr_nope' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'projet introuvable');
  });

  test('relit une entrée avec ses pièces jointes', async () => {
    const entry = await make.entry(api, { title: 'Avec fichier' });
    await api.upload('note.txt', 'bonjour', { entry_id: entry.id });

    const res = await api.get(`/api/entries/${entry.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.attachments.length, 1);
    assert.equal(res.body.attachments[0].filename, 'note.txt');
  });

  test('404 sur une entrée inconnue', async () => {
    const res = await api.get('/api/entries/en_nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'entrée introuvable');
  });

  test('modifie uniquement les champs fournis', async () => {
    const project = await make.project(api, 'Chantier');
    const entry = await make.entry(api, {
      title: 'Avant',
      content_md: '# corps',
      entry_date: '2026-01-15',
      project_id: project.id,
    });

    const res = await api.put(`/api/entries/${entry.id}`, { title: 'Après' });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Après');
    assert.equal(res.body.content_md, '# corps', 'le corps est préservé');
    assert.equal(res.body.entry_date, '2026-01-15', 'la date est préservée');
    assert.equal(res.body.project_id, project.id, 'le projet est préservé');
    assert.notEqual(res.body.updated_at, entry.updated_at, 'updated_at est rafraîchi');
  });

  test('détache le projet avec une chaîne vide', async () => {
    const project = await make.project(api);
    const entry = await make.entry(api, { project_id: project.id });
    const res = await api.put(`/api/entries/${entry.id}`, { project_id: '' });
    assert.equal(res.body.project_id, null);
  });

  test('accepte un corps vidé', async () => {
    const entry = await make.entry(api, { content_md: 'du texte' });
    const res = await api.put(`/api/entries/${entry.id}`, { content_md: '' });
    assert.equal(res.body.content_md, '');
  });

  test('refuse une mise à jour qui viderait le titre', async () => {
    const entry = await make.entry(api);
    const res = await api.put(`/api/entries/${entry.id}`, { title: '  ' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'titre requis');
  });

  test('supprime une entrée', async () => {
    const entry = await make.entry(api);
    assert.equal((await api.del(`/api/entries/${entry.id}`)).status, 200);
    assert.equal((await api.get(`/api/entries/${entry.id}`)).status, 404);
    assert.equal((await api.del(`/api/entries/${entry.id}`)).status, 404);
  });

  test('supprimer le projet détache l’entrée sans la perdre', async () => {
    const project = await make.project(api);
    const entry = await make.entry(api, { title: 'Survivante', project_id: project.id });

    await api.del(`/api/projects/${project.id}`);

    const res = await api.get(`/api/entries/${entry.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Survivante');
    assert.equal(res.body.project_id, null);
  });
});
