import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { startApi, make } from './helpers.js';

describe('catégories et sous-catégories de projet', () => {
  let api, project, otherProject;
  before(async () => { api = await startApi(); });
  after(() => api.close());
  beforeEach(async () => {
    api.db.exec('DELETE FROM entries; DELETE FROM tasks; DELETE FROM projects; DELETE FROM sync_tombstones;');
    project = await make.project(api, 'Projet A');
    otherProject = await make.project(api, 'Projet B');
  });
  const category = async (name, extra = {}) => {
    const result = await api.post('/api/categories', { name, project_id: project.id, ...extra });
    assert.equal(result.status, 201, result.body.error);
    return result.body;
  };

  test('crée une hiérarchie colorée et la conserve dans tous les filtres de projet', async () => {
    const parent = await category('Objectifs', { color: '#15803d' });
    const child = await category('Octobre', { parent_id: parent.id });
    const foreign = await category('Autre projet', { project_id: otherProject.id });
    assert.equal(parent.color, '#15803d');
    assert.equal(child.parent_id, parent.id);
    assert.equal(child.color, '#64748b');
    assert.equal(child.created_at, child.updated_at);
    const state = (await api.get(`/api/state?project_id=${project.id}`)).body;
    assert.deepEqual(state.categories.map((row) => row.id).sort(), [parent.id, child.id, foreign.id].sort());
  });

  test('renomme, recolore et regroupe une catégorie sous une autre', async () => {
    const parent = await category('Objectifs');
    const child = await category('Notes');
    const result = await api.put(`/api/categories/${child.id}`, { name: 'Décisions', color: '#0369a1', parent_id: parent.id });
    assert.equal(result.status, 200);
    assert.equal(result.body.name, 'Décisions');
    assert.equal(result.body.color, '#0369a1');
    assert.equal(result.body.parent_id, parent.id);
    assert.equal((await api.put(`/api/categories/${child.id}`, { parent_id: '' })).body.parent_id, null);
    assert.equal((await api.put(`/api/categories/${child.id}`, {})).body.name, 'Décisions');
  });

  test('refuse noms, couleurs, projets et parents invalides sans créer de catégorie', async () => {
    const foreign = await category('Ailleurs', { project_id: otherProject.id });
    for (const extra of [
      { name: ' ' }, { name: 'x'.repeat(101) }, { color: 'rouge' }, { color: '' },
      { project_id: null }, { project_id: 'absent' }, { parent_id: 'absent' },
      { parent_id: foreign.id }, { parent_id: 3 },
    ]) {
      const result = await api.post('/api/categories', { name: 'Refusée', project_id: project.id, ...extra });
      assert.equal(result.status, 400, JSON.stringify(extra));
      assert.equal(typeof result.body.error, 'string');
    }
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM categories').get().n, 1);
  });

  test('interdit les cycles à toute profondeur et le changement de projet', async () => {
    const parent = await category('A');
    const child = await category('B', { parent_id: parent.id });
    const grandchild = await category('C', { parent_id: child.id });
    for (const parentId of [parent.id, child.id, grandchild.id]) {
      assert.equal((await api.put(`/api/categories/${parent.id}`, { parent_id: parentId })).status, 400);
    }
    assert.equal((await api.put(`/api/categories/${child.id}`, { project_id: otherProject.id })).status, 400);
    assert.equal((await api.put(`/api/categories/${parent.id}`, { name: '' })).status, 400);
    assert.equal((await api.put(`/api/categories/${parent.id}`, { color: '#fff' })).status, 400);
    assert.equal(api.db.prepare('SELECT parent_id FROM categories WHERE id=?').get(parent.id).parent_id, null);
  });

  test('classe tâches et entrées, et renvoie la catégorie dans les résumés et liens', async () => {
    const group = await category('Documents');
    const entry = await make.entry(api, { project_id: project.id, category_id: group.id });
    const task = await make.task(api, { project_id: project.id, category_id: group.id });
    await api.post(`/api/tasks/${task.id}/documents/${entry.id}`);
    assert.equal(entry.category_id, group.id);
    assert.equal(task.category_id, group.id);
    const state = (await api.get('/api/state')).body;
    assert.equal(state.entries[0].category_id, group.id);
    assert.equal(state.tasks[0].documents[0].category_id, group.id);
    assert.equal(state.categories[0].entries, 1);
    assert.equal(state.categories[0].open_tasks, 1);
    await api.put(`/api/tasks/${task.id}`, { status: 'done' });
    assert.equal((await api.get('/api/state')).body.categories[0].open_tasks, 0);
  });

  test('refuse le classement hors projet à la création et à la modification', async () => {
    const group = await category('Projet A');
    for (const kind of ['entries', 'tasks']) {
      for (const projectId of [null, otherProject.id]) {
        const result = await api.post(`/api/${kind}`, { title: 'Refusée', project_id: projectId, category_id: group.id });
        assert.equal(result.status, 400);
      }
      assert.equal((await api.post(`/api/${kind}`, { title: 'Refusée', project_id: project.id, category_id: 'absente' })).status, 400);
      const row = (await api.post(`/api/${kind}`, { title: 'À classer', project_id: otherProject.id })).body;
      assert.equal((await api.put(`/api/${kind}/${row.id}`, { category_id: group.id })).status, 400);
      assert.equal(api.db.prepare(`SELECT category_id FROM ${kind} WHERE id=?`).get(row.id).category_id, null);
    }
  });

  test('conserve le classement sur une retouche, le libère sur changement de projet et accepte le vide', async () => {
    const group = await category('Travail');
    const other = await category('Maison', { project_id: otherProject.id });
    for (const kind of ['entries', 'tasks']) {
      const row = (await api.post(`/api/${kind}`, { title: 'Classée', project_id: project.id, category_id: group.id })).body;
      assert.equal((await api.put(`/api/${kind}/${row.id}`, { title: 'Retouchée' })).body.category_id, group.id);
      assert.equal((await api.put(`/api/${kind}/${row.id}`, { project_id: otherProject.id })).body.category_id, null);
      assert.equal((await api.put(`/api/${kind}/${row.id}`, { category_id: other.id })).body.category_id, other.id);
      assert.equal((await api.put(`/api/${kind}/${row.id}`, { category_id: '' })).body.category_id, null);
      assert.equal((await api.put(`/api/${kind}/${row.id}`, { project_id: project.id, category_id: group.id })).body.category_id, group.id);
    }
  });

  test('filtre une catégorie avec tous ses descendants et cumule recherche/projet', async () => {
    const parent = await category('Objectifs');
    const child = await category('Semaine', { parent_id: parent.id });
    const grandchild = await category('Lundi', { parent_id: child.id });
    const unrelated = await category('Hors groupe');
    for (const [index, group] of [parent, child, grandchild, unrelated].entries()) {
      await make.entry(api, { title: `Plan ${index}`, project_id: project.id, category_id: group.id, kind: 'procedure' });
      await make.task(api, { title: `Plan ${index}`, project_id: project.id, category_id: group.id });
    }
    const state = (await api.get(`/api/state?category_id=${parent.id}`)).body;
    assert.equal(state.entries.length, 3);
    assert.equal(state.tasks.length, 3);
    const searched = (await api.get(`/api/state?category_id=${parent.id}&project_id=${project.id}&q=Plan%202`)).body;
    assert.deepEqual(searched.entries.map((row) => row.title), ['Plan 2']);
    assert.deepEqual(searched.tasks.map((row) => row.title), ['Plan 2']);
    assert.equal((await api.get(`/api/state?category_id=${parent.id}&project_id=${otherProject.id}`)).body.entries.length, 0);
    assert.equal((await api.get('/api/state?category_id=absente')).body.entries.length, 0);
  });

  test('sans catégorie filtre les tâches, les entrées et les pièces des procédures', async () => {
    const group = await category('Documents');
    const classified = await make.entry(api, { title: 'Classée', project_id: project.id, category_id: group.id, kind: 'procedure' });
    const unclassified = await make.entry(api, { title: 'Libre', project_id: project.id, kind: 'procedure' });
    await make.task(api, { title: 'Classée', project_id: project.id, category_id: group.id });
    await make.task(api, { title: 'Libre', project_id: project.id });
    await api.upload('classée.txt', 'Texte', { entry_id: classified.id });
    await api.upload('libre.txt', 'Texte', { entry_id: unclassified.id });
    const state = (await api.get(`/api/state?category_id=__none__&project_id=${project.id}`)).body;
    assert.deepEqual(state.entries.map((row) => row.id), [unclassified.id]);
    assert.deepEqual(state.tasks.map((row) => row.title), ['Libre']);
    assert.deepEqual(state.procedure_attachments.map((row) => row.filename), ['libre.txt']);
    assert.equal((await api.get(`/api/state?category_id=${group.id}`)).body.procedure_attachments[0].filename, 'classée.txt');
  });

  test('hérite du classement dans les copies et créations liées réciproques', async () => {
    const group = await category('À préparer');
    const entry = await make.entry(api, { project_id: project.id, category_id: group.id });
    const copy = await api.post(`/api/entries/${entry.id}/copy`, {});
    assert.equal(copy.status, 201);
    assert.equal(copy.body.category_id, group.id);
    const task = await api.post(`/api/entries/${entry.id}/task`, {});
    assert.equal(task.status, 201);
    assert.equal(task.body.category_id, group.id);
    assert.equal(task.body.documents[0].category_id, group.id);
    const linked = await api.post(`/api/tasks/${task.body.id}/entry`, {});
    assert.equal(linked.status, 201);
    assert.equal(linked.body.category_id, group.id);
  });

  test('supprime un regroupement sans perdre ses enfants ni son contenu', async () => {
    const parent = await category('Parent');
    const removed = await category('Intermédiaire', { parent_id: parent.id });
    const child = await category('Enfant', { parent_id: removed.id });
    const entry = await make.entry(api, { project_id: project.id, category_id: removed.id });
    const task = await make.task(api, { project_id: project.id, category_id: removed.id });
    assert.equal((await api.del(`/api/categories/${removed.id}`)).status, 200);
    assert.equal(api.db.prepare('SELECT parent_id FROM categories WHERE id=?').get(child.id).parent_id, parent.id);
    assert.equal((await api.get(`/api/entries/${entry.id}`)).body.category_id, parent.id);
    assert.equal(api.db.prepare('SELECT category_id FROM tasks WHERE id=?').get(task.id).category_id, parent.id);
    assert.equal(api.db.prepare("SELECT COUNT(*) n FROM sync_tombstones WHERE kind='category' AND id=?").get(removed.id).n, 1);
    await api.del(`/api/categories/${parent.id}`);
    assert.equal((await api.get(`/api/entries/${entry.id}`)).body.category_id, null);
    assert.equal(api.db.prepare('SELECT parent_id FROM categories WHERE id=?').get(child.id).parent_id, null);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 1);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 1);
    assert.deepEqual(api.db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  test('supprime un projet en conservant son contenu et en propageant les suppressions de catégories', async () => {
    const parent = await category('Parent');
    const child = await category('Enfant', { parent_id: parent.id });
    const entry = await make.entry(api, { project_id: project.id, category_id: child.id });
    const task = await make.task(api, { project_id: project.id, category_id: parent.id });
    assert.equal((await api.del(`/api/projects/${project.id}`)).status, 200);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM categories').get().n, 0);
    const savedEntry = (await api.get(`/api/entries/${entry.id}`)).body;
    assert.equal(savedEntry.project_id, null);
    assert.equal(savedEntry.category_id, null);
    assert.equal(api.db.prepare('SELECT project_id FROM tasks WHERE id=?').get(task.id).project_id, null);
    assert.equal(api.db.prepare("SELECT COUNT(*) n FROM sync_tombstones WHERE kind='category'").get().n, 2);
    assert.deepEqual(api.db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  test('renvoie 404 pour les modifications et suppressions inconnues', async () => {
    assert.equal((await api.put('/api/categories/absente', { name: 'Renommée' })).status, 404);
    assert.equal((await api.del('/api/categories/absente')).status, 404);
  });
});

test('migration additive du classement sur une ancienne base V2, réouvrable sans perte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-category-migration-'));
  const file = path.join(dir, 'old.db');
  const initial = new DatabaseSync(file);
  initial.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE entries(id TEXT PRIMARY KEY,title TEXT NOT NULL,content_md TEXT NOT NULL DEFAULT '',entry_date TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'todo',due_date TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL DEFAULT 0,project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO projects VALUES('pr_old','Ancien','#64748b','2026-10-01');
    INSERT INTO entries VALUES('en_old','Notes','Texte gardé','2026-10-01','pr_old','2026-10-01','2026-10-01');
    INSERT INTO tasks(id,title,project_id,created_at,updated_at) VALUES('tk_old','Objectif','pr_old','2026-10-01','2026-10-01');`);
  initial.close();
  let migrated;
  try {
    migrated = openDb(file, { withSeed: false });
    assert.equal(migrated.prepare('SELECT category_id FROM entries').get().category_id, null);
    assert.equal(migrated.prepare('SELECT content_md FROM entries').get().content_md, 'Texte gardé');
    assert.equal(migrated.prepare('SELECT category_id FROM tasks').get().category_id, null);
    assert.equal(migrated.prepare('SELECT COUNT(*) n FROM categories').get().n, 0);
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    migrated.close();
    migrated = openDb(file, { withSeed: false });
    assert.equal(migrated.prepare('SELECT COUNT(*) n FROM entries').get().n, 1);
  } finally {
    migrated?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
