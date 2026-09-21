import { nowISO } from './db.js';
import { decodeEntry } from './rich-document.js';
import { BACKUP_VERSION, validateBackup } from './backup-format.js';
export { BACKUP_NAME, BACKUP_VERSION, MAX_BACKUP_BYTES, validateBackup } from './backup-format.js';

/** Le format commun au téléchargement local et à la sauvegarde Drive. */
export function buildBackup(db) {
  const attachments = db.prepare('SELECT * FROM attachments ORDER BY entry_id, created_at, id').all()
    .map((row) => ({
      ...row,
      driveFileId: row.drive_file_id || null,
    }));
  // `drive_file_id` (SQL) ne sort jamais tel quel : l'API et le JSON parlent
  // `driveFileId` (comme la boîte mobile), la base garde le snake_case.
  for (const row of attachments) delete row.drive_file_id;
  return {
    version: BACKUP_VERSION,
    exported_at: nowISO(),
    projects: db.prepare('SELECT * FROM projects ORDER BY name, id').all(),
    entries: db.prepare('SELECT * FROM entries ORDER BY entry_date DESC, updated_at DESC, id').all().map(decodeEntry),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY status, position, id').all(),
    task_entries: db.prepare('SELECT * FROM task_entries ORDER BY task_id, entry_id').all(),
    google_documents: db.prepare('SELECT * FROM google_documents ORDER BY document_id, tab_order, entry_id').all(),
    attachments,
  };
}

/** Remplacement complet transactionnel ; les fichiers joints ne sont pas inclus dans le JSON. */
export function restoreBackup(db, input) {
  const data = validateBackup(input);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM task_entries; DELETE FROM google_documents; DELETE FROM attachments; DELETE FROM tasks; DELETE FROM entries; DELETE FROM projects;');
    const project = db.prepare('INSERT INTO projects (id,name,color,created_at) VALUES (?,?,?,?)');
    for (const value of data.projects) project.run(value.id, value.name, value.color, value.created_at);
    const entry = db.prepare('INSERT INTO entries (id,title,content_md,content_json,entry_date,project_id,archived,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const value of data.entries) entry.run(value.id, value.title, value.content_md, value.content_json ? JSON.stringify(value.content_json) : null, value.entry_date, value.project_id, value.archived, value.kind, value.created_at, value.updated_at);
    const task = db.prepare('INSERT INTO tasks (id,title,status,due_date,pinned,position,priority,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const value of data.tasks) task.run(value.id, value.title, value.status, value.due_date, value.pinned, value.position, value.priority, value.project_id, value.created_at, value.updated_at);
    const google = db.prepare(`INSERT INTO google_documents
      (entry_id,document_id,tab_id,revision_id,synced_content_json,synced_at,document_title,tab_title,tab_order,tab_depth,readonly_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const value of data.google_documents) google.run(value.entry_id, value.document_id, value.tab_id, value.revision_id, value.synced_content_json, value.synced_at, value.document_title, value.tab_title, value.tab_order, value.tab_depth, value.readonly_reason);
    const attachment = db.prepare('INSERT INTO attachments (id,filename,stored,mime,size,entry_id,created_at,drive_file_id) VALUES (?,?,?,?,?,?,?,?)');
    for (const value of data.attachments) attachment.run(value.id, value.filename, value.stored, value.mime, value.size, value.entry_id, value.created_at, value.driveFileId || '');
    const link = db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)');
    for (const value of data.task_entries) link.run(value.task_id, value.entry_id, value.created_at);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, projects: data.projects.length, entries: data.entries.length, tasks: data.tasks.length };
}
