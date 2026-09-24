import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, make } from './helpers.js';
import { openDb } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDocument } from '../src/rich-document.js';

const document = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Décisions', marks: [{ type: 'bold' }] }] }] };

test('migration des associations Google v0.7 : conserve la révision et autorise plusieurs onglets sans doublons', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-tabs-migration-'));
  const file = path.join(dir, 'old.db');
  const initial = openDb(file, { withSeed: false });
  initial.exec(`INSERT INTO entries (id,title,entry_date,created_at,updated_at) VALUES ('old','Original','2026-09-14','',''), ('second','Deuxième','2026-09-14','','');
    DROP TABLE google_documents;
    CREATE TABLE google_documents (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, document_id TEXT NOT NULL UNIQUE, revision_id TEXT NOT NULL, synced_content_json TEXT NOT NULL, synced_at TEXT);
    INSERT INTO google_documents VALUES ('old','doc-123','revision-originale','{}','2026-09-14');`);
  initial.close();
  const migrated = openDb(file, { withSeed: false });
  try {
    const original = migrated.prepare('SELECT * FROM google_documents WHERE entry_id=?').get('old');
    assert.equal(original.tab_id, '');
    assert.equal(original.revision_id, 'revision-originale');
    assert.equal(original.synced_content_json, '{}');
    migrated.prepare('INSERT INTO google_documents (entry_id,document_id,tab_id,revision_id,synced_content_json) VALUES (?,?,?,?,?)').run('second', 'doc-123', 't.other', 'r2', '{}');
    assert.throws(() => migrated.exec("UPDATE google_documents SET tab_id='' WHERE entry_id='second'"), /UNIQUE/);
    migrated.exec("DELETE FROM entries WHERE id='second'");
    assert.equal(migrated.prepare('SELECT count(*) n FROM google_documents').get().n, 1);
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { migrated.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('les blocs riches dans une cellule ou une citation et les dimensions d’image restent persistants', async () => {
  const api = await startApi();
  try {
    const rich = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2, rowspan: 1, colwidth: [120, 180] }, content: [
      { type: 'blockquote', content: [{ type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'const x = 1' }] }] },
      { type: 'image', attrs: { src: 'https://example.com/image.png', alt: 'Diagramme', width: 240, height: null } },
    ] }] }] }] };
    const saved = await api.post('/api/entries', { title: 'Blocs', content_json: rich });
    assert.equal(saved.status, 201);
    assert.deepEqual((await api.get(`/api/entries/${saved.body.id}`)).body.content_json, rich);
  } finally { await api.close(); }
});

test('une base V2 antérieure reçoit la colonne riche sans perdre ses entrées', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-rich-migration-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, title TEXT, content_md TEXT, entry_date TEXT, project_id TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO entries VALUES ('old', 'Ancien', '# Texte intact', '2026-01-01', NULL, '', '');`);
  old.close();
  const migrated = openDb(file, { withSeed: false });
  try {
    const entry = migrated.prepare('SELECT * FROM entries WHERE id=?').get('old');
    assert.equal(entry.content_md, '# Texte intact');
    assert.equal(entry.content_json, null);
  } finally { migrated.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('une copie locale garde ses images même si l’original est supprimé', async () => {
  const api = await startApi();
  try {
    const entry = await make.entry(api);
    const attachment = (await api.upload('image.png', 'contenu image', { entry_id: entry.id })).body;
    await api.put(`/api/entries/${entry.id}`, { content_json: { type: 'doc', content: [{ type: 'image', attrs: { src: `/api/files/${attachment.stored}`, alt: 'Image' } }] } });
    const copy = await api.post(`/api/entries/${entry.id}/copy`);
    assert.equal(copy.status, 201);
    assert.equal(copy.body.google_sync, null);
    const src = copy.body.content_json.content[0].attrs.src;
    assert.notEqual(src, `/api/files/${attachment.stored}`);
    await api.del(`/api/entries/${entry.id}`);
    const image = await fetch(api.base + src);
    assert.equal(image.status, 200);
    assert.equal(await image.text(), 'contenu image');
    assert.equal((await api.get(`/api/entries/${copy.body.id}`)).body.attachments.length, 1);
    assert.equal((await api.post('/api/entries/missing/copy')).status, 404);
  } finally { await api.close(); }
});

test('document riche : sauvegarde, relecture, recherche, export et suppression', async () => {
  const api = await startApi();
  try {
    const created = await api.post('/api/entries', { title: 'Compte rendu', content_json: document, content_md: 'ne doit pas remplacer le texte indexé' });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.content_json, document);
    assert.equal(created.body.content_md, 'Décisions');
    const id = created.body.id;
    await api.put(`/api/entries/${id}`, { title: 'Renommé', content_md: 'ignoré' });
    assert.deepEqual((await api.get(`/api/entries/${id}`)).body.content_json, document);
    assert.equal((await api.get('/api/state?q=Décisions')).body.entries.length, 1);
    assert.deepEqual((await api.get('/api/export')).body.entries[0].content_json, document);
    assert.equal((await api.put(`/api/entries/${id}`, { content_json: null })).status, 400);
    assert.equal((await api.del(`/api/entries/${id}`)).status, 200);
  } finally { await api.close(); }
});

test('migration additive et réouverture préservent le Markdown et les documents riches', async () => {
  const api = await startApi();
  try {
    const legacy = await make.entry(api, { content_md: '# Ancien texte' });
    const rich = await make.entry(api, { content_json: document });
    const reopened = openDb(`${api.dir}/worklogs.db`, { withSeed: false });
    try {
      assert.equal(reopened.prepare('SELECT content_md FROM entries WHERE id=?').get(legacy.id).content_md, '# Ancien texte');
      assert.deepEqual(JSON.parse(reopened.prepare('SELECT content_json FROM entries WHERE id=?').get(rich.id).content_json), document);
    } finally { reopened.close(); }
  } finally { await api.close(); }
});

test('refuse les documents malformés, trop profonds et les liens dangereux sans écraser la version enregistrée', async () => {
  const api = await startApi();
  try {
    const entry = await make.entry(api, { content_json: document });
    const invalid = [[], {}, { type: 'doc', content: [] }, { type: 'doc', content: [{ type: 'script' }] },
      { type: 'doc', content: [{ type: 'image', attrs: { src: 'javascript:alert(1)' } }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'java\nscript:alert(1)' } }] }] }] }];
    for (const content_json of invalid) {
      assert.equal((await api.put(`/api/entries/${entry.id}`, { content_json })).status, 400);
      assert.deepEqual((await api.get(`/api/entries/${entry.id}`)).body.content_json, document);
    }
    let nested = { type: 'paragraph' };
    for (let i = 0; i < 40; i++) nested = { type: 'bulletList', content: [{ type: 'listItem', content: [nested] }] };
    assert.throws(() => validateDocument({ type: 'doc', content: [nested] }), /invalide/);
  } finally { await api.close(); }
});

test('liste numérotée tapée « 0. » ou « 10001. » : acceptée et relue telle quelle', async () => {
  const list = (start) => ({ type: 'doc', content: [{ type: 'orderedList', attrs: { start, type: null }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Préparer' }] }] }] }] });
  for (const start of [0, 1, 10001, 123456]) assert.doesNotThrow(() => validateDocument(list(start)), `start ${start}`);
  for (const start of [-1, 1.5, '3', 1e20]) assert.throws(() => validateDocument(list(start)), /document riche invalide/, `start ${start}`);
  // Les autres nombres gardent leurs bornes.
  assert.throws(() => validateDocument({ type: 'doc', content: [{ type: 'image', attrs: { src: 'https://x.fr/a.png', width: 0 } }] }), /invalide/);
  const api = await startApi();
  try {
    const entry = await make.entry(api, { title: 'Procédure', kind: 'procedure', content_json: list(0) });
    assert.equal((await api.get(`/api/entries/${entry.id}`)).body.content_json.content[0].attrs.start, 0);
    const res = await api.put(`/api/entries/${entry.id}`, { content_json: list(10001) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  } finally { await api.close(); }
});

test('normalizeDocument : un début de liste hors des entiers sûrs repart de 1, le reste intact', async () => {
  const { normalizeDocument } = await import('../src/rich-document.js');
  const ok = { type: 'doc', content: [{ type: 'orderedList', attrs: { start: 0 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] };
  assert.equal(normalizeDocument(ok), ok);
  const huge = structuredClone(ok);
  huge.content[0].attrs.start = 1e20;
  const fixed = normalizeDocument(huge);
  assert.equal(fixed.content[0].attrs.start, 1);
  assert.equal(huge.content[0].attrs.start, 1e20, 'l’original n’est pas modifié');
  assert.doesNotThrow(() => validateDocument(fixed));
});
