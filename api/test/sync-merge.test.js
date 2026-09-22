import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshots, validateTombstones, TOMBSTONE_TTL_MS } from '../src/sync-merge.js';
import { validateBackup } from '../src/backup-format.js';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const at = (minutes) => new Date(NOW - (60 - minutes) * 60_000).toISOString();
const snap = (over = {}) => ({ projects: [], entries: [], tasks: [], task_entries: [], google_documents: [], attachments: [], deleted: [], ...over });
const entry = (id, minutes, over = {}) => ({ id, title: id, content_md: '', content_json: null, entry_date: '2026-09-22', project_id: null,
  archived: 0, kind: 'note', created_at: at(0), updated_at: at(minutes), ...over });
const task = (id, minutes, over = {}) => ({ id, title: id, status: 'todo', due_date: null, pinned: 0, position: 0, priority: 'normal',
  project_id: null, created_at: at(0), updated_at: at(minutes), ...over });
const project = (id, minutes, over = {}) => ({ id, name: id, color: '#fff', created_at: at(0), updated_at: at(minutes), ...over });
const ids = (rows) => rows.map((row) => row.id).sort();
const asBackup = (merged) => validateBackup({ version: 2, ...merged });

test('sans fichier distant : le local part tel quel', () => {
  const local = snap({ entries: [entry('en_a', 1)] });
  const result = mergeSnapshots(local, null, NOW);
  assert.deepEqual(ids(result.merged.entries), ['en_a']);
  assert.equal(result.changedLocal, false);
  assert.equal(result.changedRemote, true);
});

test('union des nouveautés et version la plus récente par élément, dans les deux sens', () => {
  const local = snap({ entries: [entry('en_shared', 10, { title: 'PC récent' }), entry('en_pc', 1), entry('en_old', 1, { title: 'PC ancien' })] });
  const remote = snap({ entries: [entry('en_shared', 5, { title: 'Mobile' }), entry('en_mobile', 2), entry('en_old', 20, { title: 'Mobile récent' })] });
  const { merged, changedLocal, changedRemote } = mergeSnapshots(local, remote, NOW);
  assert.deepEqual(ids(merged.entries), ['en_mobile', 'en_old', 'en_pc', 'en_shared']);
  assert.equal(merged.entries.find((e) => e.id === 'en_shared').title, 'PC récent');
  assert.equal(merged.entries.find((e) => e.id === 'en_old').title, 'Mobile récent');
  assert.equal(changedLocal, true);
  assert.equal(changedRemote, true);
  asBackup(merged);
});

test('idempotent : refusionner le résultat ne change plus rien', () => {
  const { merged } = mergeSnapshots(snap({ entries: [entry('en_a', 3)], deleted: [{ kind: 'task', id: 'tk_x', deleted_at: at(5) }] }),
    snap({ tasks: [task('tk_b', 4)] }), NOW);
  const again = mergeSnapshots(merged, merged, NOW);
  assert.equal(again.changedLocal, false);
  assert.equal(again.changedRemote, false);
});

test('une suppression gagne sur une version antérieure, une modification postérieure ressuscite', () => {
  const local = snap({ deleted: [{ kind: 'entry', id: 'en_gone', deleted_at: at(30) }, { kind: 'entry', id: 'en_back', deleted_at: at(30) }] });
  const remote = snap({ entries: [entry('en_gone', 20), entry('en_back', 40, { title: 'édité après' })] });
  const { merged } = mergeSnapshots(local, remote, NOW);
  assert.deepEqual(ids(merged.entries), ['en_back']);
  assert.deepEqual(merged.deleted.map((t) => t.id), ['en_gone'], 'la pierre tombale ressuscitée est retirée');
});

test('l’amorçage intact ne gagne jamais contre une version modifiée ; une suppression le retire toujours', () => {
  // Le téléphone installé après le PC : amorçage plus récent, mais jamais modifié.
  const phoneSeed = { ...entry('en_welcome', 50), created_at: at(50), updated_at: at(50) };
  const pcEdited = { ...entry('en_welcome', 10, { title: 'Mes notes' }) };
  assert.equal(mergeSnapshots(snap({ entries: [phoneSeed] }), snap({ entries: [pcEdited] }), NOW).merged.entries[0].title, 'Mes notes');
  const pcDeleted = snap({ deleted: [{ kind: 'task', id: 'tk_1', deleted_at: at(1) }] });
  const phoneTask = { ...task('tk_1', 50), created_at: at(50), updated_at: at(50) };
  assert.deepEqual(mergeSnapshots(snap({ tasks: [phoneTask] }), pcDeleted, NOW).merged.tasks, []);
});

test('projet supprimé : entrées et tâches détachées, jamais orphelines', () => {
  const local = snap({ deleted: [{ kind: 'project', id: 'pr_x', deleted_at: at(30) }] });
  const remote = snap({ projects: [project('pr_x', 10)], entries: [entry('en_a', 5, { project_id: 'pr_x' })], tasks: [task('tk_a', 5, { project_id: 'pr_x' })] });
  const { merged } = mergeSnapshots(local, remote, NOW);
  assert.deepEqual(merged.projects, []);
  assert.equal(merged.entries[0].project_id, null);
  assert.equal(merged.tasks[0].project_id, null);
  asBackup(merged);
});

test('renommer un projet se propage : le plus récent gagne', () => {
  const { merged } = mergeSnapshots(snap({ projects: [project('pr_a', 5, { name: 'Ancien' })] }), snap({ projects: [project('pr_a', 9, { name: 'Nouveau' })] }), NOW);
  assert.equal(merged.projects[0].name, 'Nouveau');
});

test('liens tâche ⇄ document : union, moins les retraits et les orphelins', () => {
  const base = { entries: [entry('en_a', 1), entry('en_b', 1)], tasks: [task('tk_a', 1)] };
  const local = snap({ ...base, task_entries: [{ task_id: 'tk_a', entry_id: 'en_a', created_at: at(2) }],
    deleted: [{ kind: 'link', id: 'tk_a|en_b', deleted_at: at(10) }] });
  const remote = snap({ ...base, task_entries: [{ task_id: 'tk_a', entry_id: 'en_b', created_at: at(3) }, { task_id: 'tk_zz', entry_id: 'en_a', created_at: at(3) }] });
  const { merged } = mergeSnapshots(local, remote, NOW);
  assert.deepEqual(merged.task_entries.map((l) => `${l.task_id}|${l.entry_id}`), ['tk_a|en_a']);
});

test('pièces jointes : identifiant Drive complété, celles d’une entrée supprimée écartées', () => {
  const file = (id, entryId, driveFileId = null) => ({ id, filename: `${id}.jpg`, stored: `${id}.jpg`, mime: 'image/jpeg', size: 3, entry_id: entryId, created_at: at(1), driveFileId });
  const local = snap({ entries: [entry('en_a', 1)], attachments: [file('at_1', 'en_a')], deleted: [{ kind: 'entry', id: 'en_b', deleted_at: at(30) }] });
  const remote = snap({ entries: [entry('en_a', 1), entry('en_b', 1)], attachments: [file('at_1', 'en_a', 'drive-1'), file('at_2', 'en_b', 'drive-2')] });
  const { merged } = mergeSnapshots(local, remote, NOW);
  assert.deepEqual(merged.attachments.map((a) => [a.id, a.driveFileId]), [['at_1', 'drive-1']]);
});

test('même onglet Google ouvert sur les deux appareils : une seule copie, la plus récente', () => {
  const doc = (entryId) => ({ entry_id: entryId, document_id: 'gdoc', tab_id: 't.0', revision_id: 'r', synced_content_json: '{"type":"doc","content":[]}',
    synced_at: at(1), document_title: 'Doc', tab_title: '', tab_order: 0, tab_depth: 0, readonly_reason: '' });
  const local = snap({ entries: [entry('en_pc', 10)], google_documents: [doc('en_pc')] });
  const remote = snap({ entries: [entry('en_phone', 20)], google_documents: [doc('en_phone')] });
  const { merged } = mergeSnapshots(local, remote, NOW);
  assert.deepEqual(ids(merged.entries), ['en_phone']);
  assert.deepEqual(merged.google_documents.map((d) => d.entry_id), ['en_phone']);
  assert.ok(merged.deleted.some((t) => t.kind === 'entry' && t.id === 'en_pc'), 'la copie écartée se supprime aussi ailleurs');
});

test('pierres tombales : purgées après 60 jours, entrées mal formées ignorées', () => {
  const old = new Date(NOW - TOMBSTONE_TTL_MS - 1000).toISOString();
  const { merged } = mergeSnapshots(snap({ deleted: [{ kind: 'task', id: 'tk_old', deleted_at: old }] }), snap(), NOW);
  assert.deepEqual(merged.deleted, []);
  assert.deepEqual(validateTombstones([{ kind: 'task', id: 'tk_1', deleted_at: at(1), extra: 1 }, { kind: 'autre', id: 'x', deleted_at: at(1) }, { kind: 'task', id: '', deleted_at: at(1) }, null]),
    [{ kind: 'task', id: 'tk_1', deleted_at: at(1) }]);
  assert.deepEqual(validateTombstones(undefined), []);
  assert.throws(() => validateTombstones('pas une liste'), /invalides/);
});
