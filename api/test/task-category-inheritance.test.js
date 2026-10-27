import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { TASK_CATEGORY_MIGRATION } from '../src/task-categories.js';
import { startApi, make } from './helpers.js';

describe('classement automatique des tâches liées', () => {
  let api, project, otherProject, first, second;
  before(async () => { api = await startApi(); });
  after(() => api.close());
  beforeEach(async () => {
    api.db.exec('DELETE FROM entries; DELETE FROM tasks; DELETE FROM projects; DELETE FROM sync_tombstones;');
    project = await make.project(api, 'Chantier');
    otherProject = await make.project(api, 'Ailleurs');
    first = (await api.post('/api/categories', { name: 'Devis', project_id: project.id })).body;
    second = (await api.post('/api/categories', { name: 'Livraison', project_id: project.id })).body;
  });
  const classification = (id) => api.db.prepare('SELECT category_id FROM tasks WHERE id=?').get(id).category_id;

  test('une liaison classe la tâche libre et préserve le classement existant et le projet', async () => {
    const note = await make.entry(api, { project_id: project.id, category_id: first.id });
    const task = await make.task(api, { project_id: project.id });
    const explicit = await make.task(api, { project_id: project.id, category_id: second.id });
    const foreign = await make.task(api, { project_id: otherProject.id });
    const unassigned = await make.task(api);
    for (const target of [task, explicit, foreign, unassigned]) {
      assert.equal((await api.post(`/api/tasks/${target.id}/documents/${note.id}`)).status, 201);
    }
    assert.equal(classification(task.id), first.id);
    assert.equal(classification(explicit.id), second.id);
    assert.equal(classification(foreign.id), null);
    assert.equal(classification(unassigned.id), null);
    const duplicate = await api.post(`/api/tasks/${task.id}/documents/${note.id}`);
    assert.equal(duplicate.status, 200);
    assert.equal(classification(task.id), first.id);
    const filtered = (await api.get(`/api/state?category_id=${first.id}`)).body;
    assert.deepEqual(filtered.tasks.map((row) => row.id), [task.id]);
    assert.equal(filtered.categories.find((row) => row.id === first.id).open_tasks, 1);
    const otherNote = await make.entry(api, { project_id: project.id, category_id: second.id });
    await api.post(`/api/tasks/${task.id}/documents/${otherNote.id}`);
    assert.equal(classification(task.id), first.id, 'une tâche classée ne change pas automatiquement de catégorie');
  });

  test('classer une entrée déjà liée remplit uniquement les tâches libres du même projet', async () => {
    const note = await make.entry(api, { project_id: project.id });
    const task = await make.task(api, { project_id: project.id });
    const explicit = await make.task(api, { project_id: project.id, category_id: second.id });
    const foreign = await make.task(api, { project_id: otherProject.id });
    for (const target of [task, explicit, foreign]) await api.post(`/api/tasks/${target.id}/documents/${note.id}`);
    assert.equal(classification(task.id), null);
    assert.equal((await api.put(`/api/entries/${note.id}`, { category_id: first.id })).status, 200);
    assert.equal(classification(task.id), first.id);
    assert.equal(classification(explicit.id), second.id);
    assert.equal(classification(foreign.id), null);
  });

  test('une tâche libre reste sans catégorie si ses documents sont classés différemment', async () => {
    const a = await make.entry(api, { project_id: project.id, category_id: first.id });
    const b = await make.entry(api, { project_id: project.id, category_id: second.id });
    const task = await make.task(api, { project_id: project.id });
    await api.post(`/api/tasks/${task.id}/documents/${a.id}`);
    api.db.prepare('UPDATE tasks SET category_id=NULL WHERE id=?').run(task.id);
    await api.post(`/api/tasks/${task.id}/documents/${b.id}`);
    assert.equal(classification(task.id), null);
    await api.put(`/api/entries/${b.id}`, { category_id: first.id });
    assert.equal(classification(task.id), first.id);
  });

  test('une erreur pendant l’héritage annule aussi le classement de l’entrée', async () => {
    const note = await make.entry(api, { project_id: project.id });
    const task = await make.task(api, { project_id: project.id });
    await api.post(`/api/tasks/${task.id}/documents/${note.id}`);
    api.db.exec(`CREATE TRIGGER reject_inherited_category BEFORE UPDATE OF category_id ON tasks
      WHEN NEW.category_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'classement indisponible'); END`);
    try {
      const result = await api.put(`/api/entries/${note.id}`, { category_id: first.id });
      assert.equal(result.status, 500);
      assert.equal((await api.get(`/api/entries/${note.id}`)).body.category_id, null);
      assert.equal(classification(task.id), null);
    } finally { api.db.exec('DROP TRIGGER reject_inherited_category'); }
  });
});

test('la migration remplit une fois les tâches existantes sans classement ambigu ni changement de projet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-inherited-categories-'));
  const file = path.join(dir, 'old.db');
  let db = openDb(file, { withSeed: false });
  try {
    db.exec(`INSERT INTO projects(id,name,created_at) VALUES('p','Projet','2026-10-01'),('q','Autre','2026-10-01');
      INSERT INTO categories(id,name,project_id,created_at,updated_at) VALUES
        ('a','Devis','p','2026-10-01','2026-10-01'),('b','Livraison','p','2026-10-01','2026-10-01');
      INSERT INTO entries(id,title,entry_date,project_id,category_id,created_at,updated_at) VALUES
        ('ea','A','2026-10-01','p','a','2026-10-01','2026-10-01'),
        ('eb','B','2026-10-01','p','b','2026-10-01','2026-10-01');
      INSERT INTO tasks(id,title,project_id,category_id,created_at,updated_at) VALUES
        ('unique','Unique','p',NULL,'2026-10-01','2026-10-01'),
        ('ambiguous','Ambigu','p',NULL,'2026-10-01','2026-10-01'),
        ('explicit','Choisi','p','b','2026-10-01','2026-10-01'),
        ('foreign','Autre projet','q',NULL,'2026-10-01','2026-10-01');
      INSERT INTO task_entries VALUES('unique','ea','2026-10-01'),('ambiguous','ea','2026-10-01'),
        ('ambiguous','eb','2026-10-01'),('explicit','ea','2026-10-01'),('foreign','ea','2026-10-01');`);
    db.prepare('DELETE FROM local_settings WHERE key=?').run(TASK_CATEGORY_MIGRATION);
    db.close(); db = null;
    db = openDb(file, { withSeed: false });
    const categories = () => Object.fromEntries(db.prepare('SELECT id,category_id FROM tasks').all().map((row) => [row.id, row.category_id]));
    assert.deepEqual(categories(), { unique: 'a', ambiguous: null, explicit: 'b', foreign: null });
    assert.notEqual(db.prepare("SELECT updated_at FROM tasks WHERE id='unique'").get().updated_at, '2026-10-01');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec("UPDATE tasks SET category_id=NULL WHERE id='unique'");
    db.close(); db = null;
    db = openDb(file, { withSeed: false });
    assert.equal(categories().unique, null, 'le choix Sans catégorie après migration reste conservé');
  } finally {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
