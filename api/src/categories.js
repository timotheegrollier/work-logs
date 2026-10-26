import { uid, nowISO, tombstone } from './db.js';

const text = (value) => typeof value === 'string' ? value.trim() : '';
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

/** Une catégorie appartient toujours au même projet que l'élément classé. */
export function categoryFor(db, projectId, value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail('catégorie invalide');
  const id = value.trim();
  if (!id) return null;
  const category = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
  if (!category) fail('catégorie introuvable');
  if (category.project_id !== projectId) fail('la catégorie doit appartenir au même projet');
  return id;
}

/** Une ancienne catégorie est libérée quand l'élément change de projet. */
export function nextCategory(db, body, current, projectId) {
  if (body.category_id !== undefined) return categoryFor(db, projectId, body.category_id);
  return projectId === current.project_id ? current.category_id ?? null : null;
}

export const categoryDescendants = (db, id) => db.prepare(`
  WITH RECURSIVE subtree(id) AS (
    SELECT id FROM categories WHERE id=?
    UNION SELECT c.id FROM categories c JOIN subtree s ON c.parent_id=s.id
  ) SELECT id FROM subtree`).all(id).map((row) => row.id);

export function registerCategoryRoutes(app, db) {
  const get = (id) => db.prepare('SELECT * FROM categories WHERE id=?').get(id);
  const missing = (res) => res.status(404).json({ error: 'catégorie introuvable' });
  const values = (body, current = null) => {
    const name = body.name === undefined && current ? current.name : text(body.name);
    if (!name || name.length > 100) fail('nom de catégorie requis (100 caractères maximum)');
    const projectId = body.project_id === undefined && current ? current.project_id : text(body.project_id);
    if (!projectId || !db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) fail('projet introuvable');
    if (current && projectId !== current.project_id) fail('une catégorie ne peut pas changer de projet');
    const parentId = body.parent_id === undefined ? current?.parent_id ?? null : categoryFor(db, projectId, body.parent_id);
    if (current && parentId && categoryDescendants(db, current.id).includes(parentId)) fail('une catégorie ne peut pas être rangée dans elle-même ou une sous-catégorie');
    const color = body.color === undefined ? current?.color ?? '#64748b' : text(body.color);
    if (!/^#[\da-f]{6}$/i.test(color)) fail('couleur de catégorie invalide (#RRGGBB attendu)');
    return { name, projectId, parentId, color };
  };
  app.post('/api/categories', (req, res) => {
    const { name, projectId, parentId, color } = values(req.body || {});
    const id = uid('ca_'), time = nowISO();
    db.prepare('INSERT INTO categories (id,name,project_id,parent_id,color,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, name, projectId, parentId, color, time, time);
    res.status(201).json(get(id));
  });
  app.put('/api/categories/:id', (req, res) => {
    const current = get(req.params.id);
    if (!current) return missing(res);
    const { name, projectId, parentId, color } = values(req.body || {}, current);
    db.prepare('UPDATE categories SET name=?,project_id=?,parent_id=?,color=?,updated_at=? WHERE id=?')
      .run(name, projectId, parentId, color, nowISO(), current.id);
    res.json(get(current.id));
  });
  app.delete('/api/categories/:id', (req, res) => {
    const current = get(req.params.id);
    if (!current) return missing(res);
    const time = nowISO();
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE categories SET parent_id=?,updated_at=? WHERE parent_id=?').run(current.parent_id, time, current.id);
      for (const table of ['entries', 'tasks']) {
        db.prepare(`UPDATE ${table} SET category_id=?,updated_at=? WHERE category_id=?`).run(current.parent_id, time, current.id);
      }
      db.prepare('DELETE FROM categories WHERE id=?').run(current.id);
      tombstone(db, 'category', current.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ ok: true });
  });
}
