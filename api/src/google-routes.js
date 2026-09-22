import { uid, nowISO, today, tombstone } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { decodeEntry, documentText } from './rich-document.js';
import { buildGoogleUpdate, documentBody, documentTabs, selectDocumentTab } from './google-document.js';
import { mergeGoogleChanges } from './google-merge.js';
import { buildPreservingUpdate, googlePreservedCount, importGoogleDocument as googleToDocument } from './google-preserve.js';
import { buildBackup, BACKUP_NAME, MAX_BACKUP_BYTES, restoreBackup, validateBackup } from './backup.js';
import { createSyncEngine } from './google-sync.js';
import { validateOutbox } from './backup-format.js';

const blankSource = { body: { content: [{ paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } };
const backupInfo = (file) => ({
  id: file.id,
  name: file.name,
  modifiedTime: file.modifiedTime || '',
  size: file.size === undefined ? null : Number(file.size),
});
const backupBoundary = () => `worklogs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const multipartBackup = (name, payload) => {
  const boundary = backupBoundary();
  const metadata = JSON.stringify({
    name,
    mimeType: 'application/json',
    appProperties: { worklogs_type: 'backup', worklogs_version: '2' },
  });
  return {
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`),
      Buffer.from(payload),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
};

/**
 * Binaire adossé à Drive : même `multipart/related` à vrais CRLF que les
 * sauvegardes, avec `appProperties` qui permet de retrouver le fichier sans
 * nouvelle table (`worklogs_type=attachment` + ids WorkLogs).
 */
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const folders = new WeakMap();
/**
 * Dossier Drive `WorkLogs/Pièces jointes`, retrouvé par étiquette (renommable sans
 * rien casser), créé au besoin. Mis en cache par client ; `null` si Google refuse :
 * le fichier part alors à la racine plutôt que de rester bloqué.
 */
export function attachmentFolder(google) {
  if (!folders.has(google)) {
    const find = async (type) => {
      const params = new URLSearchParams({
        q: `mimeType='${FOLDER_MIME}' and appProperties has { key='worklogs_type' and value='${type}' } and trashed=false`,
        fields: 'files(id)', pageSize: '1', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      });
      return (await google.request(`/drive/v3/files?${params}`)).files?.[0]?.id || null;
    };
    const create = async (name, type, parent) => (await google.request('/drive/v3/files?supportsAllDrives=true&fields=id', {
      method: 'POST',
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, appProperties: { worklogs_type: type }, ...(parent ? { parents: [parent] } : {}) }),
    })).id || null;
    const pending = (async () => {
      const existing = await find('attachments-folder');
      if (existing) return existing;
      const root = (await find('root-folder')) || await create('WorkLogs', 'root-folder');
      return create('Pièces jointes', 'attachments-folder', root);
    })().catch(() => { folders.delete(google); return null; });
    folders.set(google, pending);
  }
  return folders.get(google);
}

const multipartAttachment = (name, mimeType, content, attachmentId, entryId, parent = null) => {
  const boundary = backupBoundary();
  const metadata = JSON.stringify({
    name,
    mimeType: mimeType || 'application/octet-stream',
    ...(parent ? { parents: [parent] } : {}),
    appProperties: {
      worklogs_type: 'attachment',
      worklogs_version: '2',
      worklogs_attachment_id: attachmentId,
      worklogs_entry_id: entryId,
    },
  });
  return {
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`),
      Buffer.isBuffer(content) ? content : Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
};

/** Envoie vers Drive les binaires locaux pas encore adossés, en place. */
async function uploadMissingAttachments(db, google, uploadDir) {
  const rows = db.prepare("SELECT * FROM attachments WHERE drive_file_id IS NULL OR drive_file_id=''").all();
  let binaries = 0;
  const parent = rows.length ? await attachmentFolder(google) : null;
  for (const row of rows) {
    const target = path.join(uploadDir, path.basename(row.stored));
    if (!fs.existsSync(target)) continue;
    try {
      const content = fs.readFileSync(target);
      if (content.length > 100 * 1024 * 1024) continue;
      const part = multipartAttachment(row.filename, row.mime, content, row.id, row.entry_id, parent);
      const result = await google.request('/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
        method: 'POST',
        headers: { 'Content-Type': part.contentType },
        body: part.body,
      });
      if (result?.id && /^[\w-]{1,200}$/.test(result.id)) {
        db.prepare('UPDATE attachments SET drive_file_id=? WHERE id=?').run(result.id, row.id);
        binaries++;
      }
    } catch {
      // Best-effort à l'export : la sauvegarde JSON part quand même, le
      // fichier restera « local seul » et sera renvoyé au prochain export.
    }
  }
  return binaries;
}

/** Retélécharge les binaires Drive dont le fichier local manque. */
async function downloadMissingAttachments(db, google, uploadDir, attachments) {
  let binaries = 0;
  let missing = 0;
  for (const attachment of attachments) {
    const driveFileId = attachment.driveFileId || attachment.drive_file_id || '';
    if (!driveFileId) continue;
    const target = path.join(uploadDir, path.basename(attachment.stored));
    if (fs.existsSync(target)) continue;
    try {
      const binary = await google.request(`/drive/v3/files/${driveFileId}?alt=media&supportsAllDrives=true`, { responseType: 'arraybuffer' });
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(target, Buffer.isBuffer(binary) ? binary : Buffer.from(binary));
      binaries++;
    } catch {
      missing++;
    }
  }
  return { binaries, missing };
}

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const fileId = (value) => {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/.test(value)) fail('Identifiant de document Google invalide.');
  return value;
};

/** Réécrit les positions d'une colonne (miroir de `renumber()` dans `app.js`,
 *  non importable ici sans cycle : toute règle s'applique des deux côtés). */
function renumberTasks(db, status) {
  const rows = db.prepare('SELECT id FROM tasks WHERE status=? ORDER BY position ASC, updated_at DESC').all(status);
  const set = db.prepare('UPDATE tasks SET position=? WHERE id=?');
  rows.forEach((row, i) => set.run(i, row.id));
}

const sameEntry = (current, next) =>
  current.title === next.title && current.content_md === next.content_md &&
  (current.content_json || null) === (next.content_json ? JSON.stringify(next.content_json) : null) &&
  current.entry_date === next.entry_date && (current.project_id || null) === (next.project_id || null) &&
  (current.archived ?? 0) === (next.archived ?? 0) && (current.kind ?? 'note') === (next.kind ?? 'note');

const sameTask = (current, next) =>
  current.title === next.title && current.status === next.status &&
  (current.due_date || null) === (next.due_date || null) && current.pinned === next.pinned &&
  current.position === next.position && current.priority === next.priority &&
  (current.project_id || null) === (next.project_id || null);

/**
 * Fusionne une boîte mobile validée : insertions, mises à jour si la version
 * mobile est plus récente (`updated_at`), conflits comptés sinon — jamais
 * d'écrasement silencieux. Les binaires sont téléchargés AVANT la transaction
 * (pas de réseau transaction ouverte) ; les fichiers écrits sont retirés en
 * cas d'échec, comme `copyEntry` dans `app.js`.
 */
export async function importOutbox(db, { google, uploadDir }, data) {
  const counts = { projects: 0, entries: 0, tasks: 0, links: 0, attachments: 0, binaries: 0, updated: 0, conflicts: 0 };
  const pending = [];
  for (const attachment of data.attachments) {
    const exists = db.prepare('SELECT id FROM attachments WHERE id=?').get(attachment.id);
    const target = path.join(uploadDir, path.basename(attachment.stored));
    if (attachment.driveFileId && (!exists || !fs.existsSync(target))) {
      const binary = await google.request(`/drive/v3/files/${attachment.driveFileId}?alt=media&supportsAllDrives=true`, { responseType: 'arraybuffer' });
      pending.push({ target, content: Buffer.isBuffer(binary) ? binary : Buffer.from(binary) });
    }
  }
  const written = [];
  const touched = new Set();
  db.exec('BEGIN');
  try {
    for (const project of data.projects) {
      if (!db.prepare('SELECT id FROM projects WHERE id=?').get(project.id)) {
        db.prepare('INSERT INTO projects (id,name,color,created_at) VALUES (?,?,?,?)').run(project.id, project.name, project.color, project.created_at);
        counts.projects++;
      }
    }
    for (const next of data.entries) {
      const current = db.prepare('SELECT * FROM entries WHERE id=?').get(next.id);
      const content = next.content_json ? JSON.stringify(next.content_json) : null;
      if (!current) {
        db.prepare('INSERT INTO entries (id,title,content_md,content_json,entry_date,project_id,archived,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(next.id, next.title, next.content_md, content, next.entry_date, next.project_id, next.archived ?? 0, next.kind ?? 'note', next.created_at, next.updated_at);
        counts.entries++;
      } else if (next.updated_at > current.updated_at) {
        db.prepare('UPDATE entries SET title=?,content_md=?,content_json=?,entry_date=?,project_id=?,archived=?,kind=?,updated_at=? WHERE id=?')
          .run(next.title, next.content_md, content, next.entry_date, next.project_id, next.archived ?? 0, next.kind ?? 'note', next.updated_at, next.id);
        counts.updated++;
      } else if (!sameEntry(current, next)) counts.conflicts++;
    }
    for (const next of data.tasks) {
      const current = db.prepare('SELECT * FROM tasks WHERE id=?').get(next.id);
      if (!current) {
        db.prepare('INSERT INTO tasks (id,title,status,due_date,pinned,position,priority,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(next.id, next.title, next.status, next.due_date, next.pinned, next.position, next.priority, next.project_id, next.created_at, next.updated_at);
        counts.tasks++;
        touched.add(next.status);
      } else if (next.updated_at > current.updated_at) {
        db.prepare('UPDATE tasks SET title=?,status=?,due_date=?,pinned=?,position=?,priority=?,project_id=?,updated_at=? WHERE id=?')
          .run(next.title, next.status, next.due_date, next.pinned, next.position, next.priority, next.project_id, next.updated_at, next.id);
        counts.updated++;
        touched.add(current.status);
        touched.add(next.status);
      } else if (!sameTask(current, next)) counts.conflicts++;
    }
    for (const link of data.task_entries) {
      if (!db.prepare('SELECT 1 FROM tasks WHERE id=?').get(link.task_id)) continue;
      if (!db.prepare('SELECT 1 FROM entries WHERE id=?').get(link.entry_id)) continue;
      if (!db.prepare('SELECT * FROM task_entries WHERE task_id=? AND entry_id=?').get(link.task_id, link.entry_id)) {
        db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run(link.task_id, link.entry_id, link.created_at);
        counts.links++;
      }
    }
    for (const attachment of data.attachments) {
      if (!db.prepare('SELECT id FROM attachments WHERE id=?').get(attachment.id)) {
        db.prepare('INSERT INTO attachments (id,filename,stored,mime,size,entry_id,created_at,drive_file_id) VALUES (?,?,?,?,?,?,?,?)')
          .run(attachment.id, attachment.filename, attachment.stored, attachment.mime, attachment.size, attachment.entry_id, attachment.created_at, attachment.driveFileId || '');
        counts.attachments++;
      }
    }
    for (const status of touched) renumberTasks(db, status);
    for (const { target, content } of pending) {
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(target, content);
      written.push(target);
      counts.binaries++;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    for (const file of written) fs.rmSync(file, { force: true });
    throw error;
  }
  return { ok: true, ...counts };
}
export function googleLink(db, entry) {
  const link = db.prepare('SELECT * FROM google_documents WHERE entry_id=?').get(entry.id);
  return link ? {
    document_id: link.document_id, tab_id: link.tab_id, synced_at: link.synced_at,
    document_title: link.document_title, tab_title: link.tab_title, tab_order: link.tab_order, tab_depth: link.tab_depth,
    preserved_elements: entry.content_json ? googlePreservedCount(JSON.parse(entry.content_json)) : 0,
    sync_blocked: link.readonly_reason || '',
    tabs: db.prepare(`SELECT e.id, e.title, e.entry_date, e.project_id, e.updated_at,
      '' excerpt, 0 attachments, g.document_id google_document_id, g.tab_id google_tab_id,
      g.tab_title google_tab_title, g.tab_order google_tab_order, g.tab_depth google_tab_depth,
      g.readonly_reason google_sync_blocked, (e.content_json != g.synced_content_json) google_dirty
      FROM google_documents g JOIN entries e ON e.id=g.entry_id WHERE g.document_id=? ORDER BY g.tab_order`).all(link.document_id),
    dirty: entry.content_json !== link.synced_content_json,
  } : null;
}

export function registerGoogleRoutes(app, { db, google, uploadDir, autoSync = false }) {
  /** Projet et présence locale d'un document Drive (ses onglets partagent le même projet). */
  const localDocument = (documentId) => {
    const rows = db.prepare('SELECT e.project_id FROM google_documents g JOIN entries e ON e.id=g.entry_id WHERE g.document_id=?').all(documentId);
    return { linked: rows.length > 0, project_id: rows.find(row => row.project_id)?.project_id || null };
  };
  const removeLocalEntry = (id) => {
    for (const a of db.prepare('SELECT stored FROM attachments WHERE entry_id=?').all(id)) fs.rmSync(path.join(uploadDir, path.basename(a.stored)), { force: true });
    db.prepare('DELETE FROM google_documents WHERE entry_id=?').run(id);
    db.prepare('DELETE FROM entries WHERE id=?').run(id);
    tombstone(db, 'entry', id);
  };
  const route = (method, url, fn) => app[method](url, (req, res, next) => {
    Promise.resolve().then(() => {
      if (!google) fail('Google Drive est disponible dans l’application desktop. Les documents locaux fonctionnent aussi dans le navigateur.', 503);
      return fn(req, res);
    }).catch(next);
  });
  const entry = (id) => {
    const value = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
    if (!value) fail('entrée introuvable', 404);
    return value;
  };
  const readSource = async (id) => {
    fileId(id);
    return google.request(`/docs/v1/documents/${id}?includeTabsContent=true`);
  };
  const read = async (id, tabId = '') => selectDocumentTab(await readSource(id), tabId);
  const backupList = async () => {
    const files = [];
    const seenTokens = new Set();
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: "appProperties has { key='worklogs_type' and value='backup' } and trashed=false",
        fields: 'files(id,name,modifiedTime,size,mimeType,appProperties),nextPageToken',
        orderBy: 'modifiedTime desc',
        pageSize: '100',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const result = await google.request(`/drive/v3/files?${params}`);
      files.push(...(result.files || []).filter(file => file.mimeType === 'application/json' || !file.mimeType));
      const next = typeof result.nextPageToken === 'string' ? result.nextPageToken : '';
      if (!next || seenTokens.has(next)) break;
      seenTokens.add(next);
      pageToken = next;
    } while (pageToken);
    return files.map(backupInfo);
  };
  const downloadText = async (id) => {
    fileId(id);
    const raw = await google.request(`/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { responseType: 'text' });
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (Buffer.byteLength(text, 'utf8') > MAX_BACKUP_BYTES) fail('La sauvegarde Google est trop volumineuse (20 Mo max).', 413);
    return text;
  };
  /** Remplace (PATCH) ou crée (POST) le fichier canonique `WorkLogs backup.json`. */
  const writeCanonical = async (payload, canonical) => {
    const multipart = multipartBackup(BACKUP_NAME, payload);
    const target = canonical
      ? `/upload/drive/v3/files/${fileId(canonical.id)}?uploadType=multipart&supportsAllDrives=true&fields=id,name,modifiedTime,size,mimeType`
      : '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,modifiedTime,size,mimeType';
    const result = await google.request(target, {
      method: canonical ? 'PATCH' : 'POST',
      headers: { 'Content-Type': multipart.contentType },
      body: multipart.body,
    });
    if (!result?.id) fail(`Google n’a pas confirmé le ${canonical ? 'remplacement' : 'création'} de la sauvegarde.`, 502);
    return backupInfo({ ...result, name: result.name || BACKUP_NAME, mimeType: 'application/json', size: result.size || Buffer.byteLength(payload, 'utf8') });
  };
  const downloadBackup = async (id) => {
    const text = await downloadText(id);
    try { return validateBackup(JSON.parse(text)); } catch (error) {
      if (error.status) throw error;
      fail('Le contenu de cette sauvegarde Google est invalide.', 422);
    }
  };
  const linked = (id) => {
    const link = db.prepare('SELECT * FROM google_documents WHERE entry_id=?').get(id);
    if (!link) fail('Ce document n’est pas encore associé à Google Drive.', 404);
    return link;
  };
  const reply = (id) => {
    const current = entry(id);
    return { ...decodeEntry(current), google_sync: googleLink(db, current), attachments: db.prepare('SELECT * FROM attachments WHERE entry_id=?').all(id).map((row) => {
      const { drive_file_id: _snake, driveFileId: _camel, ...rest } = row;
      return { ...rest, driveFileId: _snake || _camel || null };
    }) };
  };
  const busy = new Set();
  const exclusive = async (id, fn) => {
    if (busy.has(id)) fail('Une synchronisation est déjà en cours.', 409);
    busy.add(id);
    try { return await fn(); } finally { busy.delete(id); }
  };

  const sync = google && autoSync ? createSyncEngine({ db, uploadDir, drive: {
    connected: () => Boolean(google.status().connected),
    uploadMissingAttachments: () => uploadMissingAttachments(db, google, uploadDir),
    listBackups: () => backupList(),
    downloadText: (id) => downloadText(id),
    writeCanonical: (payload, file) => writeCanonical(payload, file),
    downloadMissingAttachments: (attachments) => downloadMissingAttachments(db, google, uploadDir, attachments),
  } }) : null;
  if (sync) { app.locals.googleSync = sync; sync.start(); }
  // Première connexion (ou nouveau compte) : on synchronise tout de suite, sans attendre la minute.
  const kick = () => {
    if (sync && google.status().connected && !sync.status().lastSyncedAt && sync.status().state !== 'syncing') void sync.syncNow();
  };
  app.get('/api/google/status', (_req, res) => {
    kick();
    res.json(google ? { ...google.status(), sync: sync?.status() ?? null } : { available: false, configured: false, connected: false, pending: false, error: '', selectedIds: [] });
  });
  app.get('/api/google/sync', (_req, res) => {
    kick();
    res.json(sync?.status() ?? { state: 'off', error: '', lastSyncedAt: null, revision: 0 });
  });
  route('post', '/api/google/sync', async (_req, res) => {
    if (!sync) fail('La synchronisation automatique est disponible dans l’application desktop.', 503);
    await sync.syncNow();
    res.json(sync.status());
  });
  route('post', '/api/google/configure', (req, res) => res.json(google.configure(req.body)));
  route('post', '/api/google/use-builtin', (_req, res) => res.json(google.useBuiltin()));
  route('post', '/api/google/connect', async (_req, res) => res.json(await google.connect()));
  route('post', '/api/google/disconnect', async (_req, res) => { sync?.reset(); res.json(await google.disconnect()); });
  route('get', '/api/google/documents/:id/tabs', async (req, res) => {
    const id = fileId(req.params.id);
    const source = await google.request(`/docs/v1/documents/${id}?includeTabsContent=true`);
    res.json({ tabs: documentTabs(source).map(tab => {
      try { googleToDocument(selectDocumentTab(source, tab.id)); return { ...tab, editable: true }; }
      catch (e) { if (e.status !== 422) throw e; return { ...tab, editable: true, reason: e.message }; }
    }) });
  });
  route('get', '/api/google/backup/list', async (_req, res) => {
    res.json({ files: await backupList() });
  });
  route('post', '/api/google/backup/export', async (_req, res) => exclusive('backup-export', async () => {
    // D'abord les binaires : le JSON référence ensuite leurs `driveFileId`.
    // Best-effort : un binaire trop gros ou refusé reste « local seul ».
    const uploadedBinaries = await uploadMissingAttachments(db, google, uploadDir);
    const payload = JSON.stringify(buildBackup(db));
    if (Buffer.byteLength(payload, 'utf8') > MAX_BACKUP_BYTES) fail('La sauvegarde est trop volumineuse (20 Mo max).', 413);

    // Un export réutilise le fichier applicatif. Les anciennes sauvegardes
    // horodatées sont nettoyées seulement après le remplacement réussi.
    const existing = await backupList();
    const canonical = existing.find((file) => file.name === BACKUP_NAME) || existing[0];
    // Synchro active : « Sauvegarder » fusionne au lieu d'écraser ce que le téléphone a écrit.
    const result = sync ? await (async () => {
      await sync.syncNow();
      if (sync.status().state === 'error') fail(sync.status().error, 502);
      const files = await backupList();
      return files.find((file) => file.name === BACKUP_NAME) || files[0];
    })() : await writeCanonical(payload, canonical);

    // Une panne pendant le nettoyage ne doit pas invalider la sauvegarde déjà
    // écrite ; le prochain export retentera la mise à la corbeille.
    for (const duplicate of existing.filter((file) => file.id !== result.id)) {
      try {
        await google.request(`/drive/v3/files/${fileId(duplicate.id)}?supportsAllDrives=true&fields=id,trashed`, {
          method: 'PATCH',
          body: JSON.stringify({ trashed: true }),
        });
      } catch {
        // Best-effort : ne jamais perdre le backup canonique pour un doublon inaccessible.
      }
    }

    res.status(201).json({ ...result, binaries: uploadedBinaries });
  }));
  route('get', '/api/google/backup/:id', async (req, res) => {
    res.json(await downloadBackup(req.params.id));
  });
  route('post', '/api/google/backup/:id/import', async (req, res) => {
    const data = await downloadBackup(req.params.id);
    const restored = restoreBackup(db, data);
    const { binaries, missing } = await downloadMissingAttachments(db, google, uploadDir, data.attachments || []);
    res.json({ ...restored, binaries, missingFiles: missing });
  });
  // État simple pour le panneau : combiens sur Drive, combiens manquent en local.
  route('get', '/api/google/attachments/status', async (_req, res) => {
    const rows = db.prepare('SELECT stored, drive_file_id FROM attachments').all();
    let onDrive = 0;
    let missingLocal = 0;
    for (const row of rows) {
      if (row.drive_file_id) onDrive++;
      if (!fs.existsSync(path.join(uploadDir, path.basename(row.stored)))) missingLocal++;
    }
    res.json({ total: rows.length, onDrive, missingLocal, connected: Boolean(google) });
  });
  route('post', '/api/google/attachments/:id/fetch', async (req, res) => {
    const row = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
    if (!row) fail('pièce jointe introuvable', 404);
    const target = path.join(uploadDir, path.basename(row.stored));
    if (fs.existsSync(target)) {
      const { drive_file_id: _snake, ...rest } = row;
      res.json({ ...rest, driveFileId: _snake || null, fetched: false });
      return;
    }
    const driveFileId = row.drive_file_id || '';
    if (!driveFileId) fail('Ce fichier n’est pas encore sur Google Drive. Exporte une sauvegarde pour l’y envoyer.', 404);
    fileId(driveFileId);
    try {
      const binary = await google.request(`/drive/v3/files/${driveFileId}?alt=media&supportsAllDrives=true`, { responseType: 'arraybuffer' });
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(target, Buffer.isBuffer(binary) ? binary : Buffer.from(binary));
    } catch {
      fail('Google Drive est injoignable ou le fichier n’y est plus accessible. Vérifie la connexion puis réessaie.', 502);
    }
    const fresh = db.prepare('SELECT * FROM attachments WHERE id=?').get(row.id);
    const { drive_file_id: _snake, ...rest } = fresh;
    res.json({ ...rest, driveFileId: _snake || null, fetched: true });
  });
  route('get', '/api/google/outbox/list', async (_req, res) => {
    const params = new URLSearchParams({
      q: "appProperties has { key='worklogs_type' and value='outbox' } and trashed=false",
      fields: 'files(id,name,modifiedTime,size,mimeType),nextPageToken',
      orderBy: 'modifiedTime desc',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const result = await google.request(`/drive/v3/files?${params}`);
    res.json({ files: (result.files || []).filter(file => file.mimeType === 'application/json' || !file.mimeType).map(backupInfo) });
  });
  route('post', '/api/google/outbox/:id/import', async (req, res) => {
    fileId(req.params.id);
    const raw = await google.request(`/drive/v3/files/${req.params.id}?alt=media&supportsAllDrives=true`, { responseType: 'text' });
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (Buffer.byteLength(text, 'utf8') > MAX_BACKUP_BYTES) fail('La boîte mobile est trop volumineuse (20 Mo max).', 413);
    let data;
    try { data = validateOutbox(JSON.parse(text)); } catch (error) {
      if (error.status) throw error;
      fail('Le contenu de cette boîte mobile est invalide.', 422);
    }
    res.json(await importOutbox(db, { google, uploadDir }, data));
  });
  route('get', '/api/google/documents', async (req, res) => {
    const params = new URLSearchParams({ q: "mimeType='application/vnd.google-apps.document' and trashed=false", fields: 'files(id,name,modifiedTime),nextPageToken', orderBy: 'modifiedTime desc', pageSize: '100', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (typeof req.query.page_token === 'string' && req.query.page_token.length < 5000) params.set('pageToken', req.query.page_token);
    const result = await google.request(`/drive/v3/files?${params}`);
    const files = result.files || [];
    const selectedIds = google.status().selectedIds || [];
    const warnings = [];
    if (!params.has('pageToken')) {
      // La sélection OAuth peut ne pas encore être indexée dans files.list.
      for (const id of selectedIds.slice(0, 100)) {
        fileId(id);
        if (files.some(file => file.id === id)) continue;
        try {
          const file = await google.request(`/drive/v3/files/${id}?fields=id,name,modifiedTime,mimeType,trashed&supportsAllDrives=true`);
          if (!file.trashed && file.mimeType === 'application/vnd.google-apps.document') files.push(file);
        } catch (e) {
          if (e.code || ![403, 404].includes(e.status)) throw e;
          warnings.push('Un document sélectionné n’est plus accessible. Sélectionne-le à nouveau dans Drive.');
        }
      }
    }
    files.sort((a, b) => Number(selectedIds.includes(b.id)) - Number(selectedIds.includes(a.id)));
    res.json({ ...result, files: files.map(file => ({ ...file, ...localDocument(file.id) })), warnings: [...new Set(warnings)] });
  });
  // Ranger un document dans un projet : toutes ses copies locales (une par onglet).
  route('post', '/api/google/documents/:id/project', async (req, res) => {
    const documentId = fileId(req.params.id);
    const projectId = req.body?.project_id || null;
    if (projectId !== null && (typeof projectId !== 'string' || !db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))) fail('projet introuvable');
    const changed = db.prepare('UPDATE entries SET project_id=?, updated_at=? WHERE id IN (SELECT entry_id FROM google_documents WHERE document_id=?)')
      .run(projectId, nowISO(), documentId).changes;
    if (!changed) fail('Ouvre d’abord ce document dans WorkLogs pour le ranger dans un projet.', 409);
    res.json({ ok: true, entries: changed, ...localDocument(documentId) });
  });
  // Corbeille Google Drive (récupérable 30 jours) puis retrait des copies locales.
  route('post', '/api/google/documents/:id/trash', async (req, res) => {
    const documentId = fileId(req.params.id);
    await google.request(`/drive/v3/files/${documentId}?supportsAllDrives=true&fields=id,trashed`, { method: 'PATCH', body: JSON.stringify({ trashed: true }) });
    const ids = db.prepare('SELECT entry_id FROM google_documents WHERE document_id=?').all(documentId).map(row => row.entry_id);
    for (const id of ids) removeLocalEntry(id);
    res.json({ ok: true, removed: ids.length });
  });
  route('post', '/api/google/documents', async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 240) fail('Le titre doit contenir entre 1 et 240 caractères.');
    await exclusive('create-document', async () => {
      const created = await google.request('/docs/v1/documents', { method: 'POST', body: JSON.stringify({ title }) });
      const documentId = fileId(created.documentId);
      const rich = googleToDocument(created.body?.content || created.tabs?.length ? selectDocumentTab(created) : blankSource), serialized = JSON.stringify(rich);
      const id = uid('en_'), time = nowISO();
      // Associer immédiatement le fichier : une panne réseau après création ne doit pas le masquer.
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO entries (id,title,content_md,content_json,entry_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, title, '', serialized, today(), time, time);
        db.prepare('INSERT INTO google_documents (entry_id,document_id,tab_id,revision_id,synced_content_json,synced_at) VALUES (?,?,?,?,?,?)')
          .run(id, documentId, documentTabs(created)[0]?.id || '', created.revisionId || '', serialized, time);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      res.status(201).json(reply(id));
    });
  });
  route('post', '/api/google/documents/open', async (req, res) => {
    const documentId = fileId(req.body?.document_id);
    const wanted = req.body?.tab_id ?? '';
    if (typeof wanted !== 'string' || (wanted && !/^[\w.-]{1,200}$/.test(wanted))) fail('Identifiant d’onglet Google invalide.');
    await exclusive(documentId, async () => {
      const source = await readSource(documentId);
      const tabs = documentTabs(source);
      const list = tabs.length ? tabs : [{ id: '', title: source.title || 'Document', depth: 0 }];
      if (wanted && !list.some(tab => tab.id === wanted)) fail('Onglet Google introuvable.', 404);
      const documentTitle = source.title || 'Document Google';
      const time = nowISO();
      let first = null;
      let asked = null;

      // Tous les onglets sont ouverts d'un coup : ils forment un seul document
      // dans le journal. Les éléments Google natifs restent dans leur onglet ;
      // les cellules et le texte autour restent éditables et synchronisables.
      for (const [order, tab] of list.entries()) {
        const existing = db.prepare('SELECT * FROM google_documents WHERE document_id=? AND tab_id=?').get(documentId, tab.id)
          ?? (tab.id && order === 0 ? db.prepare("SELECT * FROM google_documents WHERE document_id=? AND tab_id=''").get(documentId) : undefined);
        if (existing) {
          db.prepare('UPDATE google_documents SET document_title=?, tab_title=?, tab_order=?, tab_depth=?, tab_id=? WHERE entry_id=?')
            .run(documentTitle, tab.title, order, tab.depth, tab.id, existing.entry_id);
          // Refresh clean snapshots after native Google editing, including the
          // other tabs. Dirty local drafts keep their original merge base.
          if (entry(existing.entry_id).content_json === existing.synced_content_json) {
            const rich = googleToDocument(selectDocumentTab(source, tab.id)), serialized = JSON.stringify(rich);
            db.prepare('UPDATE entries SET content_json=?,content_md=? WHERE id=?').run(serialized, documentText(rich), existing.entry_id);
            db.prepare("UPDATE google_documents SET synced_content_json=?,revision_id=?,synced_at=?,readonly_reason='' WHERE entry_id=?")
              .run(serialized, source.revisionId || '', time, existing.entry_id);
          }
          first ??= existing.entry_id;
          if (tab.id === wanted) asked = existing.entry_id;
          continue;
        }
        const rich = googleToDocument(selectDocumentTab(source, tab.id));
        const id = uid('en_');
        db.exec('BEGIN');
        try {
          db.prepare('INSERT INTO entries (id,title,content_md,content_json,entry_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
            .run(id, list.length > 1 ? `${documentTitle} — ${tab.title}` : documentTitle, documentText(rich), JSON.stringify(rich), today(), time, time);
          db.prepare('INSERT INTO google_documents (entry_id,document_id,tab_id,revision_id,synced_content_json,synced_at,document_title,tab_title,tab_order,tab_depth) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(id, documentId, tab.id, source.revisionId || '', JSON.stringify(rich), time, documentTitle, tab.title, order, tab.depth);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        first ??= id;
        if (tab.id === wanted) asked = id;
      }
      res.status(201).json(reply(asked ?? first));
    });
  });

  route('post', '/api/entries/:id/google/push', async (req, res) => {
    const id = req.params.id;
    await exclusive(db.prepare('SELECT document_id FROM google_documents WHERE entry_id=?').get(id)?.document_id || id, async () => {
      const current = entry(id);
      if (!current.content_json) fail('Crée un document riche pour le synchroniser avec Google Drive.');
      let rich = JSON.parse(current.content_json);
      let link = db.prepare('SELECT * FROM google_documents WHERE entry_id=?').get(id);
      // Les anciens imports aplatis doivent être rechargés : ils ne contiennent
      // pas les repères nécessaires à la conservation des éléments Google.
      if (link?.readonly_reason) {
        fail('Cet ancien import a été aplati. Garde une copie locale de tes modifications puis recharge depuis Google pour activer la nouvelle synchronisation.', 422);
      }
      if (!link) {
        // Vérifier le format AVANT de créer un fichier distant.
        buildGoogleUpdate({ revisionId: 'check', body: { content: [{ paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } }, rich);
        const created = await google.request('/docs/v1/documents', { method: 'POST', body: JSON.stringify({ title: current.title }) });
        const source = await read(created.documentId);
        // L'entrée peut avoir été supprimée pendant la requête Google.
        entry(id);
        db.prepare('INSERT INTO google_documents (entry_id,document_id,tab_id,revision_id,synced_content_json) VALUES (?,?,?,?,?)')
          .run(id, created.documentId, documentBody(source).tabId || '', source.revisionId || '', JSON.stringify(googleToDocument(source)));
        link = linked(id);
      }
      const source = await read(link.document_id, link.tab_id);
      const unchangedNewDocument = !link.revision_id && JSON.stringify(googleToDocument(source)) === link.synced_content_json;
      if (!unchangedNewDocument && source.revisionId !== link.revision_id) {
        if (!link.revision_id) fail('Le document a changé sur Google Drive. Ton brouillon local est conservé.', 409);
        rich = mergeGoogleChanges(JSON.parse(link.synced_content_json), rich, googleToDocument(source));
      }
      const update = buildPreservingUpdate(source, rich);
      const result = update.requests.length ? await google.request(`/docs/v1/documents/${link.document_id}:batchUpdate`, { method: 'POST', body: JSON.stringify(update) }) : { writeControl: { requiredRevisionId: source.revisionId } };
      const revision = result.writeControl?.requiredRevisionId;
      if (!revision) fail('Google a reçu la mise à jour sans renvoyer sa révision. Recharge la version Google pour vérifier l’enregistrement.', 502);
      // Google revisions belong to the whole document. Our own write must not
      // create a false conflict on the other tabs read at that same revision.
      db.prepare('UPDATE google_documents SET revision_id=? WHERE document_id=? AND revision_id=? AND entry_id<>?').run(revision, link.document_id, source.revisionId, id);
      const serialized = JSON.stringify(rich);
      // Rebase any concurrent local save onto the merged Google snapshot. Otherwise
      // the next push could mistake unseen remote edits for deliberate deletions.
      // If these overlap, retain the old base and draft so the next push still
      // detects the conflict, even though Google accepted the earlier snapshot.
      const latest = entry(id);
      const local = latest.content_json === current.content_json ? rich
        : mergeGoogleChanges(JSON.parse(current.content_json), JSON.parse(latest.content_json), rich);
      db.prepare('UPDATE entries SET content_json=?,content_md=? WHERE id=?')
        .run(JSON.stringify(local), documentText(local), id);
      db.prepare('UPDATE google_documents SET revision_id=?,synced_content_json=?,synced_at=? WHERE entry_id=?')
        .run(revision, serialized, nowISO(), id);
      res.json(reply(id));
    });
  });
  route('post', '/api/entries/:id/google/pull', async (req, res) => {
    const id = req.params.id;
    await exclusive(db.prepare('SELECT document_id FROM google_documents WHERE entry_id=?').get(id)?.document_id || id, async () => {
      const current = entry(id), link = linked(id);
      if (JSON.stringify(req.body?.expected_content_json) !== current.content_json) fail('Le brouillon a changé. Enregistre-le avant de recharger Google.', 409);
      const source = await read(link.document_id, link.tab_id), rich = googleToDocument(source);
      if (entry(id).content_json !== current.content_json) fail('Tu as modifié le brouillon pendant le rechargement. Il a été conservé.', 409);
      const serialized = JSON.stringify(rich), time = nowISO();
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE entries SET content_json=?,content_md=?,updated_at=? WHERE id=?').run(serialized, documentText(rich), time, id);
        db.prepare("UPDATE google_documents SET revision_id=?,synced_content_json=?,synced_at=?,readonly_reason='' WHERE entry_id=?").run(source.revisionId || '', serialized, time, id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      res.json(reply(id));
    });
  });
}
