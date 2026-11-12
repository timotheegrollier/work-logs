import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApi, make } from './helpers.js';
import { openDb } from '../src/db.js';
import { entryMergeSourceKey } from '../src/entry-merge.js';
import crypto from 'node:crypto';

const expected = (entry) => ({
  title: entry.title, entry_date: entry.entry_date, project_id: entry.project_id, category_id: entry.category_id ?? null,
  archived: entry.archived, kind: entry.kind, status: entry.status, updated_at: entry.updated_at,
  google_document_id: entry.google_sync?.document_id ?? null,
});

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
    assert.equal(res.body.status, 'todo');
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

  test('archive et désarchive sans toucher au reste', async () => {
    const entry = await make.entry(api, { title: 'À ranger' });
    assert.equal(entry.archived, 0, 'visible par défaut');

    let res = await api.put(`/api/entries/${entry.id}`, { archived: 1 });
    assert.equal(res.body.archived, 1);
    assert.equal(res.body.title, 'À ranger');

    res = await api.put(`/api/entries/${entry.id}`, { title: 'Autre nom' });
    assert.equal(res.body.archived, 1, 'non fourni = non écrasé');

    const state = await api.get('/api/state');
    assert.equal(state.body.entries.find((row) => row.id === entry.id).archived, 1);

    res = await api.put(`/api/entries/${entry.id}`, { archived: 0 });
    assert.equal(res.body.archived, 0);
  });

  test('conserve un statut propre à l’entrée, séparé de son archivage et du statut de sa tâche', async () => {
    const entry = await make.entry(api, { title: 'Déploiement', status: 'doing' });
    assert.equal(entry.status, 'doing');
    const task = await make.task(api, { status: 'doing' });
    await api.post(`/api/tasks/${task.id}/documents/${entry.id}`);
    const updated = await api.put(`/api/entries/${entry.id}`, { status: 'done', expected_entry: expected(entry) });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.status, 'done');
    assert.equal(updated.body.archived, 0);
    const state = (await api.get('/api/state')).body;
    assert.equal(state.entries.find(({ id }) => id === entry.id).status, 'done');
    assert.equal(state.tasks.find(({ id }) => id === task.id).status, 'doing');
    assert.equal(state.tasks.find(({ id }) => id === task.id).documents[0].status, 'done');
    const archived = await api.put(`/api/entries/${entry.id}`, { archived: 1 });
    assert.equal(archived.body.status, 'done');
    assert.equal((await api.put(`/api/entries/${entry.id}`, { status: 'blocked' })).status, 400);
    assert.equal((await api.post('/api/entries', { title: 'Invalide', status: 'blocked' })).status, 400);
    assert.equal((await api.get(`/api/entries/${entry.id}`)).body.status, 'done');
  });

  test('deux propositions sur la même version d’une entrée ne s’écrasent pas', async () => {
    const entry = await make.entry(api, { title: 'Suivi chantier' });
    const responses = await Promise.all(['doing', 'done'].map((status) => api.put(`/api/entries/${entry.id}`, { status, expected_entry: expected(entry) })));
    assert.deepEqual(responses.map((res) => res.status).sort(), [200, 409]);
    assert.equal(responses.find((res) => res.status === 409).body.code, 'ENTRY_EDIT_STALE');
    assert.equal((await api.get(`/api/entries/${entry.id}`)).body.status, responses.find((res) => res.status === 200).body.status);
  });

  test('un corps édité à date égale est protégé par l’instantané du texte', async () => {
    const entry = await make.entry(api, { title: 'Texte à réviser', content_md: 'Version initiale' });
    const expected_entry = { ...expected(entry), source_key: entryMergeSourceKey(entry) };
    const invalid = await api.put(`/api/entries/${entry.id}`, { content_md: 'Proposition', expected_entry: expected(entry) });
    assert.equal(invalid.status, 400);
    api.db.prepare('UPDATE entries SET content_md=? WHERE id=?').run('Saisie locale', entry.id);
    const stale = await api.put(`/api/entries/${entry.id}`, { content_md: 'Proposition', expected_entry });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'ENTRY_EDIT_STALE');
    const current = (await api.get(`/api/entries/${entry.id}`)).body;
    assert.equal(current.content_md, 'Saisie locale');
    const applied = await api.put(`/api/entries/${entry.id}`, { content_md: 'Proposition relue', expected_entry: { ...expected(current), source_key: entryMergeSourceKey(current) } });
    assert.equal(applied.body.content_md, 'Proposition relue');
  });

  test('une base antérieure sans colonne reste visible sans perdre ses entrées', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-archive-migration-'));
    const file = path.join(dir, 'old.db');
    const initial = openDb(file, { withSeed: false });
    initial.exec(`DROP TABLE entries;
      CREATE TABLE entries (id TEXT PRIMARY KEY, title TEXT NOT NULL, content_md TEXT NOT NULL DEFAULT '',
        entry_date TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO entries (id,title,entry_date,created_at,updated_at) VALUES ('en_old','Ancienne','2026-01-05','','');`);
    initial.close();
    const migrated = openDb(file, { withSeed: false });
    try {
      const row = migrated.prepare('SELECT * FROM entries WHERE id=?').get('en_old');
      assert.equal(row.archived, 0);
      assert.equal(row.status, 'todo');
      assert.equal(row.title, 'Ancienne');
      assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      migrated.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  test('supprime une entrée Google et ses associations sans appel réseau', async () => {
    let networkCalls = 0;
    const google = { request: async () => { networkCalls += 1; throw new Error('réseau inattendu'); } };
    const isolated = await startApi({ google });
    try {
      const entry = await make.entry(isolated, { title: 'Onglet à retirer' });
      isolated.db.prepare(`INSERT INTO google_documents
        (entry_id, document_id, tab_id, revision_id, synced_content_json, document_title, tab_title)
        VALUES (?,?,?,?,?,?,?)`).run(entry.id, 'absent-google', 'tab-1', 'r1', '{}', 'Document absent', 'Onglet');
      const task = await make.task(isolated);
      assert.equal((await isolated.post(`/api/tasks/${task.id}/documents/${entry.id}`)).status, 201);

      const res = await isolated.del(`/api/entries/${entry.id}`);
      assert.equal(res.status, 200);
      assert.equal(isolated.db.prepare('SELECT COUNT(*) n FROM google_documents WHERE entry_id=?').get(entry.id).n, 0);
      assert.equal(isolated.db.prepare('SELECT COUNT(*) n FROM task_entries WHERE entry_id=?').get(entry.id).n, 0);
      assert.equal(networkCalls, 0);
    } finally {
      await isolated.close();
    }
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

  test('fusionne deux entrées : crée la nouvelle et supprime les anciennes', async () => {
    const entry1 = await make.entry(api, { title: 'Note A', content_md: 'Contenu de la note A\n- action 1' });
    const entry2 = await make.entry(api, { title: 'Note B', content_md: 'Contenu de la note B\n- action 2' });

    const body = {
      request_id: crypto.randomUUID(),
      sources: [
        { id: entry1.id, source_key: entryMergeSourceKey(entry1) },
        { id: entry2.id, source_key: entryMergeSourceKey(entry2) },
      ],
      title: 'Note fusionnée',
      content_md: 'Contenu fusionné\n- action 1\n- action 2',
    };

    const res = await api.post('/api/entries/merge', body);
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Note fusionnée');
    assert.equal(res.body.content_md, 'Contenu fusionné\n- action 1\n- action 2');
    assert.notEqual(res.body.id, entry1.id);
    assert.notEqual(res.body.id, entry2.id);

    // Les anciennes entrées sont supprimées
    assert.equal((await api.get(`/api/entries/${entry1.id}`)).status, 404);
    assert.equal((await api.get(`/api/entries/${entry2.id}`)).status, 404);
    assert.equal((await api.get(`/api/entries/${res.body.id}`)).status, 200);
  });

  test('fusion : pièces jointes et tâches suivent, une demande rejouée rend la même entrée', async () => {
    const project = await make.project(api, 'Atelier');
    const a = await make.entry(api, { title: 'A', content_md: 'a', project_id: project.id });
    await api.upload('photo.txt', 'image', { entry_id: a.id });
    const b = await make.entry(api, { title: 'B', content_md: 'b', project_id: project.id });
    const task = await make.task(api, { title: 'Joint' });
    await api.post(`/api/tasks/${task.id}/documents/${a.id}`);
    await api.post(`/api/tasks/${task.id}/documents/${b.id}`);
    const [fullA, fullB] = await Promise.all([a, b].map(async (entry) => (await api.get(`/api/entries/${entry.id}`)).body));
    const body = {
      request_id: crypto.randomUUID(),
      sources: [fullA, fullB].map((entry) => ({ id: entry.id, source_key: entryMergeSourceKey(entry) })),
      title: 'A et B', content_md: 'a\nb',
    };
    const merged = (await api.post('/api/entries/merge', body)).body;
    assert.equal(merged.project_id, project.id);
    const files = (await api.get(`/api/entries/${merged.id}`)).body.attachments;
    assert.deepEqual(files.map((file) => file.filename), ['photo.txt']);
    const state = (await api.get('/api/state')).body;
    assert.deepEqual(state.tasks.find((t) => t.id === task.id).documents.map((d) => d.id), [merged.id]);
    // Réponse perdue : revalider la même proposition ne crée rien de plus.
    const replay = await api.post('/api/entries/merge', body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, merged.id);
    assert.equal(state.entries.filter((entry) => entry.title === 'A et B').length, 1);
  });

  test('fusion : une source modifiée depuis la proposition refuse tout', async () => {
    const a = await make.entry(api, { title: 'A', content_md: 'a' });
    const b = await make.entry(api, { title: 'B', content_md: 'b' });
    const body = {
      request_id: crypto.randomUUID(),
      sources: [a, b].map((entry) => ({ id: entry.id, source_key: entryMergeSourceKey(entry) })),
      title: 'A et B', content_md: 'a\nb',
    };
    await api.put(`/api/entries/${b.id}`, { content_md: 'b modifié ailleurs' });
    const res = await api.post('/api/entries/merge', body);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /a changé/);
    assert.equal((await api.get(`/api/entries/${a.id}`)).status, 200);
  });

  test('refuse la fusion avec moins de deux entrées', async () => {
    const body = {
      request_id: crypto.randomUUID(),
      sources: [{ id: 'en_test', source_key: 'key' }],
      title: 'x',
      content_md: 'y',
    };
    const res = await api.post('/api/entries/merge', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Fusion invalide : titre, texte, identifiant de demande et deux à huit entrées requis.');
  });

  test('refuse la fusion avec un titre ou du contenu vide', async () => {
    const body = {
      request_id: crypto.randomUUID(),
      sources: [{ id: 'en_a', source_key: 'a' }, { id: 'en_b', source_key: 'b' }],
      title: '   ',
      content_md: 'du contenu',
    };
    let res = await api.post('/api/entries/merge', body);
    assert.equal(res.status, 400);

    body.title = 'Un titre';
    body.content_md = '   ';
    res = await api.post('/api/entries/merge', body);
    assert.equal(res.status, 400);
  });
});
