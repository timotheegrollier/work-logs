import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleUpdate, documentTabs, googleToDocument, selectDocumentTab, isDefaultInk } from '../src/google-document.js';
import { startApi, make } from './helpers.js';

const doc = (text = 'Bonjour') => ({ documentId: 'google-123', title: 'Document Google', revisionId: 'r1',
  tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [
    { endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: text.length + 2, paragraph: {
      paragraphStyle: { namedStyleType: 'HEADING_2', alignment: 'CENTER' }, elements: [{ textRun: { content: text + '\n', textStyle: { bold: true } } }],
    } },
  ] } } }] });

test('importe titres, alignement et styles puis écrit sur la bonne révision et le bon onglet', () => {
  const source = doc('Bonjour 😀');
  const rich = googleToDocument(source);
  assert.equal(rich.content[0].attrs.level, 2);
  assert.equal(rich.content[0].attrs.textAlign, 'center');
  assert.deepEqual(rich.content[0].content[0].marks, [{ type: 'bold' }]);
  rich.content[0].content[0].text = 'Bonjour 😃 !';
  const update = buildGoogleUpdate(source, rich);
  assert.deepEqual(update.writeControl, { requiredRevisionId: 'r1' });
  let text = 'Bonjour 😀\n';
  for (const request of update.requests) {
    if (request.deleteContentRange) {
      const r = request.deleteContentRange.range;
      assert.equal(r.tabId, 't.0');
      assert.ok(r.endIndex <= text.length, 'préserve le dernier saut de paragraphe');
      text = text.slice(0, r.startIndex - 1) + text.slice(r.endIndex - 1);
    }
    if (request.insertText) {
      const { location, text: added } = request.insertText;
      text = text.slice(0, location.index - 1) + added + text.slice(location.index - 1);
    }
  }
  assert.equal(text, 'Bonjour 😃 !\n');
});

test('refuse les contenus non pris en charge et les révisions absentes au lieu de les aplatir', () => {
  const table = doc(); table.tabs[0].documentTab.body.content.push({ table: {} });
  assert.throws(() => googleToDocument(table), /tableaux/);
  const suggestion = doc(); suggestion.suggestedDocumentStyleChanges = { suggestion: {} };
  assert.throws(() => googleToDocument(suggestion), /suggestions/);
  const tabs = doc(); tabs.tabs.push(tabs.tabs[0]);
  assert.throws(() => googleToDocument(tabs), /plusieurs onglets/);
  const source = doc(); delete source.revisionId;
  assert.throws(() => buildGoogleUpdate(source, googleToDocument(source)), /Révision/);
});

function stub() {
  let source = doc();
  const calls = [];
  return { calls, setSource(next) { source = next; },
    status: () => ({ available: true, configured: true, connected: true, pending: false, selectedIds: [] }),
    configure: () => ({ configured: true }), connect: async () => ({ pending: true }), disconnect: async () => ({ connected: false }),
    async request(url, options) {
      calls.push({ url, options });
      if (url.includes('/comments?')) return { comments: [] };
      if (url.endsWith(':batchUpdate')) { source.revisionId = 'r2'; return { writeControl: { requiredRevisionId: 'r2' } }; }
      if (url.startsWith('/drive/v3/files?')) return { files: [{ id: source.documentId, name: source.title }] };
      if (url === '/docs/v1/documents') return source;
      return structuredClone(source);
    },
  };
}

test('API Drive : configuration, sélection, import idempotent, envoi et conflit sans perte locale', async () => {
  const google = stub(), api = await startApi({ google });
  try {
    assert.equal((await api.get('/api/google/status')).body.connected, true);
    assert.equal((await api.post('/api/google/configure', {})).body.configured, true);
    assert.equal((await api.post('/api/google/connect')).body.pending, true);
    assert.equal((await api.get('/api/google/documents')).body.files.length, 1);
    assert.equal((await api.post('/api/google/documents/open', { document_id: '../secrets' })).status, 400);
    const opened = await api.post('/api/google/documents/open', { document_id: 'google-123' });
    assert.equal(opened.status, 201);
    const id = opened.body.id;
    assert.equal((await api.post('/api/google/documents/open', { document_id: 'google-123' })).body.id, id);
    const rich = opened.body.content_json;
    rich.content[0].content[0].text = 'Modification locale';
    await api.put(`/api/entries/${id}`, { content_json: rich });
    const pushed = await api.post(`/api/entries/${id}/google/push`);
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.google_sync.dirty, false);
    const changed = doc('Modification distante'); changed.revisionId = 'r3'; google.setSource(changed);
    const writes = google.calls.filter(c => c.url.endsWith(':batchUpdate')).length;
    assert.equal((await api.post(`/api/entries/${id}/google/push`)).status, 409);
    assert.equal(google.calls.filter(c => c.url.endsWith(':batchUpdate')).length, writes);
    assert.deepEqual((await api.get(`/api/entries/${id}`)).body.content_json, rich);
    assert.equal((await api.post(`/api/entries/${id}/google/pull`, { expected_content_json: {} })).status, 409);
    const pulled = await api.post(`/api/entries/${id}/google/pull`, { expected_content_json: rich });
    assert.equal(pulled.status, 200);
    assert.match(pulled.body.content_md, /Modification distante/);
    await api.del(`/api/entries/${id}`);
    assert.equal(api.db.prepare('SELECT COUNT(*) n FROM google_documents').get().n, 0);
    assert.equal(google.calls.filter(c => c.options?.method === 'DELETE').length, 0, 'supprimer localement ne supprime pas le fichier Google');
    assert.equal((await api.post('/api/google/disconnect')).body.connected, false);
  } finally { await api.close(); }
});

test('nouveau document synchronisé : aucun fichier créé si le format local est incompatible', async () => {
  const google = stub(), api = await startApi({ google });
  try {
    const unsupported = await make.entry(api, { content_json: { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.com/image.png' } }] } });
    assert.equal((await api.post(`/api/entries/${unsupported.id}/google/push`)).status, 422);
    assert.equal(google.calls.length, 0);
    const supported = await make.entry(api, { content_json: googleToDocument(doc('Nouveau')) });
    assert.equal((await api.post(`/api/entries/${supported.id}/google/push`)).status, 200);
    assert.equal(google.calls.filter(c => c.url === '/docs/v1/documents').length, 1);
  } finally { await api.close(); }
});

test('mode web : Drive indisponible sans exposer de connexion privilégiée', async () => {
  const api = await startApi();
  try {
    assert.equal((await api.get('/api/google/status')).body.available, false);
    assert.equal((await api.post('/api/google/connect')).status, 503);
  } finally { await api.close(); }
});

test('création directe : titre validé, association immédiate, premier envoi protégé même sans révision de création', async () => {
  const google = stub();
  const blank = { documentId: 'new-google', title: 'Projet', body: { content: [{ paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } };
  google.setSource(blank);
  const api = await startApi({ google });
  try {
    for (const title of ['', ' ', 'a'.repeat(241), 123]) assert.equal((await api.post('/api/google/documents', { title })).status, 400);
    assert.equal(google.calls.length, 0);
    const created = await api.post('/api/google/documents', { title: ' Projet ' });
    assert.equal(created.status, 201);
    assert.equal(created.body.title, 'Projet');
    assert.equal(created.body.google_sync.document_id, 'new-google');
    assert.equal(google.calls.length, 1, 'ne dépend pas d’une seconde lecture réseau pour retrouver le fichier créé');
    assert.equal((await api.post('/api/google/documents/open', { document_id: 'new-google' })).body.id, created.body.id);
    await api.put(`/api/entries/${created.body.id}`, { content_json: googleToDocument(doc('Mon brouillon')) });
    google.setSource({ ...blank, revisionId: 'r1' });
    assert.equal((await api.post(`/api/entries/${created.body.id}/google/push`)).status, 200);
    const write = google.calls.find(call => call.url.endsWith(':batchUpdate'));
    assert.equal(JSON.parse(write.options.body).writeControl.requiredRevisionId, 'r1');
  } finally { await api.close(); }
});

test('création sans révision : une modification distante avant le premier envoi conserve le brouillon', async () => {
  const google = stub();
  google.setSource({ documentId: 'new-google' });
  const api = await startApi({ google });
  try {
    const created = await api.post('/api/google/documents', { title: 'Nouveau' });
    google.setSource(doc('Quelqu’un écrit déjà sur Google'));
    assert.equal((await api.post(`/api/entries/${created.body.id}/google/push`)).status, 409);
    assert.equal(google.calls.filter(call => call.url.endsWith(':batchUpdate')).length, 0);
  } finally { await api.close(); }
});

test('liste : retrouve un fichier sélectionné absent de l’index, le place en tête et signale les accès perdus', async () => {
  const google = stub(), original = google.request;
  google.status = () => ({ selectedIds: ['selected', 'revoked'] });
  google.request = async (url, options) => {
    if (url.startsWith('/drive/v3/files/selected?')) return { id: 'selected', name: 'Sélection récente', mimeType: 'application/vnd.google-apps.document' };
    if (url.startsWith('/drive/v3/files/revoked?')) throw Object.assign(new Error('refus'), { status: 403 });
    return original(url, options);
  };
  const api = await startApi({ google });
  try {
    const result = await api.get('/api/google/documents');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.files.map(file => file.id), ['selected', 'google-123']);
    assert.match(result.body.warnings[0], /sélectionné/);
    assert.match(google.calls[0].url, /includeItemsFromAllDrives=true/);
  } finally { await api.close(); }
});

test('propage une API désactivée avec son action et ne crée aucune entrée si Google échoue', async () => {
  const google = stub();
  google.request = async () => { throw Object.assign(new Error('API désactivée'), { status: 403, code: 'GOOGLE_API_DISABLED', help_url: 'https://console.cloud.google.com/apis/library/docs.googleapis.com' }); };
  const api = await startApi({ google });
  try {
    const result = await api.post('/api/google/documents', { title: 'Nouveau' });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'GOOGLE_API_DISABLED');
    assert.match(result.body.help_url, /docs.googleapis.com$/);
    assert.equal(api.db.prepare('SELECT count(*) n FROM entries').get().n, 0);
  } finally { await api.close(); }
});

test('onglets Google : choix explicite, brouillons distincts et toutes les écritures ciblées sur le sous-onglet', async () => {
  const google = stub(), source = doc('Premier');
  const second = doc('Sous-onglet').tabs[0];
  second.tabProperties = { tabId: 't.child', title: 'Deuxième' };
  source.tabs[0].childTabs = [second];
  google.setSource(source);
  assert.deepEqual(documentTabs(source).map(t => t.depth), [0, 1]);
  assert.throws(() => selectDocumentTab(source), /choisis un onglet/);
  const api = await startApi({ google });
  try {
    const tabs = await api.get('/api/google/documents/google-123/tabs');
    assert.equal(tabs.body.tabs.length, 2);
    assert.equal(tabs.body.tabs[1].editable, true);
    // Ouvrir sans préciser d'onglet ne refuse plus : tous les onglets du
    // document sont créés d'un coup et forment un seul document dans le journal.
    const tout = await api.post('/api/google/documents/open', { document_id: 'google-123' });
    assert.equal(tout.status, 201);
    const ouverts = api.db.prepare('SELECT tab_id, tab_title, tab_order FROM google_documents WHERE document_id=? ORDER BY tab_order').all('google-123');
    assert.deepEqual(ouverts.map(o => o.tab_id), ['t.0', 't.child']);
    assert.equal(ouverts[1].tab_title, 'Deuxième');

    const first = await api.post('/api/google/documents/open', { document_id: 'google-123', tab_id: 't.0' });
    const child = await api.post('/api/google/documents/open', { document_id: 'google-123', tab_id: 't.child' });
    assert.equal(child.status, 201);
    assert.notEqual(first.body.id, child.body.id);
    assert.equal(child.body.google_sync.tab_id, 't.child');
    assert.match(child.body.content_md, /Sous-onglet/);
    assert.equal((await api.post('/api/google/documents/open', { document_id: 'google-123', tab_id: 't.child' })).body.id, child.body.id);
    await api.put(`/api/entries/${child.body.id}`, { content_json: googleToDocument(doc('Modifié')) });
    assert.equal((await api.post(`/api/entries/${child.body.id}/google/push`)).status, 200);
    const write = JSON.parse(google.calls.find(c => c.url.endsWith(':batchUpdate')).options.body);
    for (const request of write.requests) {
      const operation = Object.values(request)[0];
      assert.equal((operation.range || operation.location).tabId, 't.child');
    }
    assert.match((await api.get(`/api/entries/${first.body.id}`)).body.content_md, /Premier/);
    source.tabs[0].childTabs = []; google.setSource(source);
    assert.equal((await api.post(`/api/entries/${child.body.id}/google/pull`, { expected_content_json: googleToDocument(doc('Modifié')) })).status, 422);
    assert.match((await api.get(`/api/entries/${child.body.id}`)).body.content_md, /Modifié/);
  } finally { await api.close(); }
});


test('le noir par défaut de Google n’est pas importé comme couleur', () => {
  // En thème sombre, un texte noir explicite est illisible. Un document Google
  // jamais colorié arrive pourtant en #000000 : on le traite comme « pas de
  // couleur », le thème s'applique, et l'écriture ne touche pas l'original.
  assert.equal(isDefaultInk('#000000'), true);
  assert.equal(isDefaultInk('#111111'), true);
  assert.equal(isDefaultInk('#222222'), true);
  // Une couleur réellement choisie reste une couleur.
  assert.equal(isDefaultInk('#232323'), false);
  assert.equal(isDefaultInk('#1a73e8'), false);
  assert.equal(isDefaultInk('#ff0000'), false);
  assert.equal(isDefaultInk(''), false);
  assert.equal(isDefaultInk(null), false);
});

test('un texte en noir par défaut arrive sans marque de couleur', () => {
  const source = doc('Texte');
  const run = source.tabs[0].documentTab.body.content[1].paragraph.elements[0];
  run.textRun.textStyle = { foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } } };
  const rich = googleToDocument(source);
  const marks = JSON.stringify(rich);
  assert.equal(marks.includes('"color"'), false, 'aucune couleur ne doit être posée');

  // Une vraie couleur, elle, doit survivre à l'import.
  run.textRun.textStyle = { foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } } };
  assert.match(JSON.stringify(googleToDocument(source)), /"color":"#ff0000"/);
});


test('un onglet non convertible s’ouvre en lecture seule au lieu d’être refusé', async () => {
  const google = stub();
  const source = doc('Premier onglet');
  // Deuxième onglet avec un tableau : le convertisseur le refuse, car il ne
  // saurait le réécrire fidèlement dans Google.
  const second = doc('Ignoré').tabs[0];
  second.tabProperties = { tabId: 't.tableau', title: 'Chiffres' };
  second.documentTab.body.content = [
    { paragraph: { elements: [{ textRun: { content: 'Budget\n' } }] } },
    { table: { tableRows: [{ tableCells: [
      { content: [{ paragraph: { elements: [{ textRun: { content: 'Toiture\n' } }] } }] },
      { content: [{ paragraph: { elements: [{ textRun: { content: '12 400 €\n' } }] } }] },
    ] }] } },
  ];
  source.tabs.push(second);
  google.setSource(source);

  const api = await startApi({ google });
  try {
    assert.equal((await api.post('/api/google/documents/open', { document_id: 'google-123' })).status, 201);
    const liens = api.db.prepare('SELECT entry_id, tab_id, readonly_reason FROM google_documents ORDER BY tab_order').all();
    assert.equal(liens.length, 2);
    assert.equal(liens[0].readonly_reason, '', 'l’onglet convertible reste modifiable');
    assert.match(liens[1].readonly_reason, /tableaux/, 'la raison du refus est conservée');

    // Consultable : le texte est là, tableau aplati, donc l'onglet n'est plus inaccessible.
    const lecture = await api.get(`/api/entries/${liens[1].entry_id}`);
    assert.match(lecture.body.content_md, /Budget/);
    assert.match(lecture.body.content_md, /Toiture/);
    assert.match(lecture.body.content_md, /12 400/);
    assert.equal(lecture.body.google_sync.readonly, liens[1].readonly_reason);
    assert.equal(lecture.body.google_sync.tab_title, 'Chiffres');
  } finally {
    await api.close();
  }
});
