import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

/** Recrée à l'identique une base WorkLogs V1 remplie, pour vérifier la reprise. */
function writeV1Database(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pkey TEXT NOT NULL,
      color TEXT DEFAULT '#4f7cff', description TEXT DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
      type TEXT NOT NULL DEFAULT 'task', due_date TEXT, estimate_h REAL,
      position INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, created_at TEXT NOT NULL);
    CREATE TABLE docs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content_md TEXT DEFAULT '',
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, stored TEXT NOT NULL,
      mime TEXT DEFAULT '', size INTEGER DEFAULT 0,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      doc_id TEXT REFERENCES docs(id) ON DELETE SET NULL, created_at TEXT NOT NULL);

    INSERT INTO projects VALUES
      ('pr_perso','Perso / Maison','PERSO','#8b5cf6','Vie quotidienne','2026-01-02T09:00:00.000Z'),
      ('pr_pro','Projets pro','PRO','','Missions','2026-01-02T09:00:00.000Z');

    INSERT INTO tasks VALUES
      ('t1','pr_perso',NULL,'Tâche à faire','','todo','medium','task','2026-02-01',2,0,'2026-01-03T09:00:00.000Z','2026-01-03T09:00:00.000Z'),
      ('t2','pr_pro',NULL,'Bug urgent','Reproduire puis corriger','in_progress','urgent','bug',NULL,3,0,'2026-01-04T09:00:00.000Z','2026-01-04T09:00:00.000Z'),
      ('t3','pr_pro',NULL,'En relecture','','review','high','story',NULL,NULL,1,'2026-01-05T09:00:00.000Z','2026-01-05T09:00:00.000Z'),
      ('t4',NULL,NULL,'Déjà finie','','done','low','task',NULL,NULL,0,'2026-01-06T09:00:00.000Z','2026-01-06T09:00:00.000Z');

    INSERT INTO events VALUES
      ('e1','Point hebdo','Revue kanban','2026-03-10T08:00:00.000Z','2026-03-10T09:00:00.000Z',NULL,'pr_pro','2026-01-07T09:00:00.000Z');

    INSERT INTO docs VALUES
      ('d1','Bienvenue','# Bienvenue\n\ntexte','pr_perso',NULL,'2026-01-08T09:00:00.000Z','2026-01-09T09:00:00.000Z');

    INSERT INTO attachments VALUES
      ('a1','devis.pdf','abc_devis.pdf','application/pdf',1024,NULL,NULL,'d1','2026-01-10T09:00:00.000Z'),
      ('a2','photo.jpg','abc_photo.jpg','image/jpeg',2048,NULL,'t1',NULL,'2026-01-10T09:00:00.000Z');
  `);
  db.close();
}

describe('migration V1 → V2', () => {
  let dir;
  let db;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-v1-'));
    const file = path.join(dir, 'worklogs.db');
    writeV1Database(file);
    db = openDb(file);
  });
  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const all = (sql) => db.prepare(sql).all();
  const one = (sql) => db.prepare(sql).get();

  test('les anciennes tables ont disparu', () => {
    const tables = all("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
    for (const gone of ['docs', 'events', 'projects_v1', 'tasks_v1', 'attachments_v1']) {
      assert.equal(tables.includes(gone), false, `${gone} devrait être supprimée`);
    }
    assert.deepEqual(
      ['attachments', 'entries', 'projects', 'task_entries', 'tasks'].filter((t) => tables.includes(t)).sort(),
      ['attachments', 'entries', 'projects', 'task_entries', 'tasks']
    );
  });

  test('les clés étrangères pointent toujours vers les bonnes tables', () => {
    assert.deepEqual(
      db.prepare('PRAGMA foreign_key_list(entries)').all().map((f) => f.table),
      ['projects'],
      'entries.project_id ne doit pas pointer vers projects_v1'
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(tasks)').all().map((f) => f.table), ['projects']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(attachments)').all().map((f) => f.table), ['entries']);
    assert.deepEqual(
      db.prepare('PRAGMA foreign_key_list(task_entries)').all().map((f) => f.table).sort(),
      ['entries', 'tasks']
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'aucune référence cassée');
  });

  test('les projets gardent nom et couleur, perdent la clé Jira', () => {
    const projects = all('SELECT * FROM projects ORDER BY name');
    assert.deepEqual(projects.map((p) => p.name), ['Perso / Maison', 'Projets pro']);
    assert.equal(projects[0].color, '#8b5cf6');
    assert.equal(projects[1].color, '#4f7cff', 'une couleur vide reprend la valeur par défaut');
    assert.equal('pkey' in projects[0], false);
  });

  test('les statuts Jira se replient sur trois colonnes', () => {
    const byId = Object.fromEntries(all('SELECT * FROM tasks').map((t) => [t.id, t]));
    assert.equal(byId.t1.status, 'todo');
    assert.equal(byId.t2.status, 'doing', 'in_progress → doing');
    assert.equal(byId.t3.status, 'doing', 'review → doing');
    assert.equal(byId.t4.status, 'done');
  });

  test('les priorités hautes deviennent des épingles', () => {
    const byId = Object.fromEntries(all('SELECT * FROM tasks').map((t) => [t.id, t]));
    assert.equal(byId.t2.pinned, 1, 'urgent → épinglée');
    assert.equal(byId.t3.pinned, 1, 'high → épinglée');
    assert.equal(byId.t1.pinned, 0, 'medium → normale');
    assert.equal(byId.t4.pinned, 0, 'low → normale');
    assert.equal(byId.t1.due_date, '2026-02-01', 'l’échéance est conservée');
    assert.equal(byId.t1.project_id, 'pr_perso', 'le projet est conservé');
  });

  test('les docs deviennent des entrées datées', () => {
    const doc = one("SELECT * FROM entries WHERE id='d1'");
    assert.equal(doc.title, 'Bienvenue');
    assert.match(doc.content_md, /# Bienvenue/);
    assert.equal(doc.entry_date, '2026-01-08', 'daté de sa création');
    assert.equal(doc.project_id, 'pr_perso');
  });

  test('les événements de l’agenda deviennent des entrées à leur date', () => {
    const event = one("SELECT * FROM entries WHERE id='e1'");
    assert.equal(event.title, 'Point hebdo');
    assert.equal(event.content_md, 'Revue kanban');
    assert.equal(event.entry_date, '2026-03-10', 'daté du jour de l’événement');
  });

  test('les descriptions de tâches sont sauvées en entrées', () => {
    const saved = one("SELECT * FROM entries WHERE id='en_t2'");
    assert.equal(saved.title, 'Bug urgent');
    assert.equal(saved.content_md, 'Reproduire puis corriger');
    assert.equal(
      one("SELECT COUNT(*) n FROM entries WHERE id='en_t1'").n,
      0,
      'pas d’entrée vide pour une tâche sans description'
    );
  });

  test('les pièces jointes suivent leur doc, les autres sont détachées', () => {
    const byId = Object.fromEntries(all('SELECT * FROM attachments').map((a) => [a.id, a]));
    assert.equal(byId.a1.entry_id, 'd1', 'la pièce jointe du doc suit l’entrée');
    assert.equal(byId.a1.filename, 'devis.pdf');
    assert.equal(byId.a2.entry_id, null, 'celle d’une tâche est conservée mais détachée');
  });

  test('l’amorçage ne réécrit pas par-dessus les données reprises', () => {
    assert.equal(one('SELECT COUNT(*) n FROM projects').n, 2);
    assert.equal(one("SELECT COUNT(*) n FROM entries WHERE id='en_welcome'").n, 0);
  });

  test('crée l’index de recherche des associations', () => {
    assert.equal(
      one("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_task_entries_entry'").n,
      1
    );
  });

  test('rouvrir la base migrée ne change plus rien', () => {
    const counts = () =>
      ['projects', 'entries', 'tasks', 'attachments'].map((t) => one(`SELECT COUNT(*) n FROM ${t}`).n);
    const before = counts();
    db.close();
    db = openDb(path.join(dir, 'worklogs.db'));
    assert.deepEqual(counts(), before);
  });
});
