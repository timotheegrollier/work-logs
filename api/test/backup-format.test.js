import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OUTBOX_VERSION, validateBackup, validateOutbox } from '../src/backup-format.js';

const project = { id: 'pr_1', name: 'Chantier', color: '#fff', created_at: '2026-09-18T10:00:00.000Z' };
const entry = { id: 'en_1', title: 'Devis', content_md: 'corps', content_json: null, entry_date: '2026-09-18', project_id: 'pr_1', created_at: '2026-09-18T10:00:00.000Z', updated_at: '2026-09-18T10:00:00.000Z' };
const task = { id: 'tk_1', title: 'Relire', status: 'todo', due_date: null, pinned: 0, position: 0, project_id: 'pr_1', created_at: '2026-09-18T10:00:00.000Z', updated_at: '2026-09-18T10:00:00.000Z' };
const backup = (over) => ({ version: 2, projects: [project], entries: [], tasks: [], task_entries: [], attachments: [], ...over });

test('une ancienne sauvegarde rattache ses tâches sans écraser les notes et leurs fichiers', () => {
  const matching = { ...entry, title: task.title };
  const reference = { ...entry, id: 'en_reference' };
  const file = { id: 'at_1', filename: 'plan.pdf', stored: 'plan.pdf', size: 5, entry_id: matching.id, created_at: task.created_at };
  const linked = { task_id: task.id, entry_id: matching.id, created_at: task.created_at };
  const second = { ...task, id: 'tk_second', title: 'Corriger', status: 'done' };
  const input = backup({ entries: [matching, reference], tasks: [second, task], attachments: [file],
    task_entries: [linked, { ...linked, task_id: second.id, entry_id: reference.id }] });
  const data = validateBackup(input);
  const tracked = data.tasks.find((row) => row.id === task.id);
  const completed = data.tasks.find((row) => row.id === second.id);
  assert.equal(tracked.entry_id, matching.id);
  assert.equal(data.entries.find((row) => row.id === matching.id).content_md, matching.content_md);
  assert.equal(data.attachments[0].entry_id, matching.id);
  assert.equal(completed.progress, 100);
  assert.notEqual(completed.entry_id, reference.id);
  assert.equal(data.entries.find((row) => row.id === reference.id).title, reference.title);
  assert.match(data.entries.find((row) => row.id === completed.entry_id).content_md, /Devis/);
  assert.equal(validateBackup({ ...input, tasks: [task, second] }).tasks.find((row) => row.id === second.id).entry_id, completed.entry_id);
  assert.deepEqual(validateBackup(data), data);
});

test('refuse un progrès incohérent et une référence principale orpheline', () => {
  assert.throws(() => validateBackup(backup({ tasks: [{ ...task, entry_id: entry.id }] })), /note principale absente/);
  assert.throws(() => validateBackup(backup({ tasks: [{ ...task, progress: 50 }] })), /Avancement/);
  assert.throws(() => validateBackup(backup({ entries: [entry], tasks: [{ ...task, entry_id: entry.id }, { ...task, id: 'tk_2', entry_id: entry.id }] })), /Note principale.*dupliqué/);
  assert.throws(() => validateBackup(backup({ entries: [{ ...entry, kind: 'procedure' }], tasks: [{ ...task, entry_id: entry.id }] })), /note principale locale/);
});

describe('boîte mobile', () => {
  test('valide et normalise une boîte complète', () => {
    const data = validateOutbox({
      version: 1,
      exported_at: '2026-09-18T11:00:00.000Z',
      base_exported_at: '2026-09-18T10:00:00.000Z',
      device: 'pwa',
      projects: [project],
      entries: [entry],
      tasks: [{ ...task }],
      task_entries: [{ task_id: 'tk_1', entry_id: 'en_1', created_at: '2026-09-18T10:00:00.000Z' }],
      attachments: [{ id: 'at_1', filename: 'photo.jpg', stored: 'abc.jpg', mime: 'image/jpeg', size: 12, entry_id: 'en_1', created_at: '2026-09-18T10:00:00.000Z', driveFileId: 'drive-1' }],
    });
    assert.equal(data.version, OUTBOX_VERSION);
    assert.equal(data.device, 'pwa');
    assert.equal(data.tasks[0].priority, 'normal');
    assert.equal(data.attachments[0].driveFileId, 'drive-1');
  });

  test('refuse version, appareil, base et références invalides en français', () => {
    const base = { version: 1, exported_at: '2026-09-18T11:00:00.000Z', device: 'pwa', projects: [], entries: [], tasks: [], task_entries: [], attachments: [] };
    assert.throws(() => validateOutbox({ ...base, version: 999 }), /Version de boîte mobile/);
    assert.throws(() => validateOutbox({ ...base, device: '  ' }), /Appareil d’origine/);
    assert.throws(() => validateOutbox({ ...base, base_exported_at: 123 }), /Sauvegarde d’origine/);
    assert.throws(() => validateOutbox({ ...base, entries: [{ ...entry, project_id: 'pr_absent' }] }), /projet absent/);
    assert.throws(() => validateOutbox({ ...base, entries: [entry], attachments: [{ id: 'at_1', filename: 'x', stored: 'x', mime: '', size: 1, entry_id: 'en_1', created_at: '2026-09-18T10:00:00.000Z', driveFileId: 'mauvais id!' }] }), /Fichier Drive invalide/);
  });

  test('la validation de sauvegarde reste disponible', () => {
    assert.throws(() => validateBackup({ version: 999 }), /Version de sauvegarde/);
  });
});
