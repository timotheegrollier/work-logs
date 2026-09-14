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
