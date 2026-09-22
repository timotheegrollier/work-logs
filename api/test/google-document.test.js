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
    configure: () => ({ configured: true }), useBuiltin: () => ({ configured: true, builtin: true }), connect: async () => ({ pending: true }), disconnect: async () => ({ connected: false }),
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
    assert.equal((await api.post('/api/google/use-builtin', {})).body.builtin, true);
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
    rich.content[0].content[0].text = 'Modification personnelle';
    await api.put(`/api/entries/${id}`, { content_json: rich });
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


test('un onglet avec tableau s’ouvre en conservant les cellules et peut être synchronisé', async () => {
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
    assert.equal(liens[1].readonly_reason, '', 'le tableau ne bloque plus l’onglet');

    // Le texte et les cellules du tableau sont conservés.
    const lecture = await api.get(`/api/entries/${liens[1].entry_id}`);
    assert.match(lecture.body.content_md, /Budget/);
    assert.match(lecture.body.content_md, /Toiture/);
    assert.match(lecture.body.content_md, /12 400/);
    assert.equal(lecture.body.google_sync.sync_blocked, liens[1].readonly_reason);
    assert.equal(lecture.body.google_sync.tab_title, 'Chiffres');

    // Modifiable : l'entrée s'écrit normalement en local.
    const modifie = await api.put(`/api/entries/${liens[1].entry_id}`, { title: 'Chiffres revus' });
    assert.equal(modifie.status, 200);
    assert.equal(modifie.body.title, 'Chiffres revus');

    // L’envoi sans changement de contenu est un succès sans réécriture du tableau.
    const envoi = await api.post(`/api/entries/${liens[1].entry_id}/google/push`);
    assert.equal(envoi.status, 200);
    assert.equal(lecture.body.content_json.content[1].type, 'table');
  } finally {
    await api.close();
  }
});


test('les commentaires ne bloquent plus l’import et les onglets restent accessibles après filtrage', async () => {
  const google = stub(), source = doc('Premier');
  const child = doc('Autre contenu').tabs[0];
  child.tabProperties = { tabId: 'child', title: 'Sous-onglet' };
  source.tabs[0].childTabs = [child];
  source.comments = [{ id: 'comment-1' }];
  google.setSource(source);
  const api = await startApi({ google });
  try {
    const opened = await api.post('/api/google/documents/open', { document_id: 'google-123' });
    assert.equal(opened.status, 201);
    const state = await api.get('/api/state?q=Premier');
    assert.equal(state.body.entries.length, 1);
    const entry = await api.get(`/api/entries/${opened.body.id}`);
    assert.equal(entry.body.google_sync.tabs.length, 2);
    assert.equal(entry.body.google_sync.tabs[1].google_tab_depth, 1);
    assert.equal(google.calls.some(call => call.url.includes('/comments?')), false);
    assert.equal((await api.post('/api/google/documents/open', { document_id: 'google-123', tab_id: 'missing' })).status, 404);
  } finally { await api.close(); }
});

test('enregistrer deux onglets successivement ne provoque pas de faux conflit de révision', async () => {
  const google = stub(), source = doc('Premier');
  const second = doc('Second').tabs[0]; second.tabProperties = { tabId: 'second', title: 'Second' };
  source.tabs.push(second); google.setSource(source);
  const api = await startApi({ google });
  try {
    const opened = await api.post('/api/google/documents/open', { document_id: 'google-123' });
    const tabs = opened.body.google_sync.tabs;
    for (const tab of tabs) {
      const entry = (await api.get(`/api/entries/${tab.id}`)).body;
      entry.content_json.content[0].content[0].text += ' révisé';
      await api.put(`/api/entries/${tab.id}`, { content_json: entry.content_json });
      const pushed = await api.post(`/api/entries/${tab.id}/google/push`);
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    }
    assert.equal(google.calls.filter(c => c.url.endsWith(':batchUpdate')).length, 2);
  } finally { await api.close(); }
});

test('anciens imports bloqués : actualise les brouillons intacts et conserve les brouillons modifiés', async () => {
  const google = stub(), api = await startApi({ google });
  try {
    const opened = (await api.post('/api/google/documents/open', { document_id: 'google-123' })).body;
    const id = opened.id;
    api.db.prepare("UPDATE google_documents SET readonly_reason='ancien convertisseur' WHERE entry_id=?").run(id);
    google.setSource(doc('Contenu complet'));
    const refreshed = await api.post('/api/google/documents/open', { document_id: 'google-123' });
    assert.match(refreshed.body.content_md, /Contenu complet/);
    assert.equal(refreshed.body.google_sync.sync_blocked, '');
    api.db.prepare("UPDATE google_documents SET readonly_reason='ancien convertisseur' WHERE entry_id=?").run(id);
    const draft = refreshed.body.content_json;
    draft.content[0].content[0].text = 'Brouillon à garder';
    await api.put(`/api/entries/${id}`, { content_json: draft });
    const kept = await api.post('/api/google/documents/open', { document_id: 'google-123' });
    assert.match(kept.body.content_md, /Brouillon à garder/);
    assert.equal((await api.post(`/api/entries/${id}/google/push`)).status, 422);
    const pulled = await api.post(`/api/entries/${id}/google/pull`, { expected_content_json: draft });
    assert.equal(pulled.status, 200);
    assert.equal(pulled.body.google_sync.sync_blocked, '');
  } finally { await api.close(); }
});


test('réconcilie une correction locale et une correction distante indépendantes avant l’envoi', async () => {
  const google = stub(), api = await startApi({ google });
  google.setSource(doc('Bonjour 😀, budget 100 €'));
  try {
    const opened = (await api.post('/api/google/documents/open', { document_id: 'google-123' })).body;
    opened.content_json.content[0].content[0].text = 'Bonjour 😃, budget 100 €';
    await api.put(`/api/entries/${opened.id}`, { content_json: opened.content_json });
    const changed = doc('Bonjour 😀, budget 200 €'); changed.revisionId = 'remote-r2'; google.setSource(changed);
    const pushed = await api.post(`/api/entries/${opened.id}/google/push`);
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    assert.match(pushed.body.content_md, /Bonjour 😃, budget 200 €/);
    assert.equal(pushed.body.google_sync.dirty, false);
    const update = JSON.parse(google.calls.find(c => c.url.endsWith(':batchUpdate')).options.body);
    assert.equal(update.writeControl.requiredRevisionId, 'remote-r2');
  } finally { await api.close(); }
});

test('une fusion reçue pendant une nouvelle sauvegarde locale ne remplace pas les dernières frappes', async () => {
  const google = stub(), api = await startApi({ google });
  google.setSource(doc('Bonjour 😀, budget 100 €'));
  try {
    const opened = (await api.post('/api/google/documents/open', { document_id: 'google-123' })).body;
    const draft = structuredClone(opened.content_json); draft.content[0].content[0].text = 'Bonjour 😃, budget 100 €';
    await api.put(`/api/entries/${opened.id}`, { content_json: draft });
    const changed = doc('Bonjour 😀, budget 200 €'); changed.revisionId = 'remote-r2'; google.setSource(changed);
    const original = google.request;
    google.request = async (url, options) => {
      if (url.endsWith(':batchUpdate')) {
        const newer = structuredClone(draft); newer.content[0].content[0].text += ' — nouvelle frappe';
        await api.put(`/api/entries/${opened.id}`, { content_json: newer });
      }
      return original(url, options);
    };
    const pushed = await api.post(`/api/entries/${opened.id}/google/push`);
    assert.equal(pushed.status, 200);
    assert.match(pushed.body.content_md, /nouvelle frappe/);
    assert.match(pushed.body.content_md, /200 €/, 'la prochaine synchronisation ne rétablit pas le budget distant périmé');
    assert.equal(pushed.body.google_sync.dirty, true);
    const link = api.db.prepare('SELECT synced_content_json FROM google_documents WHERE entry_id=?').get(opened.id);
    assert.match(link.synced_content_json, /200 €/);
    assert.doesNotMatch(link.synced_content_json, /nouvelle frappe/);
  } finally { await api.close(); }
});

test('le retour de l’éditeur Google actualise les onglets intacts et importe les nouveaux sans remplacer les brouillons', async () => {
  const google = stub(), api = await startApi({ google });
  const tab = (id, text) => ({ ...doc(text).tabs[0], tabProperties: { tabId: id, title: id } });
  google.setSource({ ...doc(), tabs: [tab('t.0', 'Premier'), tab('t.1', 'Deuxième')] });
  try {
    const opened = (await api.post('/api/google/documents/open', { document_id: 'google-123' })).body;
    const second = api.db.prepare("SELECT entry_id FROM google_documents WHERE tab_id='t.1'").get().entry_id;
    const draft = (await api.get(`/api/entries/${second}`)).body.content_json;
    draft.content[0].content[0].text = 'Mon brouillon à conserver';
    await api.put(`/api/entries/${second}`, { content_json: draft });
    google.setSource({ ...doc(), revisionId: 'native-r2', title: 'Renommé dans Google', tabs: [tab('t.0', 'Édité dans Google'), tab('t.1', 'Autre édition Google'), tab('t.2', 'Nouvel onglet Google')] });
    const refreshed = await api.post('/api/google/documents/open', { document_id: 'google-123', tab_id: 't.0' });
    assert.equal(refreshed.status, 201);
    assert.equal(refreshed.body.id, opened.id);
    assert.match(refreshed.body.content_md, /Édité dans Google/);
    assert.equal(refreshed.body.google_sync.document_title, 'Renommé dans Google');
    assert.equal(refreshed.body.google_sync.dirty, false);
    assert.equal(refreshed.body.google_sync.tabs.length, 3);
    const retained = (await api.get(`/api/entries/${second}`)).body;
    assert.match(retained.content_md, /Mon brouillon à conserver/);
    assert.equal(retained.google_sync.dirty, true);
    const base = api.db.prepare('SELECT revision_id,synced_content_json FROM google_documents WHERE entry_id=?').get(second);
    assert.equal(base.revision_id, 'r1');
    assert.match(base.synced_content_json, /Deuxième/);
  } finally { await api.close(); }
});
