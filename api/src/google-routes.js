import { uid, nowISO, today } from './db.js';
import { decodeEntry, documentText } from './rich-document.js';
import { buildGoogleUpdate, documentBody, documentTabs, selectDocumentTab } from './google-document.js';
import { buildPreservingUpdate, googlePreservedCount, importGoogleDocument as googleToDocument } from './google-preserve.js';

const blankSource = { body: { content: [{ paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } };

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const fileId = (value) => {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/.test(value)) fail('Identifiant de document Google invalide.');
  return value;
};
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
  const readSource = async (id) => {
    fileId(id);
    return google.request(`/docs/v1/documents/${id}?includeTabsContent=true`);
  };
  const read = async (id, tabId = '') => selectDocumentTab(await readSource(id), tabId);
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
  route('get', '/api/google/documents/:id/tabs', async (req, res) => {
    const id = fileId(req.params.id);
    const source = await google.request(`/docs/v1/documents/${id}?includeTabsContent=true`);
    res.json({ tabs: documentTabs(source).map(tab => {
      try { googleToDocument(selectDocumentTab(source, tab.id)); return { ...tab, editable: true }; }
      catch (e) { if (e.status !== 422) throw e; return { ...tab, editable: true, reason: e.message }; }
    }) });
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
    res.json({ ...result, files, warnings: [...new Set(warnings)] });
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
          // Upgrade old flattened imports only when no local content was edited.
          if (existing.readonly_reason && entry(existing.entry_id).content_json === existing.synced_content_json) {
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
      const rich = JSON.parse(current.content_json);
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
      if (!unchangedNewDocument && source.revisionId !== link.revision_id) fail('Le document a changé sur Google Drive. Ton brouillon local est conservé. Recharge la version Google ou garde une copie locale avant de continuer.', 409);
      const update = buildPreservingUpdate(source, rich);
      const result = update.requests.length ? await google.request(`/docs/v1/documents/${link.document_id}:batchUpdate`, { method: 'POST', body: JSON.stringify(update) }) : { writeControl: { requiredRevisionId: source.revisionId } };
      const revision = result.writeControl?.requiredRevisionId;
      if (!revision) fail('Google a reçu la mise à jour sans renvoyer sa révision. Recharge la version Google pour vérifier l’enregistrement.', 502);
      // Google revisions belong to the whole document. Our own write must not
      // create a false conflict on the other tabs read at that same revision.
      db.prepare('UPDATE google_documents SET revision_id=? WHERE document_id=? AND revision_id=?').run(revision, link.document_id, source.revisionId);
      db.prepare('UPDATE google_documents SET revision_id=?,synced_content_json=?,synced_at=? WHERE entry_id=?')
        .run(revision, current.content_json, nowISO(), id);
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
