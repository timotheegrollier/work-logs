import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApi, officeOwnerFile } from './helpers.js';
import { createSharedIo } from '../src/shared-io.js';

const q = encodeURIComponent;

/**
 * Suppression gardée d'un fichier du dossier partagé (`DELETE /api/shared/file`).
 * Le « partage » est un dossier temporaire : le test y joue le collègue.
 */
describe('dossier partagé : supprimer un fichier', () => {
  let api;
  let share;

  const write = (rel, contents) => {
    fs.mkdirSync(path.dirname(path.join(share, rel)), { recursive: true });
    fs.writeFileSync(path.join(share, rel), contents);
  };
  const exists = (rel) => fs.existsSync(path.join(share, rel));
  const open = (rel) => api.get(`/api/shared/file?path=${q(rel)}`);
  const remove = (rel) => api.del(`/api/shared/file?path=${q(rel)}`);
  const draft = (rel, model, file) =>
    api.put(`/api/shared/draft?path=${q(rel)}`, { model, template_hash: file.hash, base_hash: file.base_hash });

  beforeEach(async () => {
    share = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-share-delete-'));
    api = await startApi({ shared: { root: share, io: createSharedIo() } });
  });
  afterEach(async () => {
    await api.close();
    fs.rmSync(share, { recursive: true, force: true });
  });

  test('supprime un fichier ouvert, l’historique local reste', async () => {
    write('procédure.md', '# Sauvegarde\n');
    const file = (await open('procédure.md')).body;
    assert.ok(file.hash);

    const { status, body } = await remove('procédure.md');
    assert.equal(status, 200);
    assert.equal(body.deleted, true);
    assert.equal(exists('procédure.md'), false);

    const versions = (await api.get(`/api/shared/versions?path=${q('procédure.md')}`)).body.versions;
    assert.ok(versions.length >= 1, 'la version lue reste dans l’historique');
    assert.equal((await open('procédure.md')).status, 404);
  });

  test('supprime un fichier jamais ouvert, sans rien écraser d’autre', async () => {
    write('notes.md', 'v1\n');
    write('garde.md', 'gardé\n');
    const { status, body } = await remove('notes.md');
    assert.equal(status, 200);
    assert.equal(body.deleted, true);
    assert.equal(exists('notes.md'), false);
    assert.equal(exists('garde.md'), true);
  });

  test('fichier introuvable : 404, deux suppressions ne suppriment qu’une fois', async () => {
    assert.equal((await remove('absent.md')).status, 404);
    write('éphémère.md', 'x\n');
    await open('éphémère.md');
    assert.equal((await remove('éphémère.md')).status, 200);
    assert.equal((await remove('éphémère.md')).status, 404);
  });

  test('chemin invalide ou dossier : 400, jamais un dossier', async () => {
    assert.equal((await api.del('/api/shared/file?path=')).status, 400);
    assert.equal((await api.del(`/api/shared/file?path=${q('../dehors.md')}`)).status, 400);
    fs.mkdirSync(path.join(share, 'Dossier'));
    const { status, body } = await remove('Dossier');
    assert.equal(status, 400);
    assert.equal(body.code, 'SHARED_NOT_FILE');
    assert.equal(exists('Dossier'), true);
  });

  test('brouillon ou conflit : rien n’est supprimé avant de choisir', async () => {
    write('notes.md', 'v1\n');
    const file = (await open('notes.md')).body;
    await draft('notes.md', { text: 'v2' }, file);
    const refused = await remove('notes.md');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'SHARED_DRAFT_OPEN');
    assert.equal(exists('notes.md'), true);
  });

  test('fichier ouvert par un collègue : refusé avec son nom, rien n’est supprimé', async () => {
    write('relevés.csv', 'a;b\n1;2\n');
    write('~$relevés.csv', officeOwnerFile('Jean Dupont', { excel: true }));
    const { status, body } = await remove('relevés.csv');
    assert.equal(status, 409);
    assert.equal(body.code, 'SHARED_LOCKED');
    assert.match(body.error, /Jean Dupont/);
    assert.equal(exists('relevés.csv'), true);
  });

  test('modifié depuis l’ouverture : rien n’est supprimé, rouvrir puis supprimer', async () => {
    write('notes.md', 'v1\n');
    await open('notes.md');
    write('notes.md', 'v2 du collègue\n');
    const stale = await remove('notes.md');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'SHARED_STALE');
    assert.equal(fs.readFileSync(path.join(share, 'notes.md'), 'utf8'), 'v2 du collègue\n');

    await open('notes.md');
    assert.equal((await remove('notes.md')).status, 200);
    assert.equal(exists('notes.md'), false);
  });
});
