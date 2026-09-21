import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApi, make } from './helpers.js';
import { openDb } from '../src/db.js';

describe('panneau Procédures', () => {
  let api;
  before(async () => { api = await startApi(); });
  after(() => api.close());

  test('les entrées sont des notes par défaut, type invalide refusé', async () => {
    const note = await make.entry(api, { title: 'Simple note' });
    assert.equal(note.kind, 'note');

    const bad = await api.post('/api/entries', { title: 'X', kind: 'mode-emploi' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'type de document invalide (note ou procédure attendu)');

    const empty = await api.post('/api/entries', { title: 'Y', kind: '' });
    assert.equal(empty.body.kind, 'note', 'chaîne vide = défaut');
  });

  test('crée, convertit et recopie une procédure avec son type', async () => {
    const project = await make.project(api, 'Chantier');
    const created = await api.post('/api/entries', { title: 'Montage échafaudage', project_id: project.id, kind: 'procedure' });
    assert.equal(created.status, 201);
    assert.equal(created.body.kind, 'procedure');

    const renamed = await api.put(`/api/entries/${created.body.id}`, { title: 'Montage v2' });
    assert.equal(renamed.body.kind, 'procedure', 'non fourni = non écrasé');

    const converted = await api.put(`/api/entries/${created.body.id}`, { kind: 'note' });
    assert.equal(converted.body.kind, 'note');
    await api.put(`/api/entries/${created.body.id}`, { kind: 'procedure' });

    const copy = await api.post(`/api/entries/${created.body.id}/copy`);
    assert.equal(copy.body.kind, 'procedure', 'la copie garde le type');
  });

  test('/api/state expose le type et rassemble les pièces jointes des procédures', async () => {
    const project = await make.project(api, 'Villa');
    const procedure = await api.post('/api/entries', { title: 'Dallage', project_id: project.id, kind: 'procedure' });
    const note = await make.entry(api, { title: 'Pense-bête', project_id: project.id });
    const sent = await api.upload('devis.pdf', 'contenu', { entry_id: procedure.body.id });
    assert.equal(sent.status, 201);
    await api.upload('photo.jpg', 'pixels', { entry_id: note.id });

    const state = await api.get(`/api/state?project_id=${project.id}`);
    const summaries = new Map(state.body.entries.map((row) => [row.id, row]));
    assert.equal(summaries.get(procedure.body.id).kind, 'procedure');
    assert.equal(summaries.get(note.id).kind, 'note');
    assert.equal(state.body.procedure_attachments.length, 1, 'seule la pièce de la procédure');
    assert.equal(state.body.procedure_attachments[0].filename, 'devis.pdf');
    assert.equal(state.body.procedure_attachments[0].entry_title, 'Dallage');

    const all = await api.get('/api/state');
    assert.ok(all.body.procedure_attachments.some((file) => file.filename === 'devis.pdf'), 'visible aussi sans filtre');
  });

  test('une base antérieure sans colonne reste des notes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-kind-migration-'));
    const file = path.join(dir, 'old.db');
    const initial = openDb(file, { withSeed: false });
    initial.exec(`DROP TABLE entries;
      CREATE TABLE entries (id TEXT PRIMARY KEY, title TEXT NOT NULL, content_md TEXT NOT NULL DEFAULT '',
        entry_date TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO entries (id,title,entry_date,created_at,updated_at) VALUES ('en_old','Ancienne','2026-01-05','','');`);
    initial.close();
    const migrated = openDb(file, { withSeed: false });
    try {
      const row = migrated.prepare('SELECT * FROM entries WHERE id=?').get('en_old');
      assert.equal(row.kind, 'note');
      assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      migrated.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
