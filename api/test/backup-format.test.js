import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OUTBOX_VERSION, validateBackup, validateOutbox } from '../src/backup-format.js';

const project = { id: 'pr_1', name: 'Chantier', color: '#fff', created_at: '2026-09-18T10:00:00.000Z' };
const entry = { id: 'en_1', title: 'Devis', content_md: 'corps', content_json: null, entry_date: '2026-09-18', project_id: 'pr_1', created_at: '2026-09-18T10:00:00.000Z', updated_at: '2026-09-18T10:00:00.000Z' };
const task = { id: 'tk_1', title: 'Relire', status: 'todo', due_date: null, pinned: 0, position: 0, project_id: 'pr_1', created_at: '2026-09-18T10:00:00.000Z', updated_at: '2026-09-18T10:00:00.000Z' };

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
