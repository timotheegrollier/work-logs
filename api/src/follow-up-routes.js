import { nowISO } from './db.js';
import { buildFollowUpSource, decodeFollowUpRow, followUpKey, readFollowUp, updateFollowUp } from './follow-up.js';

/** Lecture des sources explicites, sans accès réseau ni lecture de pièces jointes. */
export function createFollowUpAccess(db) {
  const snapshot = (kind, id) => {
    const table = kind === 'entry' ? 'entries' : kind === 'task' ? 'tasks' : null;
    if (!table) throw Object.assign(new Error('type de suivi invalide (entry ou task attendu)'), { status: 400 });
    const entity = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!entity) return null;
    const documents = db.prepare(`SELECT e.*, g.document_id IS NOT NULL google
      FROM entries e LEFT JOIN google_documents g ON g.entry_id=e.id
      WHERE ${kind === 'entry' ? 'e.id=?' : 'e.id IN (SELECT entry_id FROM task_entries WHERE task_id=?)'}`).all(id);
    const project = entity.project_id ? db.prepare('SELECT name FROM projects WHERE id=?').get(entity.project_id) : null;
    const source = buildFollowUpSource(kind, entity, documents, project);
    return { follow_up: readFollowUp(entity.follow_up), source_key: followUpKey(source), source };
  };
  const metadata = (kind, row) => {
    const decoded = decodeFollowUpRow(row);
    return decoded?.follow_up ? { ...decoded, follow_up_key: snapshot(kind, row.id).source_key } : decoded;
  };
  return { snapshot, metadata };
}

export function registerFollowUpRoutes(app, db, access) {
  const get = (req, res) => {
    const value = access.snapshot(req.params.kind, req.params.id);
    if (!value) res.status(404).json({ error: req.params.kind === 'entry' ? 'entrée introuvable' : 'tâche introuvable' });
    return value;
  };
  app.get('/api/follow-up/:kind/:id', (req, res) => {
    const value = get(req, res);
    if (value) res.json(value);
  });
  app.put('/api/follow-up/:kind/:id', (req, res) => {
    const value = get(req, res);
    if (!value) return;
    const stamp = nowISO();
    const next = updateFollowUp(value.follow_up, req.body, value.source_key, stamp);
    const table = req.params.kind === 'entry' ? 'entries' : 'tasks';
    db.prepare(`UPDATE ${table} SET follow_up=? WHERE id=?`).run(JSON.stringify(next), req.params.id);
    res.json({ ...value, follow_up: next });
  });
}
