import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBackup, validateOutbox } from '../src/backup-format.js';
import { buildBackup, restoreBackup } from '../src/backup.js';
import { mergeSnapshots } from '../src/sync-merge.js';
import { startApi } from './helpers.js';
import { importOutbox } from '../src/google-routes.js';

const T = '2026-10-26T10:00:00.000Z';
const project = { id: 'pr_cat', name: 'Projet', color: '#123456', created_at: T, updated_at: T };
const category = (id, parent_id = null, over = {}) => ({ id, name: id, project_id: project.id, parent_id, color: '#64748b', created_at: T, updated_at: T, ...over });
const backup = (over = {}) => ({ version: 2, projects: [project], categories: [], entries: [], tasks: [], task_entries: [], attachments: [], google_documents: [], ...over });
const note = (category_id = null) => ({ id: 'en_cat', title: 'Note', content_md: '', content_json: null, entry_date: '2026-10-26', project_id: project.id, category_id, created_at: T, updated_at: T });

test('anciens exports compatibles ; catégories, parents et affectations validés avant écriture', () => {
  const old = backup(); delete old.categories;
  assert.deepEqual(validateBackup(old).categories, []);
  const tree = [category('ca_child', 'ca_root'), category('ca_root')];
  const data = validateBackup(backup({ categories: tree, entries: [note('ca_child')] }));
  assert.equal(data.entries[0].category_id, 'ca_child');
  assert.throws(() => validateBackup(backup({ categories: [category('ca_a', 'ca_b'), category('ca_b', 'ca_a')] })), /Cycle/);
  assert.throws(() => validateBackup(backup({ categories: [category('ca_a', 'ca_missing')] })), /parente absente/);
  assert.throws(() => validateBackup(backup({ categories: tree, entries: [{ ...note('ca_child'), project_id: null }] })), /autre projet/);
  assert.throws(() => validateBackup(backup({ categories: [category('ca_a', null, { color: 'red' })] })), /Couleur/);
  const box = validateOutbox({ ...backup({ categories: tree, entries: [note('ca_child')] }), version: 1, exported_at: T, device: 'pwa' });
  assert.equal(box.categories.length, 2);
});

test('restauration transactionnelle dans un ordre enfants-parents, export et revalidation', async () => {
  const api = await startApi();
  try {
    const input = backup({ categories: [category('ca_child', 'ca_root'), category('ca_root')], entries: [note('ca_child')] });
    restoreBackup(api.db, input);
    assert.equal(api.db.prepare('SELECT parent_id FROM categories WHERE id=?').get('ca_child').parent_id, 'ca_root');
    assert.equal(buildBackup(api.db).entries[0].category_id, 'ca_child');
    validateBackup(buildBackup(api.db));
    assert.throws(() => restoreBackup(api.db, { ...input, categories: [category('ca_child', 'ca_missing')] }), /parente absente/);
    assert.equal(buildBackup(api.db).categories.length, 2, 'la sauvegarde invalide ne vide rien');
  } finally { await api.close(); }
});

test('fusion : suppression de catégorie, promotion, et réparation déterministe des cycles concurrents', () => {
  const old = backup({ categories: [category('ca_a'), category('ca_b', 'ca_a'), category('ca_c', 'ca_b')], entries: [note('ca_b')], deleted: [] });
  const remote = backup({ categories: [category('ca_a'), category('ca_c', 'ca_a')], entries: [note('ca_a')], deleted: [{ kind: 'category', id: 'ca_b', deleted_at: '2026-10-26T11:00:00.000Z' }] });
  const merged = mergeSnapshots(old, remote, Date.parse('2026-10-26T12:00:00.000Z')).merged;
  assert.deepEqual(merged.categories.map((row) => row.id).sort(), ['ca_a', 'ca_c']);
  assert.equal(merged.categories.find((row) => row.id === 'ca_c').parent_id, 'ca_a');
  assert.equal(merged.entries[0].category_id, 'ca_a');
  validateBackup({ version: 2, ...merged });
  const a = backup({ categories: [category('ca_a', 'ca_b', { updated_at: '2026-10-26T11:00:00.000Z' }), category('ca_b')], deleted: [] });
  const b = backup({ categories: [category('ca_a'), category('ca_b', 'ca_a', { updated_at: '2026-10-26T11:00:00.000Z' })], deleted: [] });
  const forward = mergeSnapshots(a, b).merged;
  const reverse = mergeSnapshots(b, a).merged;
  validateBackup({ version: 2, ...forward });
  assert.deepEqual(forward.categories.map((row) => [row.id, row.parent_id]).sort(), reverse.categories.map((row) => [row.id, row.parent_id]).sort());
  assert.equal(mergeSnapshots(forward, forward).changedLocal, false);
});

test('fusion : projet supprimé détache les affectations et retire ses catégories', () => {
  const base = backup({ categories: [category('ca_a')], entries: [note('ca_a')], deleted: [] });
  const remote = backup({ projects: [], deleted: [{ kind: 'project', id: project.id, deleted_at: '2026-10-26T11:00:00.000Z' }] });
  const merged = mergeSnapshots(base, remote, Date.parse('2026-10-26T12:00:00.000Z')).merged;
  assert.deepEqual(merged.categories, []);
  assert.equal(merged.entries[0].project_id, null);
  assert.equal(merged.entries[0].category_id, null);
});

test('import mobile garde une hiérarchie enfants-parents et les affectations', async () => {
  const api = await startApi();
  try {
    const box = validateOutbox({ ...backup({ categories: [category('ca_child', 'ca_root'), category('ca_root')], entries: [note('ca_child')] }), version: 1, exported_at: T, device: 'pwa' });
    await importOutbox(api.db, { google: null, uploadDir: api.uploadDir }, box);
    assert.equal(api.db.prepare('SELECT category_id FROM entries WHERE id=?').get('en_cat').category_id, 'ca_child');
    assert.equal(api.db.prepare('SELECT parent_id FROM categories WHERE id=?').get('ca_child').parent_id, 'ca_root');
    validateBackup(buildBackup(api.db));
    await importOutbox(api.db, { google: null, uploadDir: api.uploadDir }, box);
    assert.equal(buildBackup(api.db).categories.length, 2);
  } finally { await api.close(); }
});
