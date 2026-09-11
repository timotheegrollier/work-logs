import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, make } from './helpers.js';

describe('pièces jointes', () => {
  let api;
  before(async () => { api = await startApi(); });
  after(() => api.close());

  test('attache un fichier à une entrée et le relit', async () => {
    const entry = await make.entry(api);
    const up = await api.upload('compte rendu.txt', 'contenu du fichier', { entry_id: entry.id });

    assert.equal(up.status, 201);
    assert.equal(up.body.filename, 'compte rendu.txt', 'le nom d’origine est conservé');
    assert.match(up.body.stored, /^[a-z0-9]+_compte_rendu\.txt$/, 'le nom disque est assaini');
    assert.equal(up.body.size, Buffer.byteLength('contenu du fichier'));
    assert.equal(up.body.entry_id, entry.id);

    const res = await fetch(`${api.base}/api/files/${up.body.stored}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'contenu du fichier');
    assert.match(res.headers.get('content-disposition'), /compte/);
  });

  test('refuse un upload sans entrée valide, sans laisser de fichier orphelin', async () => {
    for (const fields of [{}, { entry_id: '' }, { entry_id: 'en_nope' }]) {
      const up = await api.upload('x.txt', 'x', fields);
      assert.equal(up.status, 400, JSON.stringify(fields));
      assert.equal(up.body.error, 'entry_id requis et valide');
    }
    assert.deepEqual(fs.readdirSync(api.uploadDir).filter((f) => f.endsWith('x.txt')), []);
  });

  test('refuse une requête sans fichier', async () => {
    const entry = await make.entry(api);
    const res = await api.post('/api/uploads', { entry_id: entry.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /fichier requis/);
  });

  test('404 sur un fichier inconnu', async () => {
    const res = await fetch(`${api.base}/api/files/inexistant.txt`);
    assert.equal(res.status, 404);
  });

  test('404 si la ligne existe mais le fichier a disparu du disque', async () => {
    const entry = await make.entry(api);
    const up = await api.upload('perdu.txt', 'x', { entry_id: entry.id });
    fs.rmSync(path.join(api.uploadDir, up.body.stored));

    const res = await fetch(`${api.base}/api/files/${up.body.stored}`);
    assert.equal(res.status, 404);
  });

  test('ne sort pas du dossier d’uploads via le nom de fichier', async () => {
    const res = await fetch(`${api.base}/api/files/${encodeURIComponent('../../src/app.js')}`);
    assert.equal(res.status, 404);
  });

  test('supprimer la pièce jointe efface aussi le fichier disque', async () => {
    const entry = await make.entry(api);
    const up = await api.upload('a-effacer.txt', 'x', { entry_id: entry.id });
    const file = path.join(api.uploadDir, up.body.stored);
    assert.ok(fs.existsSync(file));

    assert.equal((await api.del(`/api/attachments/${up.body.id}`)).status, 200);
    assert.equal(fs.existsSync(file), false);
    assert.equal((await api.del(`/api/attachments/${up.body.id}`)).status, 404);
  });

  test('supprimer l’entrée efface ses fichiers et ses lignes', async () => {
    const entry = await make.entry(api);
    const up = await api.upload('lie.txt', 'x', { entry_id: entry.id });
    const file = path.join(api.uploadDir, up.body.stored);

    await api.del(`/api/entries/${entry.id}`);

    assert.equal(fs.existsSync(file), false, 'fichier disque supprimé');
    assert.equal(
      api.db.prepare('SELECT COUNT(*) n FROM attachments WHERE entry_id=?').get(entry.id).n,
      0,
      'ligne supprimée en cascade'
    );
  });
});
