import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'worklogs.db');
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, pkey TEXT NOT NULL,
  color TEXT DEFAULT '#4f7cff', description TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
  type TEXT NOT NULL DEFAULT 'task',
  due_date TEXT, estimate_h REAL, position INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content_md TEXT DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, stored TEXT NOT NULL,
  mime TEXT DEFAULT '', size INTEGER DEFAULT 0,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  doc_id TEXT REFERENCES docs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(starts_at);
`);

export const uid = (p = '') =>
  p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const nowISO = () => new Date().toISOString();

function tableEmpty(t) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n === 0;
}

if (tableEmpty('projects')) {
  const t = nowISO();
  const ins = db.prepare(
    'INSERT INTO projects (id,name,pkey,color,description,created_at) VALUES (?,?,?,?,?,?)'
  );
  ins.run('pr_perso', 'Perso / Maison', 'PERSO', '#8b5cf6', 'Vie quotidienne, admin, maison', t);
  ins.run('pr_pro', 'Projets pro', 'PRO', '#0ea5e9', 'Missions, clients, dev', t);

  const ti = db.prepare(
    `INSERT INTO tasks (id,project_id,title,description,status,priority,type,due_date,estimate_h,position,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const plus = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  ti.run('t1', 'pr_perso', 'Installer WorkLogs en local', 'npm run install:all puis npm run dev', 'todo', 'high', 'story', plus(2), 2, 0, t, t);
  ti.run('t2', 'pr_perso', 'Trier la boîte mail', '', 'todo', 'medium', 'task', plus(1), 1, 1, t, t);
  ti.run('t3', 'pr_pro', 'Bug: export PDF cassé', 'Reproduire puis corriger', 'in_progress', 'urgent', 'bug', plus(0), 3, 0, t, t);
  ti.run('t4', 'pr_pro', 'Epic: refonte suivi client', 'Découper en stories', 'todo', 'high', 'epic', plus(14), 20, 1, t, t);
  ti.run('t5', 'pr_pro', 'Relire devis client', '', 'review', 'medium', 'task', plus(-1), 1, 0, t, t);

  db.prepare(
    `INSERT INTO events (id,title,description,starts_at,ends_at,project_id,created_at) VALUES (?,?,?,?,?,?,?)`
  ).run('e1', 'Point hebdo organisation', 'Revue kanban + agenda', new Date(Date.now() + 864e5).toISOString(), new Date(Date.now() + 864e5 + 36e5).toISOString(), 'pr_pro', t);

  db.prepare(
    `INSERT INTO docs (id,title,content_md,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`
  ).run('d1', 'Bienvenue dans WorkLogs', '# Bienvenue\n\n- **Kanban** : glisser-déposer entre colonnes.\n- **Todos** : inbox rapide.\n- **Agenda** : événements liés aux tâches.\n- **Fichiers** : tout au même endroit.\n', 'pr_perso', t, t);
  console.log('[db] seed initial inséré');
}
console.log('[db] SQLite prêt :', DB_PATH);
