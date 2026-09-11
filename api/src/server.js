import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, uid, nowISO } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const PORT = Number(process.env.PORT || 8410);
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const storage = multer.diskStorage({
  destination: (_req, _f, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, Date.now().toString(36) + '_' + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

const STATUSES = ['todo', 'in_progress', 'review', 'done'];
const asInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const notFound = (res, what = 'introuvable') => res.status(404).json({ error: what });

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: nowISO() }));

app.get('/api/stats', (_req, res) => {
  const byStatus = db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all();
  const total = db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  const done = db.prepare("SELECT COUNT(*) n FROM tasks WHERE status='done'").get().n;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = db.prepare("SELECT COUNT(*) n FROM tasks WHERE status!='done' AND due_date IS NOT NULL AND due_date < ?").get(today).n;
  const urgent = db.prepare("SELECT COUNT(*) n FROM tasks WHERE status!='done' AND priority IN ('high','urgent')").get().n;
  const weekEnd = new Date(Date.now() + 7 * 864e5).toISOString();
  const upcoming = db.prepare('SELECT COUNT(*) n FROM events WHERE starts_at >= ? AND starts_at <= ?').get(new Date().toISOString(), weekEnd).n;
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of byStatus) counts[r.status] = r.n;
  res.json({ total, done, overdue, urgent, upcomingEvents: upcoming, byStatus: counts });
});

app.get('/api/search', (req, res) => {
  const raw = String(req.query.q || '').slice(0, 80);
  if (!raw.trim()) return res.json({ tasks: [], docs: [], events: [] });
  const q = `%${raw}%`;
  res.json({
    tasks: db.prepare('SELECT t.*, p.name project_name FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.title LIKE ? OR t.description LIKE ? LIMIT 20').all(q, q),
    docs: db.prepare('SELECT * FROM docs WHERE title LIKE ? OR content_md LIKE ? LIMIT 20').all(q, q),
    events: db.prepare('SELECT * FROM events WHERE title LIKE ? LIMIT 20').all(q),
  });
});

app.get('/api/projects', (_req, res) => {
  res.json(db.prepare("SELECT *, (SELECT COUNT(*) FROM tasks t WHERE t.project_id=projects.id AND t.status!=?) open_tasks FROM projects ORDER BY name").all('done'));
});
app.post('/api/projects', (req, res) => {
  const { name, pkey, color = '#4f7cff', description = '' } = req.body || {};
  if (!name?.trim() || !pkey?.trim()) return res.status(400).json({ error: 'name et pkey requis' });
  const id = uid('pr_');
  db.prepare('INSERT INTO projects (id,name,pkey,color,description,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, name.trim(), pkey.trim().toUpperCase(), color, description, nowISO());
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id=?').get(id));
});
app.put('/api/projects/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!cur) return notFound(res, 'projet introuvable');
  const b = req.body || {};
  db.prepare('UPDATE projects SET name=?,pkey=?,color=?,description=? WHERE id=?').run(
    b.name ?? cur.name, String(b.pkey ?? cur.pkey).toUpperCase(), b.color ?? cur.color, b.description ?? cur.description, cur.id);
  res.json(db.prepare('SELECT * FROM projects WHERE id=?').get(cur.id));
});
app.delete('/api/projects/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// ---------- tasks ----------
app.get('/api/tasks', (req, res) => {
  const { project_id, status, priority, type, search } = req.query;
  const where = [];
  const args = [];
  if (project_id) { where.push('t.project_id=?'); args.push(project_id); }
  if (status) { where.push('t.status=?'); args.push(status); }
  if (priority) { where.push('t.priority=?'); args.push(priority); }
  if (type) { where.push('t.type=?'); args.push(type); }
  if (search) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  const sql = `SELECT t.*, p.name project_name, p.color project_color FROM tasks t
    LEFT JOIN projects p ON p.id=t.project_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.position ASC, t.updated_at DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...args));
});
app.get('/api/tasks/:id', (req, res) => {
  const t = db.prepare('SELECT t.*, p.name project_name FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(req.params.id);
  if (!t) return notFound(res, 'tâche introuvable');
  t.attachments = db.prepare('SELECT * FROM attachments WHERE task_id=?').all(t.id);
  res.json(t);
});
app.post('/api/tasks', (req, res) => {
  const b = req.body || {};
  if (!b.title?.trim()) return res.status(400).json({ error: 'title requis' });
  if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalide' });
  const id = uid('t_');
  const t = nowISO();
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 p FROM tasks WHERE status=?').get(b.status || 'todo').p;
  db.prepare('INSERT INTO tasks (id,project_id,parent_id,title,description,status,priority,type,due_date,estimate_h,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    id, b.project_id || null, b.parent_id || null, b.title.trim(), b.description || '',
    b.status || 'todo', b.priority || 'medium', b.type || 'task',
    b.due_date || null, b.estimate_h ?? null, asInt(b.position, maxPos), t, t);
  res.status(201).json(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
});
app.put('/api/tasks/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!cur) return notFound(res, 'tâche introuvable');
  const b = req.body || {};
  if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalide' });
  db.prepare('UPDATE tasks SET project_id=?,parent_id=?,title=?,description=?,status=?,priority=?,type=?,due_date=?,estimate_h=?,position=?,updated_at=? WHERE id=?').run(
    b.project_id !== undefined ? b.project_id || null : cur.project_id,
    b.parent_id !== undefined ? b.parent_id || null : cur.parent_id,
    String(b.title ?? cur.title).trim(), b.description ?? cur.description,
    b.status ?? cur.status, b.priority ?? cur.priority, b.type ?? cur.type,
    b.due_date !== undefined ? b.due_date || null : cur.due_date,
    b.estimate_h !== undefined ? b.estimate_h : cur.estimate_h,
    b.position ?? cur.position, nowISO(), cur.id);
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(cur.id));
});
app.patch('/api/tasks/:id/move', (req, res) => {
  const cur = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!cur) return notFound(res, 'tâche introuvable');
  const { status, position } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'status invalide' });
  const pos = asInt(position, 0);
  db.prepare('UPDATE tasks SET position = position + 1 WHERE status=? AND position >= ? AND id != ?').run(status, pos, cur.id);
  db.prepare('UPDATE tasks SET status=?, position=?, updated_at=? WHERE id=?').run(status, pos, nowISO(), cur.id);
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(cur.id));
});
app.delete('/api/tasks/:id', (req, res) => {
  const atts = db.prepare('SELECT * FROM attachments WHERE task_id=?').all(req.params.id);
  for (const a of atts) { try { fs.unlinkSync(path.join(UPLOAD_DIR, a.stored)); } catch {} }
  db.prepare('DELETE FROM attachments WHERE task_id=?').run(req.params.id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- events ----------
app.get('/api/events', (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT e.*, p.name project_name FROM events e LEFT JOIN projects p ON p.id=e.project_id';
  const args = [];
  if (from || to) {
    const w = [];
    if (from) { w.push('e.ends_at >= ?'); args.push(from); }
    if (to) { w.push('e.starts_at <= ?'); args.push(to); }
    sql += ' WHERE ' + w.join(' AND ');
  }
  sql += ' ORDER BY e.starts_at ASC LIMIT 300';
  res.json(db.prepare(sql).all(...args));
});
app.post('/api/events', (req, res) => {
  const b = req.body || {};
  if (!b.title?.trim() || !b.starts_at || !b.ends_at) return res.status(400).json({ error: 'title, starts_at, ends_at requis' });
  const id = uid('e_');
  db.prepare('INSERT INTO events (id,title,description,starts_at,ends_at,task_id,project_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, b.title.trim(), b.description || '', b.starts_at, b.ends_at, b.task_id || null, b.project_id || null, nowISO());
  res.status(201).json(db.prepare('SELECT * FROM events WHERE id=?').get(id));
});
app.put('/api/events/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!cur) return notFound(res, 'événement introuvable');
  const b = req.body || {};
  db.prepare('UPDATE events SET title=?,description=?,starts_at=?,ends_at=?,task_id=?,project_id=? WHERE id=?').run(
    String(b.title ?? cur.title).trim(), b.description ?? cur.description, b.starts_at ?? cur.starts_at,
    b.ends_at ?? cur.ends_at, b.task_id !== undefined ? b.task_id || null : cur.task_id,
    b.project_id !== undefined ? b.project_id || null : cur.project_id, cur.id);
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(cur.id));
});
app.delete('/api/events/:id', (req, res) => {
  db.prepare('DELETE FROM events WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- docs ----------
app.get('/api/docs', (req, res) => {
  const { project_id, task_id, search } = req.query;
  const w = []; const args = [];
  if (project_id) { w.push('project_id=?'); args.push(project_id); }
  if (task_id) { w.push('task_id=?'); args.push(task_id); }
  if (search) { w.push('(title LIKE ? OR content_md LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  const sql = `SELECT * FROM docs ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 200`;
  res.json(db.prepare(sql).all(...args));
});
app.post('/api/docs', (req, res) => {
  const b = req.body || {};
  if (!b.title?.trim()) return res.status(400).json({ error: 'title requis' });
  const id = uid('d_'); const t = nowISO();
  db.prepare('INSERT INTO docs (id,title,content_md,project_id,task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, b.title.trim(), b.content_md || '', b.project_id || null, b.task_id || null, t, t);
  res.status(201).json(db.prepare('SELECT * FROM docs WHERE id=?').get(id));
});
app.put('/api/docs/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM docs WHERE id=?').get(req.params.id);
  if (!cur) return notFound(res, 'doc introuvable');
  const b = req.body || {};
  db.prepare('UPDATE docs SET title=?,content_md=?,project_id=?,task_id=?,updated_at=? WHERE id=?').run(
    String(b.title ?? cur.title).trim(), b.content_md ?? cur.content_md,
    b.project_id !== undefined ? b.project_id || null : cur.project_id,
    b.task_id !== undefined ? b.task_id || null : cur.task_id, nowISO(), cur.id);
  res.json(db.prepare('SELECT * FROM docs WHERE id=?').get(cur.id));
});
app.delete('/api/docs/:id', (req, res) => {
  db.prepare('DELETE FROM docs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- fichiers ----------
app.post('/api/uploads', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file requis (multipart)' });
  const { project_id, task_id, doc_id } = req.body || {};
  const id = uid('a_');
  db.prepare('INSERT INTO attachments (id,filename,stored,mime,size,project_id,task_id,doc_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size,
      project_id || null, task_id || null, doc_id || null, nowISO());
  res.status(201).json(db.prepare('SELECT * FROM attachments WHERE id=?').get(id));
});
app.get('/api/attachments', (req, res) => {
  const { project_id, task_id, doc_id } = req.query;
  const w = []; const args = [];
  if (project_id) { w.push('project_id=?'); args.push(project_id); }
  if (task_id) { w.push('task_id=?'); args.push(task_id); }
  if (doc_id) { w.push('doc_id=?'); args.push(doc_id); }
  const sql = `SELECT * FROM attachments ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 300`;
  res.json(db.prepare(sql).all(...args));
});
app.get('/api/files/:stored', (req, res) => {
  const safe = path.basename(req.params.stored);
  const att = db.prepare('SELECT * FROM attachments WHERE stored=?').get(safe);
  const fp = path.join(UPLOAD_DIR, safe);
  if (!att || !fs.existsSync(fp)) return notFound(res, 'fichier introuvable');
  res.download(fp, att.filename);
});
app.delete('/api/attachments/:id', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
  if (!att) return notFound(res, 'pièce jointe introuvable');
  try { fs.unlinkSync(path.join(UPLOAD_DIR, att.stored)); } catch {}
  db.prepare('DELETE FROM attachments WHERE id=?').run(att.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`[api] WorkLogs API -> http://localhost:${PORT}`));

