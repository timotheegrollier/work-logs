import { normalizeTaskNotes } from './task-notes.js';

/** Migration au démarrage, ou réconciliation pendant l'import d'une boîte mobile. */
export function migrateTaskNotes(db, { reconcile = false } = {}) {
  if (!reconcile && !db.prepare('SELECT 1 FROM tasks WHERE entry_id IS NULL LIMIT 1').get()) return { entries: 0, links: 0 };
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN IMMEDIATE');
  try {
    const entries = db.prepare('SELECT * FROM entries').all();
    const tasks = db.prepare('SELECT * FROM tasks').all();
    const task_entries = db.prepare('SELECT * FROM task_entries').all();
    const data = normalizeTaskNotes({
      entries, tasks, task_entries, google_documents: db.prepare('SELECT entry_id FROM google_documents').all(),
    });
    const originalEntries = new Map(entries.map((entry) => [entry.id, entry]));
    const insertEntry = db.prepare(`INSERT INTO entries
      (id,title,content_md,entry_date,project_id,category_id,archived,kind,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const updateEntry = db.prepare('UPDATE entries SET status=?, category_id=? WHERE id=?');
    let added = 0;
    for (const note of data.entries) {
      const original = originalEntries.get(note.id);
      if (!original) {
        insertEntry.run(note.id, note.title, note.content_md, note.entry_date, note.project_id, note.category_id,
          note.archived, note.kind, note.status, note.created_at, note.updated_at);
        added++;
      } else if (note !== original) updateEntry.run(note.status, note.category_id ?? null, note.id);
    }
    const updateTask = db.prepare('UPDATE tasks SET entry_id=?, progress=?, title=?, project_id=?, category_id=? WHERE id=?');
    for (const [index, task] of data.tasks.entries()) {
      if (task !== tasks[index]) updateTask.run(task.entry_id, task.progress, task.title, task.project_id, task.category_id ?? null, task.id);
    }
    const insertLink = db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)');
    for (const link of data.task_entries.slice(task_entries.length)) insertLink.run(link.task_id, link.entry_id, link.created_at);
    if (own) db.exec('COMMIT');
    return { entries: added, links: data.task_entries.length - task_entries.length };
  } catch (error) {
    if (own) db.exec('ROLLBACK');
    throw error;
  }
}
