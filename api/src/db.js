import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

export const uid = (p = '') =>
  p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const nowISO = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4f7cff',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',
  entry_date TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  due_date TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  stored TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_entries (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, entry_id)
);
`;

// Séparés des tables : ils portent sur des colonnes V2, donc ne peuvent être
// créés qu'une fois la migration terminée.
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, position);
CREATE INDEX IF NOT EXISTS idx_attachments_entry ON attachments(entry_id);
CREATE INDEX IF NOT EXISTS idx_task_entries_entry ON task_entries(entry_id);
`;

const hasTable = (db, name) =>
  !!db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?").get(name);
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
/**
 * Migration V1 → V2 : le schéma V1 (projets à clé, tâches façon Jira, docs,
 * events) devient projects/entries/tasks/attachments. Rien n'est perdu — tout
 * texte saisi (doc, description d'événement ou de tâche) devient une entrée
 * de journal datée.
 *
 * `legacy_alter_table` est indispensable : sans lui, `ALTER TABLE … RENAME TO`
 * réécrit aussi les clauses REFERENCES des autres tables, qui pointeraient
 * alors vers `projects_v1` au lieu de `projects`.
 */
function migrate(db) {
  const oldProjects = hasTable(db, 'projects') && columns(db, 'projects').includes('pkey');
  const oldTasks = hasTable(db, 'tasks') && columns(db, 'tasks').includes('type');
  const oldAttachments = hasTable(db, 'attachments') && columns(db, 'attachments').includes('doc_id');
  const oldDocs = hasTable(db, 'docs');
  const oldEvents = hasTable(db, 'events');
  if (!oldProjects && !oldTasks && !oldAttachments && !oldDocs && !oldEvents) return;

  db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;');

  // Les projets d'abord : les autres tables y font référence.
  if (oldProjects) {
    db.exec('ALTER TABLE projects RENAME TO projects_v1');
    db.exec(SCHEMA);
    db.exec(`INSERT INTO projects (id,name,color,created_at)
             SELECT id, name, COALESCE(NULLIF(color,''),'#4f7cff'), created_at FROM projects_v1`);
    db.exec('DROP TABLE projects_v1');
  }
  db.exec(SCHEMA);

  if (oldDocs) {
    db.exec(`INSERT OR IGNORE INTO entries (id,title,content_md,entry_date,project_id,created_at,updated_at)
             SELECT id, title, COALESCE(content_md,''), substr(created_at,1,10), project_id, created_at, updated_at
             FROM docs`);
  }
  // L'agenda a été retiré : chaque événement devient une entrée à sa date.
  if (oldEvents) {
    db.exec(`INSERT OR IGNORE INTO entries (id,title,content_md,entry_date,project_id,created_at,updated_at)
             SELECT id, title, COALESCE(description,''), substr(starts_at,1,10), project_id, created_at, created_at
             FROM events`);
  }
  // Les tâches perdent leur description : on la sauve en entrée plutôt que de la jeter.
  if (oldTasks) {
    db.exec(`INSERT OR IGNORE INTO entries (id,title,content_md,entry_date,project_id,created_at,updated_at)
             SELECT 'en_' || id, title, description, substr(created_at,1,10), project_id, created_at, updated_at
             FROM tasks WHERE description IS NOT NULL AND trim(description) != ''`);

    db.exec('ALTER TABLE tasks RENAME TO tasks_v1');
    db.exec(SCHEMA);
    db.exec(`INSERT INTO tasks (id,title,status,due_date,pinned,position,project_id,created_at,updated_at)
             SELECT id, title,
                    CASE status WHEN 'done' THEN 'done' WHEN 'todo' THEN 'todo' ELSE 'doing' END,
                    due_date,
                    CASE WHEN priority IN ('high','urgent') THEN 1 ELSE 0 END,
                    position, project_id, created_at, updated_at
             FROM tasks_v1`);
    db.exec('DROP TABLE tasks_v1');
  }
  // attachments V1 : liés à un projet, une tâche ou un doc → liés à une entrée.
  // Ceux qui pendaient à une tâche ou un projet finissent non rattachés (entry_id NULL).
  if (oldAttachments) {
    db.exec('ALTER TABLE attachments RENAME TO attachments_v1');
    db.exec(SCHEMA);
    db.exec(`INSERT INTO attachments (id,filename,stored,mime,size,entry_id,created_at)
             SELECT a.id, a.filename, a.stored, COALESCE(a.mime,''), COALESCE(a.size,0),
                    (SELECT e.id FROM entries e WHERE e.id = a.doc_id), a.created_at
             FROM attachments_v1 a`);
    db.exec('DROP TABLE attachments_v1');
  }
  if (oldDocs) db.exec('DROP TABLE docs');
  if (oldEvents) db.exec('DROP TABLE events');

  db.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
  console.log('[worklogs] base migrée V1 → V2');
}

function seed(db) {
  if (db.prepare('SELECT COUNT(*) n FROM projects').get().n > 0) return;
  const t = nowISO();
  const d = today();
  const ins = db.prepare('INSERT INTO projects (id,name,color,created_at) VALUES (?,?,?,?)');
  ins.run('pr_perso', 'Perso', '#8b5cf6', t);
  ins.run('pr_pro', 'Pro', '#0ea5e9', t);

  db.prepare(
    'INSERT INTO entries (id,title,content_md,entry_date,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(
    'en_welcome',
    'Comment ça marche',
    [
      '## Écrire',
      '',
      'Une **entrée** = un compte-rendu, une note, une décision. Le texte est en Markdown,',
      "l'aperçu se met à jour pendant que tu écris.",
      '',
      '| Tu tapes | Tu obtiens |',
      '| --- | --- |',
      '| `## Titre` | un titre de section |',
      '| `**gras**` | du **gras** |',
      '| `- item` | une liste à puces |',
      '| `- [ ] item` | une case à cocher |',
      '',
      '> Astuce : `Ctrl + S` enregistre, `Ctrl + P` imprime l\'entrée en PDF propre.',
      '',
      '## Organiser',
      '',
      'La colonne de droite tient les tâches en cours. Glisse une carte pour la faire avancer.',
      'Les deux colonnes partagent les mêmes **projets** : filtre à gauche, tout suit.',
    ].join('\n'),
    d,
    'pr_perso',
    t,
    t
  );

  const ti = db.prepare(
    'INSERT INTO tasks (id,title,status,due_date,pinned,position,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const plus = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  ti.run('tk_1', 'Écrire ma première entrée', 'todo', plus(0), 1, 0, 'pr_perso', t, t);
  ti.run('tk_2', 'Créer mes projets', 'todo', null, 0, 1, 'pr_perso', t, t);
  ti.run('tk_3', 'Prendre en main WorkLogs', 'doing', null, 0, 0, 'pr_pro', t, t);
}

export function openDb(dbPath, { withSeed = true } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  db.exec(SCHEMA);
  db.exec(INDEXES);
  // Migration additive V2 : les entrées Markdown et leurs pièces jointes restent intactes.
  if (!columns(db, 'entries').includes('content_json')) db.exec('ALTER TABLE entries ADD COLUMN content_json TEXT');
  const googleSchema = `CREATE TABLE IF NOT EXISTS google_documents (
    entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL,
    tab_id TEXT NOT NULL DEFAULT '',
    revision_id TEXT NOT NULL,
    synced_content_json TEXT NOT NULL,
    synced_at TEXT,
    UNIQUE(document_id, tab_id)
  )`;
  if (hasTable(db, 'google_documents') && !columns(db, 'google_documents').includes('tab_id')) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE google_documents RENAME TO google_documents_previous');
      db.exec(googleSchema);
      db.exec(`INSERT INTO google_documents (entry_id,document_id,revision_id,synced_content_json,synced_at)
        SELECT entry_id,document_id,revision_id,synced_content_json,synced_at FROM google_documents_previous`);
      db.exec('DROP TABLE google_documents_previous; COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } else db.exec(googleSchema);
  // Ajouts additifs : pas de reconstruction de table, donc aucun risque sur les
  // clés étrangères. Ils portent les libellés nécessaires pour regrouper les
  // onglets d'un même document Google sous une seule entrée du journal.
  for (const [name, definition] of [
    ['document_title', "TEXT NOT NULL DEFAULT ''"],
    ['tab_title', "TEXT NOT NULL DEFAULT ''"],
    ['tab_order', 'INTEGER NOT NULL DEFAULT 0'],
    ['tab_depth', 'INTEGER NOT NULL DEFAULT 0'],
    ['readonly_reason', "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!columns(db, 'google_documents').includes(name)) {
      db.exec(`ALTER TABLE google_documents ADD COLUMN ${name} ${definition}`);
    }
  }
  db.exec('PRAGMA foreign_keys = ON;');
  if (withSeed) seed(db);
  return db;
}
