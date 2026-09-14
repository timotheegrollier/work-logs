import { uid, nowISO, today } from './db.js';
import { decodeEntry, documentText } from './rich-document.js';
import { buildGoogleUpdate, googleToDocument } from './google-document.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const fileId = (value) => {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/.test(value)) fail('Identifiant de document Google invalide.');
  return value;
};
export function googleLink(db, entry) {
  const link = db.prepare('SELECT * FROM google_documents WHERE entry_id=?').get(entry.id);
  return link ? { document_id: link.document_id, synced_at: link.synced_at, dirty: entry.content_json !== link.synced_content_json } : null;
}

export function registerGoogleRoutes(app, { db, google }) {
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
  const read = async (id) => {
    fileId(id);
    const [source, comments] = await Promise.all([
      google.request(`/docs/v1/documents/${id}?includeTabsContent=true`),
      google.request(`/drive/v3/files/${id}/comments?fields=comments(id)&pageSize=1&includeDeleted=false`),
    ]);
    if (comments.comments?.length) fail('Ce document contient des commentaires Google. L’édition synchronisée de ces documents n’est pas encore prise en charge ; l’original reste intact.', 422);
    googleToDocument(source);
    return source;
  };
  const linked = (id) => {
    const link = db.prepare('SELECT * FROM google_documents WHERE entry_id=?').get(id);
    if (!link) fail('Ce document n’est pas encore associé à Google Drive.', 404);
    return link;
  };
  const reply = (id) => {
    const current = entry(id);
    return { ...decodeEntry(current), google_sync: googleLink(db, current), attachments: db.prepare('SELECT * FROM attachments WHERE entry_id=?').all(id) };
  };
  const busy = new Set();
  const exclusive = async (id, fn) => {
    if (busy.has(id)) fail('Une synchronisation est déjà en cours.', 409);
    busy.add(id);
    try { return await fn(); } finally { busy.delete(id); }
  };

  app.get('/api/google/status', (_req, res) => res.json(google ? google.status() : { available: false, configured: false, connected: false, pending: false, error: '', selectedIds: [] }));
  route('post', '/api/google/configure', (req, res) => res.json(google.configure(req.body)));
  route('post', '/api/google/connect', async (_req, res) => res.json(await google.connect()));
  route('post', '/api/google/disconnect', async (_req, res) => res.json(await google.disconnect()));
  route('get', '/api/google/documents', async (req, res) => {
    const params = new URLSearchParams({ q: "mimeType='application/vnd.google-apps.document' and trashed=false", fields: 'files(id,name,modifiedTime),nextPageToken', orderBy: 'modifiedTime desc', pageSize: '100' });
    if (typeof req.query.page_token === 'string' && req.query.page_token.length < 5000) params.set('pageToken', req.query.page_token);
    res.json(await google.request(`/drive/v3/files?${params}`));
  });
  route('post', '/api/google/documents/open', async (req, res) => {
    const documentId = fileId(req.body?.document_id);
    await exclusive(documentId, async () => {
      const existing = db.prepare('SELECT entry_id FROM google_documents WHERE document_id=?').get(documentId);
      if (existing) { res.json(reply(existing.entry_id)); return; }
      const source = await read(documentId);
      const rich = googleToDocument(source);
      const id = uid('en_'), time = nowISO();
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO entries (id,title,content_md,content_json,entry_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, source.title || 'Document Google', documentText(rich), JSON.stringify(rich), today(), time, time);
        db.prepare('INSERT INTO google_documents (entry_id,document_id,revision_id,synced_content_json,synced_at) VALUES (?,?,?,?,?)')
          .run(id, documentId, source.revisionId || '', JSON.stringify(rich), time);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      res.status(201).json(reply(id));
    });
  });
  route('post', '/api/entries/:id/google/push', async (req, res) => {
    const id = req.params.id;
    await exclusive(id, async () => {
      const current = entry(id);
      if (!current.content_json) fail('Crée un document riche pour le synchroniser avec Google Drive.');
      const rich = JSON.parse(current.content_json);
      let link = db.prepare('SELECT * FROM google_documents WHERE entry_id=?').get(id);
      if (!link) {
        // Vérifier le format AVANT de créer un fichier distant.
        buildGoogleUpdate({ revisionId: 'check', body: { content: [{ paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } }, rich);
        const created = await google.request('/docs/v1/documents', { method: 'POST', body: JSON.stringify({ title: current.title }) });
        const source = await read(created.documentId);
        // L'entrée peut avoir été supprimée pendant la requête Google.
        entry(id);
        db.prepare('INSERT INTO google_documents (entry_id,document_id,revision_id,synced_content_json) VALUES (?,?,?,?)')
          .run(id, created.documentId, source.revisionId || '', JSON.stringify(googleToDocument(source)));
        link = linked(id);
      }
      const source = await read(link.document_id);
      if (source.revisionId !== link.revision_id) fail('Le document a changé sur Google Drive. Ton brouillon local est conservé. Recharge la version Google ou garde une copie locale avant de continuer.', 409);
      const update = buildGoogleUpdate(source, rich);
      const result = await google.request(`/docs/v1/documents/${link.document_id}:batchUpdate`, { method: 'POST', body: JSON.stringify(update) });
      const revision = result.writeControl?.requiredRevisionId;
      if (!revision) fail('Google a reçu la mise à jour sans renvoyer sa révision. Recharge la version Google pour vérifier l’enregistrement.', 502);
      db.prepare('UPDATE google_documents SET revision_id=?,synced_content_json=?,synced_at=? WHERE entry_id=?')
        .run(revision, current.content_json, nowISO(), id);
      res.json(reply(id));
    });
  });
  route('post', '/api/entries/:id/google/pull', async (req, res) => {
    const id = req.params.id;
    await exclusive(id, async () => {
      const current = entry(id), link = linked(id);
      if (JSON.stringify(req.body?.expected_content_json) !== current.content_json) fail('Le brouillon a changé. Enregistre-le avant de recharger Google.', 409);
      const source = await read(link.document_id), rich = googleToDocument(source);
      if (entry(id).content_json !== current.content_json) fail('Tu as modifié le brouillon pendant le rechargement. Il a été conservé.', 409);
      const serialized = JSON.stringify(rich), time = nowISO();
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE entries SET content_json=?,content_md=?,updated_at=? WHERE id=?').run(serialized, documentText(rich), time, id);
        db.prepare('UPDATE google_documents SET revision_id=?,synced_content_json=?,synced_at=? WHERE entry_id=?').run(source.revisionId || '', serialized, time, id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      res.json(reply(id));
    });
  });
}
