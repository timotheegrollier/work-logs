import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleUpdate, googleToDocument } from '../src/google-document.js';
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
