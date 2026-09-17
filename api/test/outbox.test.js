import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, make } from './helpers.js';

const T0 = '2026-09-18T10:00:00.000Z';
const T1 = '2026-09-18T12:00:00.000Z';

function outbox(overrides = {}) {
  return {
    version: 1,
    exported_at: T1,
    base_exported_at: T0,
    device: 'pwa',
    projects: [{ id: 'pr_mob', name: 'Mobile', color: '#fff', created_at: T0 }],
    entries: [{ id: 'en_mob', title: 'Note mobile', content_md: 'corps', content_json: null, entry_date: '2026-09-18', project_id: 'pr_mob', created_at: T0, updated_at: T0 }],
    tasks: [{ id: 'tk_mob', title: 'Relire', status: 'todo', due_date: null, pinned: 0, position: 0, priority: 'normal', project_id: 'pr_mob', created_at: T0, updated_at: T0 }],
    task_entries: [{ task_id: 'tk_mob', entry_id: 'en_mob', created_at: T0 }],
    attachments: [{ id: 'at_mob', filename: 'photo.jpg', stored: 'mob.jpg', mime: 'image/jpeg', size: 6, entry_id: 'en_mob', created_at: T0, driveFileId: 'drive-photo-1' }],
    ...overrides,
  };
}

function mockGoogle(box) {
  return {
    status: () => ({ available: true, configured: true, connected: true, pending: false, selectedIds: [] }),
    configure: () => ({}),
    connect: async () => ({}),
    disconnect: async () => ({}),
    async request(url) {
      if (url.includes('/drive/v3/files?')) {
        return { files: [{ id: 'ob-1', name: 'WorkLogs outbox.json', modifiedTime: T1, size: '99', mimeType: 'application/json' }] };
      }
      if (url.includes('drive-photo-1')) return Buffer.from('binaire-photo');
      if (url.includes('?alt=media')) return JSON.stringify(box.payload);
      throw new Error(`appel Google inattendu: ${url}`);
    },
  };
}

describe('boîte mobile', () => {
  test('liste, importe (lignes + binaire), puis réimporte sans rien changer', async () => {
    const box = { payload: outbox() };
    const api = await startApi({ google: mockGoogle(box) });
    try {
      const listed = await api.get('/api/google/outbox/list');
      assert.deepEqual(listed.body.files, [{ id: 'ob-1', name: 'WorkLogs outbox.json', modifiedTime: T1, size: 99 }]);

      const imported = await api.post('/api/google/outbox/ob-1/import');
      assert.deepEqual(imported.body, { ok: true, projects: 1, entries: 1, tasks: 1, links: 1, attachments: 1, binaries: 1, updated: 0, conflicts: 0 });
      assert.equal(api.db.prepare('SELECT title FROM entries WHERE id=?').get('en_mob').title, 'Note mobile');
      assert.equal(api.db.prepare('SELECT COUNT(*) n FROM task_entries').get().n, 1);
      assert.equal(fs.readFileSync(path.join(api.uploadDir, 'mob.jpg'), 'utf8'), 'binaire-photo');

      const again = await api.post('/api/google/outbox/ob-1/import');
      assert.deepEqual(again.body, { ok: true, projects: 0, entries: 0, tasks: 0, links: 0, attachments: 0, binaries: 0, updated: 0, conflicts: 0 });
    } finally {
      await api.close();
    }
  });

  test('mise à jour plus récente appliquée, conflit conservé côté PC', async () => {
    const box = { payload: outbox() };
    const api = await startApi({ google: mockGoogle(box) });
    try {
      const project = await make.project(api, 'PC');
      const entry = await make.entry(api, { title: 'Locale', project_id: project.id });
      await api.post('/api/google/outbox/ob-1/import');

      // Version mobile plus récente : appliquée.
      const future = new Date(Date.now() + 864e5).toISOString();
      const withProject = (entries) => outbox({ projects: [project], entries, tasks: [], task_entries: [], attachments: [] });
      box.payload = withProject([{ id: entry.id, title: 'Depuis mobile', content_md: '', content_json: null, entry_date: '2026-09-18', project_id: project.id, created_at: T0, updated_at: future }]);
      const updated = await api.post('/api/google/outbox/ob-1/import');
      assert.equal(updated.body.updated, 1);
      assert.equal(api.db.prepare('SELECT title FROM entries WHERE id=?').get(entry.id).title, 'Depuis mobile');

      // Version mobile plus ancienne et différente : conflit, PC conservé.
      box.payload = withProject([{ id: entry.id, title: 'Vieux brouillon', content_md: '', content_json: null, entry_date: '2026-09-18', project_id: project.id, created_at: T0, updated_at: T0 }]);
      const conflicted = await api.post('/api/google/outbox/ob-1/import');
      assert.equal(conflicted.body.conflicts, 1);
      assert.equal(api.db.prepare('SELECT title FROM entries WHERE id=?').get(entry.id).title, 'Depuis mobile');
    } finally {
      await api.close();
    }
  });

  test('identifiant et contenu invalides refusés en français', async () => {
    const box = { payload: outbox() };
    const api = await startApi({ google: mockGoogle(box) });
    try {
      assert.equal((await api.post('/api/google/outbox/mauvais id!/import')).status, 400);
      box.payload = { version: 999 };
      const result = await api.post('/api/google/outbox/ob-1/import');
      assert.equal(result.status, 400);
      assert.match(result.body.error, /Version de boîte mobile/);
    } finally {
      await api.close();
    }
  });
});
