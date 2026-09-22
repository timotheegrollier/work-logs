import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { uid, nowISO, today, tombstone } from './db.js';
import { decodeEntry, documentText, validateDocument } from './rich-document.js';
import { buildBackup } from './backup.js';
import { googleLink, registerGoogleRoutes } from './google-routes.js';

export const STATUSES = ['todo', 'doing', 'done'];
export const PRIORITIES = ['low', 'normal', 'high'];
export const KINDS = ['note', 'procedure'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `undefined`/`""` → priorité par défaut ; toute autre valeur inconnue est refusée. */
const priorityOf = (value, fallback = 'normal') => {
  const cleaned = str(value);
  if (cleaned === '') return fallback;
  return PRIORITIES.includes(cleaned) ? cleaned : null;
};
/** `undefined`/`""` → type par défaut ; toute autre valeur inconnue est refusée. */
const kindOf = (value, fallback = 'note') => {
  const cleaned = str(value);
  if (cleaned === '') return fallback;
  return KINDS.includes(cleaned) ? cleaned : null;
};

const bad = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg = 'introuvable') => res.status(404).json({ error: msg });
const str = (v) => (typeof v === 'string' ? v.trim() : '');
/** `""` et `undefined` → NULL, sinon la valeur nettoyée. */
const orNull = (v) => (str(v) === '' ? null : str(v));

/** Un champ optionnel n'est écrasé que s'il est explicitement fourni. */
const pick = (body, key, current, transform = (v) => v) =>
  body[key] === undefined ? current : transform(body[key]);

/**
 * La base parle `drive_file_id` (snake), l'API et le JSON parlent
 * `driveFileId` (comme la boîte mobile). Exposer les deux dupliquerait le
 * sens ; on ne sort que le camel, `null` quand le fichier est local seul.
 */
export const formatAttachment = (row) => {
  if (!row) return row;
  const { drive_file_id: _snake, driveFileId: _camel, ...rest } = row;
  return { ...rest, driveFileId: _snake || _camel || null };
};

const CONTROL_OR_QUOTE_RE = /[\x00-\x1f\x7f"\\]/g;
const NON_ASCII_RE = /[^\x20-\x7e]/g;
const EXTRA_ENCODE_RE = /['()]/g;
/**
 * En-tête Content-Disposition fournissant systématiquement `filename` (repli
 * ASCII) et `filename*` (UTF-8, RFC 6266). Le module `content-disposition`
 * utilisé par `res.download` omet `filename*` dès que le nom est représentable
 * en Latin-1 (cas courant des accents français) ; or Chromium/Electron ne
 * décodent alors correctement ce nom qu'avec un `referrer_charset` que les
 * téléchargements desktop ne fournissent pas (jshttp/content-disposition#27).
 */
const attachmentHeader = (filename) => {
  const ascii = filename.replace(CONTROL_OR_QUOTE_RE, '_').replace(NON_ASCII_RE, '_');
  const utf8 = encodeURIComponent(filename).replace(EXTRA_ENCODE_RE, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + utf8;
};

/**
 * Même nom, mais affiché dans l'onglet au lieu d'être téléchargé : c'est ce qui
 * permet à l'aperçu intégré de lire PDF, images et texte sans sortir de WorkLogs.
 * Un téléchargement direct reste toujours possible via `/api/files/:stored`.
 */
const inlineHeader = (filename) => `inline; ${attachmentHeader(filename).slice('attachment; '.length)}`;

export function createApp({ db, uploadDir, staticDir = null, google = null, autoSync = false }) {
  fs.mkdirSync(uploadDir, { recursive: true });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  // Synchro Drive : toute écriture réussie relance un passage (regroupé par le moteur).
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.path.startsWith('/api/')
      && !/^\/api\/google\/(?:sync|status|connect|disconnect|configure|use-builtin|backup)/.test(req.path)) {
      res.on('finish', () => { if (res.statusCode < 400) app.locals.googleSync?.schedule(); });
    }
    next();
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadDir),
      filename: (_req, file, cb) =>
        cb(null, Date.now().toString(36) + '_' + file.originalname.replace(/[^\w.\-]+/g, '_')),
    }),
    limits: { fileSize: 100 * 1024 * 1024 },
  });

  const getEntry = (id) => {
    const row = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
    return row ? { ...decodeEntry(row), google_sync: googleLink(db, row) } : row;
  };
  const getTask = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const getTaskWithDocuments = (id) => {
    const task = getTask(id);
    if (!task) return task;
    const documents = db.prepare(
      `SELECT e.id, e.title, e.entry_date, e.project_id, e.archived, e.updated_at,
              '' excerpt, 0 attachments,
              g.document_id google_document_id, g.tab_id google_tab_id,
              g.document_title google_document_title, g.tab_title google_tab_title
       FROM task_entries te
       JOIN entries e ON e.id = te.entry_id
       LEFT JOIN google_documents g ON g.entry_id = e.id
       WHERE te.task_id=?
       ORDER BY e.entry_date DESC, e.updated_at DESC, e.id ASC`
    ).all(id);
    return { ...task, documents };
  };
  const getProject = (id) => db.prepare('SELECT * FROM projects WHERE id=?').get(id);

  app.get('/api/health', (_req, res) => res.json({ ok: true, ts: nowISO() }));

  // ---------------------------------------------------------------- état global
  // Un seul appel alimente tout l'écran : projets, entrées (sans le corps),
  // tâches et compteurs. Le front recharge cet endpoint après chaque mutation.
  app.get('/api/state', (req, res) => {
    const q = str(req.query.q);
    const projectId = str(req.query.project_id);
    const where = [];
    const args = [];
    if (projectId) {
      where.push('project_id=?');
      args.push(projectId);
    }

    // Les entrées sont jointes à google_documents : leurs colonnes doivent être
    // qualifiées, alors que la requête des tâches partage le même filtre brut.
    const entryWhere = where.map((clause) => 'entries.' + clause);
    const entryArgs = [...args];
    if (q) {
      entryWhere.push('(entries.title LIKE ? OR entries.content_md LIKE ?)');
      entryArgs.push(`%${q}%`, `%${q}%`);
    }
    const entries = db
      .prepare(
        `SELECT entries.id, entries.title, entries.entry_date, entries.project_id, entries.archived, entries.kind, entries.updated_at,
                substr(entries.content_md, 1, 240) excerpt,
                (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = entries.id) attachments,
                g.document_id google_document_id, g.tab_id google_tab_id,
                g.document_title google_document_title, g.tab_title google_tab_title,
                g.tab_order google_tab_order, g.tab_depth google_tab_depth, g.readonly_reason google_sync_blocked,
                (entries.content_json != g.synced_content_json) google_dirty
         FROM entries LEFT JOIN google_documents g ON g.entry_id = entries.id
          ${entryWhere.length ? 'WHERE ' + entryWhere.join(' AND ') : ''}
          ORDER BY entries.entry_date DESC, entries.updated_at DESC
          LIMIT 500`
      )
      .all(...entryArgs);

    const taskWhere = [...where];
    const taskArgs = [...args];
    if (q) {
      taskWhere.push('title LIKE ?');
      taskArgs.push(`%${q}%`);
    }
    const taskDocuments = db.prepare(
      `SELECT te.task_id, e.id, e.title, e.entry_date, e.project_id, e.archived, e.updated_at,
              g.document_id google_document_id, g.tab_id google_tab_id,
              g.document_title google_document_title, g.tab_title google_tab_title
       FROM task_entries te
       JOIN entries e ON e.id = te.entry_id
       LEFT JOIN google_documents g ON g.entry_id = e.id
       ORDER BY te.task_id, e.entry_date DESC, e.updated_at DESC, e.id ASC`
    ).all();
    const documentsByTask = new Map();
    for (const document of taskDocuments) {
      const documents = documentsByTask.get(document.task_id) || [];
      const { task_id: _taskId, ...summary } = document;
      documents.push(summary);
      documentsByTask.set(document.task_id, documents);
    }

    const tasks = db
      .prepare(
        `SELECT * FROM tasks
         ${taskWhere.length ? 'WHERE ' + taskWhere.join(' AND ') : ''}
         ORDER BY position ASC, updated_at DESC, id ASC
         LIMIT 500`
      )
      .all(...taskArgs)
      .map((task) => ({ ...task, documents: documentsByTask.get(task.id) || [] }));

    // Pièces jointes rassemblées pour le panneau Procédures : celles des
    // procédures du filtre courant, métadonnées seules (binaires via /api/files).
    const procedureAttachments = db
      .prepare(
        `SELECT a.id, a.filename, a.stored, a.mime, a.size, a.entry_id, a.created_at, a.drive_file_id,
                entries.title entry_title, entries.entry_date, entries.project_id
         FROM attachments a JOIN entries ON entries.id = a.entry_id
          ${entryWhere.length ? 'WHERE ' + entryWhere.join(' AND ') + ' AND ' : 'WHERE '}entries.kind='procedure'
         ORDER BY a.created_at DESC
         LIMIT 500`
      )
      .all(...entryArgs)
      .map(formatAttachment);

    res.json({
      projects: db
        .prepare(
          `SELECT *,
                  (SELECT COUNT(*) FROM entries e WHERE e.project_id = projects.id) entries,
                  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = projects.id AND t.status != 'done') open_tasks
           FROM projects ORDER BY name`
        )
        .all(),
      entries,
      tasks,
      procedure_attachments: procedureAttachments,
      stats: stats(db),
    });
  });

  // ---------------------------------------------------------------- entrées
  app.get('/api/entries/:id', (req, res) => {
    const entry = getEntry(req.params.id);
    if (!entry) return notFound(res, 'entrée introuvable');
    entry.attachments = db
      .prepare('SELECT * FROM attachments WHERE entry_id=? ORDER BY created_at DESC')
      .all(entry.id)
      .map(formatAttachment);
    res.json(entry);
  });

  app.post('/api/entries', (req, res) => {
    const b = req.body || {};
    const title = str(b.title);
    if (!title) return bad(res, 'titre requis');
    const date = str(b.entry_date) || today();
    if (!DATE_RE.test(date)) return bad(res, 'date invalide (AAAA-MM-JJ attendu)');
    if (orNull(b.project_id) && !getProject(str(b.project_id)))
      return bad(res, 'projet introuvable');
    const kind = kindOf(b.kind);
    if (!kind) return bad(res, 'type de document invalide (note ou procédure attendu)');

    const id = uid('en_');
    const t = nowISO();
    const rich = b.content_json == null ? null : validateDocument(b.content_json);
    db.prepare(
      'INSERT INTO entries (id,title,content_md,entry_date,project_id,kind,created_at,updated_at,content_json) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(id, title, rich ? documentText(rich) : typeof b.content_md === 'string' ? b.content_md : '', date, orNull(b.project_id), kind, t, t, rich ? JSON.stringify(rich) : null);
    res.status(201).json(getEntry(id));
  });

  app.put('/api/entries/:id', (req, res) => {
    const cur = getEntry(req.params.id);
    if (!cur) return notFound(res, 'entrée introuvable');
    const b = req.body || {};

    const title = pick(b, 'title', cur.title, str);
    if (!title) return bad(res, 'titre requis');
    const date = pick(b, 'entry_date', cur.entry_date, (v) => str(v) || cur.entry_date);
    if (!DATE_RE.test(date)) return bad(res, 'date invalide (AAAA-MM-JJ attendu)');
    const projectId = pick(b, 'project_id', cur.project_id, orNull);
    if (projectId && !getProject(projectId)) return bad(res, 'projet introuvable');
    const archived = pick(b, 'archived', cur.archived ?? 0, (v) => (v ? 1 : 0));
    const kind = pick(b, 'kind', cur.kind ?? 'note', (v) => kindOf(v, cur.kind ?? 'note'));
    if (!kind) return bad(res, 'type de document invalide (note ou procédure attendu)');

    const rich = b.content_json === undefined ? cur.content_json : b.content_json;
    if (rich !== null) validateDocument(rich);
    if (cur.content_json && rich === null) return bad(res, 'la conversion d’un document riche en Markdown n’est pas prise en charge');

    db.prepare(
      'UPDATE entries SET title=?, content_md=?, entry_date=?, project_id=?, archived=?, kind=?, updated_at=?, content_json=? WHERE id=?'
    ).run(
      title,
      rich ? documentText(rich) : pick(b, 'content_md', cur.content_md, (v) => (typeof v === 'string' ? v : cur.content_md)),
      date,
      projectId,
      archived,
      kind,
      nowISO(),
      rich ? JSON.stringify(rich) : null,
      cur.id
    );
    res.json(getEntry(cur.id));
  });

  app.delete('/api/entries/:id', (req, res) => {
    const cur = getEntry(req.params.id);
    if (!cur) return notFound(res, 'entrée introuvable');
    for (const a of db.prepare('SELECT stored FROM attachments WHERE entry_id=?').all(cur.id)) {
      fs.rmSync(path.join(uploadDir, a.stored), { force: true });
    }
    db.prepare('DELETE FROM google_documents WHERE entry_id=?').run(cur.id);
    db.prepare('DELETE FROM entries WHERE id=?').run(cur.id);
    tombstone(db, 'entry', cur.id);
    res.json({ ok: true });
  });

  app.post('/api/entries/:id/copy', (req, res) => {
    const original = getEntry(req.params.id);
    if (!original) return notFound(res, 'entrée introuvable');
    const id = uid('en_'), time = nowISO(), written = [];
    const rich = original.content_json ? structuredClone(original.content_json) : null;
    let markdown = original.content_md;
    const replaceImage = (node, from, to) => {
      if (node.attrs?.src === from) node.attrs.src = to;
      for (const child of node.content || []) replaceImage(child, from, to);
    };
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO entries (id,title,content_md,content_json,entry_date,project_id,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, `${original.title} — copie locale`, markdown, rich ? JSON.stringify(rich) : null, original.entry_date, original.project_id, original.kind ?? 'note', time, time);
      for (const attachment of db.prepare('SELECT * FROM attachments WHERE entry_id=?').all(original.id)) {
        const stored = uid('copy_') + path.extname(attachment.stored);
        const target = path.join(uploadDir, stored);
        fs.copyFileSync(path.join(uploadDir, attachment.stored), target);
        written.push(target);
        db.prepare('INSERT INTO attachments (id,filename,stored,mime,size,entry_id,created_at,drive_file_id) VALUES (?,?,?,?,?,?,?,?)')
          .run(uid('at_'), attachment.filename, stored, attachment.mime, attachment.size, id, time, attachment.drive_file_id || '');
        const from = `/api/files/${attachment.stored}`, to = `/api/files/${stored}`;
        markdown = markdown.split(from).join(to);
        if (rich) replaceImage(rich, from, to);
      }
      db.prepare('UPDATE entries SET content_md=?,content_json=? WHERE id=?')
        .run(rich ? documentText(rich) : markdown, rich ? JSON.stringify(rich) : null, id);
      db.exec('COMMIT');
      res.status(201).json(getEntry(id));
    } catch (e) {
      db.exec('ROLLBACK');
      for (const file of written) fs.rmSync(file, { force: true });
      throw e;
    }
  });

  // ---------------------------------------------------------------- tâches
  app.post('/api/entries/:id/task', (req, res) => {
    const source = getEntry(req.params.id);
    if (!source) return notFound(res, 'entrée introuvable');
    const b = req.body || {};
    const title = b.title === undefined ? source.title : str(b.title);
    if (!title) return bad(res, 'titre requis');
    const dueDate = b.due_date === undefined ? null : orNull(b.due_date);
    if (dueDate && !DATE_RE.test(dueDate)) return bad(res, 'échéance invalide (AAAA-MM-JJ attendu)');

    const id = uid('tk_');
    const time = nowISO();
    const position = db.prepare('SELECT COALESCE(MAX(position),-1)+1 p FROM tasks WHERE status=?').get('todo').p;
    db.exec('BEGIN');
    try {
      db.prepare(
        'INSERT INTO tasks (id,title,status,due_date,pinned,position,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(id, title, 'todo', dueDate, 0, position, source.project_id, time, time);
      db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run(id, source.id, time);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.status(201).json(getTaskWithDocuments(id));
  });

  // Miroir de /api/entries/:id/task : une entrée créée depuis une tâche, liée
  // atomiquement. Le client y met sa liste de sous-tâches en Markdown.
  app.post('/api/tasks/:id/entry', (req, res) => {
    const source = getTask(req.params.id);
    if (!source) return notFound(res, 'tâche introuvable');
    const b = req.body || {};
    const title = b.title === undefined ? source.title : str(b.title);
    if (!title) return bad(res, 'titre requis');
    const content = typeof b.content_md === 'string' ? b.content_md : '';

    const id = uid('en_');
    const time = nowISO();
    db.exec('BEGIN');
    try {
      db.prepare(
        'INSERT INTO entries (id,title,content_md,entry_date,project_id,kind,created_at,updated_at,content_json) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(id, title, content, today(), source.project_id, 'note', time, time, null);
      db.prepare('INSERT INTO task_entries (task_id, entry_id, created_at) VALUES (?,?,?)').run(source.id, id, time);
      if (source.status === 'done') archiveTaskDocuments(db, source.id, time);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.status(201).json(getEntry(id));
  });

  app.post('/api/tasks', (req, res) => {
    const b = req.body || {};
    const title = str(b.title);
    if (!title) return bad(res, 'titre requis');
    const status = str(b.status) || 'todo';
    if (!STATUSES.includes(status)) return bad(res, 'statut invalide');
    const priority = priorityOf(b.priority);
    if (!priority) return bad(res, 'priorité invalide (basse, normale ou haute attendue)');
    if (orNull(b.project_id) && !getProject(str(b.project_id)))
      return bad(res, 'projet introuvable');

    const id = uid('tk_');
    const t = nowISO();
    const position = db
      .prepare('SELECT COALESCE(MAX(position),-1)+1 p FROM tasks WHERE status=?')
      .get(status).p;
    db.prepare(
      'INSERT INTO tasks (id,title,status,due_date,pinned,position,priority,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(id, title, status, orNull(b.due_date), b.pinned ? 1 : 0, position, priority, orNull(b.project_id), t, t);
    res.status(201).json(getTask(id));
  });

  app.put('/api/tasks/:id', (req, res) => {
    const cur = getTask(req.params.id);
    if (!cur) return notFound(res, 'tâche introuvable');
    const b = req.body || {};

    const title = pick(b, 'title', cur.title, str);
    if (!title) return bad(res, 'titre requis');
    const status = pick(b, 'status', cur.status, (v) => str(v) || cur.status);
    if (!STATUSES.includes(status)) return bad(res, 'statut invalide');
    const priority = pick(b, 'priority', cur.priority ?? 'normal', (v) => priorityOf(v, cur.priority ?? 'normal'));
    if (!priority) return bad(res, 'priorité invalide (basse, normale ou haute attendue)');
    const projectId = pick(b, 'project_id', cur.project_id, orNull);
    if (projectId && !getProject(projectId)) return bad(res, 'projet introuvable');

    const time = nowISO();
    db.exec('BEGIN');
    try {
      db.prepare(
        'UPDATE tasks SET title=?, status=?, due_date=?, pinned=?, priority=?, project_id=?, updated_at=? WHERE id=?'
      ).run(
        title,
        status,
        pick(b, 'due_date', cur.due_date, orNull),
        pick(b, 'pinned', cur.pinned, (v) => (v ? 1 : 0)),
        priority,
        projectId,
        time,
        cur.id
      );
      if (cur.status !== 'done' && status === 'done') archiveTaskDocuments(db, cur.id, time);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json(getTask(cur.id));
  });

  // Déplacement kanban : insère la carte à `position` dans la colonne `status`,
  // puis renumérote la colonne pour garder 0,1,2… sans trou.
  app.patch('/api/tasks/:id/move', (req, res) => {
    const cur = getTask(req.params.id);
    if (!cur) return notFound(res, 'tâche introuvable');
    const { status, position } = req.body || {};
    if (!STATUSES.includes(status)) return bad(res, 'statut invalide');
    const target = Number.isFinite(Number(position)) ? Math.max(0, Number(position)) : 0;

    const time = nowISO();
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE tasks SET status=?, position=?, updated_at=? WHERE id=?').run(
        status,
        target - 0.5,
        time,
        cur.id
      );
      renumber(db, status);
      if (cur.status !== status) renumber(db, cur.status);
      if (cur.status !== 'done' && status === 'done') archiveTaskDocuments(db, cur.id, time);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json(getTask(cur.id));
  });

  app.post('/api/tasks/:id/documents/:entryId', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return notFound(res, 'tâche introuvable');
    const entry = getEntry(req.params.entryId);
    if (!entry) return notFound(res, 'entrée introuvable');
    const existing = db.prepare('SELECT * FROM task_entries WHERE task_id=? AND entry_id=?').get(task.id, entry.id);
    if (existing) return res.json(existing);
    const association = { task_id: task.id, entry_id: entry.id, created_at: nowISO() };
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO task_entries (task_id, entry_id, created_at) VALUES (?,?,?)').run(
        association.task_id,
        association.entry_id,
        association.created_at
      );
      if (task.status === 'done') archiveTaskDocuments(db, task.id, association.created_at);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.status(201).json(association);
  });

  app.delete('/api/tasks/:id/documents/:entryId', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return notFound(res, 'tâche introuvable');
    const entry = getEntry(req.params.entryId);
    if (!entry) return notFound(res, 'entrée introuvable');
    const result = db.prepare('DELETE FROM task_entries WHERE task_id=? AND entry_id=?').run(task.id, entry.id);
    if (!result.changes) return notFound(res, 'association introuvable');
    tombstone(db, 'link', `${task.id}|${entry.id}`);
    res.json({ ok: true });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const cur = getTask(req.params.id);
    if (!cur) return notFound(res, 'tâche introuvable');
    db.prepare('DELETE FROM tasks WHERE id=?').run(cur.id);
    tombstone(db, 'task', cur.id);
    renumber(db, cur.status);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- projets
  app.post('/api/projects', (req, res) => {
    const b = req.body || {};
    const name = str(b.name);
    if (!name) return bad(res, 'nom requis');
    const id = uid('pr_');
    db.prepare('INSERT INTO projects (id,name,color,created_at) VALUES (?,?,?,?)').run(
      id,
      name,
      str(b.color) || '#4f7cff',
      nowISO()
    );
    res.status(201).json(getProject(id));
  });

  app.put('/api/projects/:id', (req, res) => {
    const cur = getProject(req.params.id);
    if (!cur) return notFound(res, 'projet introuvable');
    const b = req.body || {};
    const name = pick(b, 'name', cur.name, str);
    if (!name) return bad(res, 'nom requis');
    db.prepare('UPDATE projects SET name=?, color=?, updated_at=? WHERE id=?').run(
      name,
      pick(b, 'color', cur.color, (v) => str(v) || cur.color),
      nowISO(),
      cur.id
    );
    res.json(getProject(cur.id));
  });

  // Les entrées et tâches sont conservées, simplement détachées (ON DELETE SET NULL).
  app.delete('/api/projects/:id', (req, res) => {
    const cur = getProject(req.params.id);
    if (!cur) return notFound(res, 'projet introuvable');
    db.prepare('DELETE FROM projects WHERE id=?').run(cur.id);
    tombstone(db, 'project', cur.id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- fichiers
  app.post('/api/uploads', upload.single('file'), (req, res) => {
    if (!req.file) return bad(res, 'fichier requis (multipart "file")');
    const entryId = orNull((req.body || {}).entry_id);
    if (!entryId || !getEntry(entryId)) {
      fs.rmSync(path.join(uploadDir, req.file.filename), { force: true });
      return bad(res, 'entry_id requis et valide');
    }
    const id = uid('at_');
    // Les navigateurs transmettent les noms en UTF-8, Busboy les lit en latin1.
    // Conserver le nom initial si ce n’est pas une séquence UTF-8 valide.
    let filename = req.file.originalname;
    try { filename = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(filename, 'latin1')); } catch {}
    db.prepare(
      'INSERT INTO attachments (id,filename,stored,mime,size,entry_id,created_at,drive_file_id) VALUES (?,?,?,?,?,?,?,?)'
    ).run(id, filename, req.file.filename, req.file.mimetype || '', req.file.size, entryId, nowISO(), '');
    res.status(201).json(formatAttachment(db.prepare('SELECT * FROM attachments WHERE id=?').get(id)));
  });

  /**
   * Retrouve une pièce jointe et son chemin absolu. `null` si la ligne, le nom
   * enregistré ou le fichier disque manque — les trois cas mènent au même 404,
   * la route ne devant rien laisser deviner de l'état interne.
   */
  const findAttachment = (storedParam) => {
    const stored = path.basename(storedParam);
    const att = db.prepare('SELECT * FROM attachments WHERE stored=?').get(stored);
    const file = path.join(uploadDir, stored);
    if (!att || !fs.existsSync(file)) return null;
    return { att, file: path.resolve(file) };
  };

  app.get('/api/files/:stored', (req, res) => {
    const found = findAttachment(req.params.stored);
    if (!found) return notFound(res, 'fichier introuvable');
    res.setHeader('Content-Disposition', attachmentHeader(found.att.filename));
    res.sendFile(found.file); // res.download() résolvait ce chemin ; sendFile l'exige déjà absolu.
  });

  /**
   * Mêmes octets, mais servis pour l'affichage : `inline` et le type réellement
   * enregistré à l'envoi, au lieu de forcer un téléchargement. Permet d'ouvrir
   * PDF, images, texte ou tableur dans l'aperçu intégré. Le chemin disque reste
   * `path.basename` : aucune traversée possible depuis l'URL.
   */
  app.get('/api/files/:stored/preview', (req, res) => {
    const found = findAttachment(req.params.stored);
    if (!found) return notFound(res, 'fichier introuvable');
    res.setHeader('Content-Disposition', inlineHeader(found.att.filename));
    const mime = found.att.mime || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    // Un type inconnu affiché tel quel deviendrait du HTML actif : on neutralise.
    if (/^(text\/html|application\/xhtml\+xml|image\/svg\+xml)$/i.test(mime)) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    res.sendFile(found.file);
  });

  app.delete('/api/attachments/:id', (req, res) => {
    const att = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
    if (!att) return notFound(res, 'pièce jointe introuvable');
    fs.rmSync(path.join(uploadDir, att.stored), { force: true });
    db.prepare('DELETE FROM attachments WHERE id=?').run(att.id);
    tombstone(db, 'attachment', att.id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- export
  app.get('/api/export', (_req, res) => res.json(buildBackup(db)));

  registerGoogleRoutes(app, { db, google, uploadDir, autoSync });
  app.use('/api', (_req, res) => notFound(res, 'route inconnue'));

  // En production, l'API sert aussi le front construit : une seule URL.
  // En dev, Vite s'en charge sur :8411 et proxifie /api vers ici.
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  // Toute erreur (dont les rejets multer : fichier trop gros, etc.) sort en {error}.
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'fichier trop volumineux (100 Mo max)' : err.message,
      ...(err.code?.startsWith('GOOGLE_') ? { code: err.code, ...(err.help_url ? { help_url: err.help_url } : {}) } : {}) });
  });

  return app;
}

/** Archive les documents liés quand une tâche est terminée, sans supprimer leurs liens. */
function archiveTaskDocuments(db, taskId, time = nowISO()) {
  db.prepare(
    `UPDATE entries SET archived=1, updated_at=?
     WHERE archived=0 AND id IN (SELECT entry_id FROM task_entries WHERE task_id=?)`
  ).run(time, taskId);
}

/** Réécrit les positions d'une colonne en 0,1,2… (ordre courant conservé). */
function renumber(db, status) {
  const rows = db
    .prepare('SELECT id FROM tasks WHERE status=? ORDER BY position ASC, updated_at DESC')
    .all(status);
  const set = db.prepare('UPDATE tasks SET position=? WHERE id=?');
  rows.forEach((row, i) => set.run(i, row.id));
}

function stats(db) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all()) {
    if (r.status in byStatus) byStatus[r.status] = r.n;
  }
  const day = today();
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  return {
    entries: db.prepare('SELECT COUNT(*) n FROM entries').get().n,
    entriesThisWeek: db.prepare('SELECT COUNT(*) n FROM entries WHERE entry_date >= ?').get(weekAgo).n,
    tasks: byStatus,
    overdue: db
      .prepare("SELECT COUNT(*) n FROM tasks WHERE status!='done' AND due_date IS NOT NULL AND due_date < ?")
      .get(day).n,
  };
}
