import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, make } from './helpers.js';

describe('sauvegardes Google Drive', () => {
  test('exporte, liste, télécharge et restaure une sauvegarde WorkLogs', async () => {
    let stored;
    const calls = [];
    const google = {
      status: () => ({ available: true, configured: true, connected: true, pending: false, selectedIds: [] }),
      configure: () => ({}),
      connect: async () => ({}),
      disconnect: async () => ({}),
      async request(url, options = {}) {
        calls.push({ url, options });
        if (url.startsWith('/upload/drive/v3/files')) return { id: 'backup-1', name: 'WorkLogs backup.json', modifiedTime: '2026-09-17T10:00:00.000Z', size: '1234', mimeType: 'application/json' };
        if (url.startsWith('/drive/v3/files?') && url.includes('worklogs_type')) return { files: [{ id: 'backup-1', name: 'WorkLogs backup.json', modifiedTime: '2026-09-17T10:00:00.000Z', size: '1234', mimeType: 'application/json' }] };
        if (url.startsWith('/drive/v3/files/backup-1?alt=media')) return JSON.stringify(stored);
        throw new Error(`appel Google inattendu: ${url}`);
      },
    };
    const api = await startApi({ google });
    try {
      const project = await make.project(api, 'Projet sauvegardé');
      const entry = await make.entry(api, { title: 'Contexte sauvegardé', project_id: project.id });
      const rich = '{"type":"doc","content":[{"type":"paragraph"}]}';
      api.db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(rich, entry.id);
      api.db.prepare(`INSERT INTO google_documents
        (entry_id,document_id,tab_id,revision_id,synced_content_json,document_title,tab_title)
        VALUES (?,?,?,?,?,?,?)`).run(entry.id, 'google-backup-doc', 'tab-1', 'r1', rich, 'Dossier sauvegardé', 'Contexte');
      const task = await make.task(api, { title: 'Tâche sauvegardée', project_id: project.id });
      await api.post(`/api/tasks/${task.id}/documents/${entry.id}`);
      stored = (await api.get('/api/export')).body;

      const exported = await api.post('/api/google/backup/export');
      assert.equal(exported.status, 201);
      assert.deepEqual(exported.body, { id: 'backup-1', name: 'WorkLogs backup.json', modifiedTime: '2026-09-17T10:00:00.000Z', size: 1234 });
      const upload = calls.find(call => call.url.startsWith('/upload/'));
      assert.match(upload.options.headers['Content-Type'], /^multipart\/related; boundary=/);
      assert.ok(Buffer.isBuffer(upload.options.body));
      assert.match(upload.options.body.toString(), /worklogs_type/);

      const listed = await api.get('/api/google/backup/list');
      assert.deepEqual(listed.body.files, [exported.body]);
      const downloaded = await api.get('/api/google/backup/backup-1');
      assert.equal(downloaded.body.version, 2);
      assert.equal(downloaded.body.google_documents.length, 1);
      assert.equal(downloaded.body.google_documents[0].document_id, 'google-backup-doc');

      await api.db.prepare('DELETE FROM task_entries').run();
      await api.db.prepare('DELETE FROM tasks').run();
      const restored = await api.post('/api/google/backup/backup-1/import');
      assert.equal(restored.status, 200);
      assert.deepEqual(restored.body, { ok: true, projects: 1, entries: 1, tasks: 1 });
      assert.equal(api.db.prepare('SELECT title FROM entries').get().title, 'Contexte sauvegardé');
      assert.equal(api.db.prepare('SELECT COUNT(*) n FROM task_entries').get().n, 1);
      assert.equal(api.db.prepare('SELECT document_id FROM google_documents').get().document_id, 'google-backup-doc');
    } finally {
      await api.close();
    }
  });

  test('refuse une sauvegarde invalide sans modifier la base', async () => {
    let stored = { version: 999 };
    const google = {
      status: () => ({ available: true, configured: true, connected: true, pending: false, selectedIds: [] }),
      configure: () => ({}), connect: async () => ({}), disconnect: async () => ({}),
      request: async () => typeof stored === 'string' ? stored : JSON.stringify(stored),
    };
    const api = await startApi({ google });
    try {
      await make.project(api, 'À conserver');
      const result = await api.post('/api/google/backup/backup-1/import');
      assert.equal(result.status, 400);
      assert.match(result.body.error, /Version de sauvegarde/);
      assert.equal(api.db.prepare('SELECT COUNT(*) n FROM projects').get().n, 1);
      stored = '{bad';
      const malformed = await api.get('/api/google/backup/backup-1');
      assert.equal(malformed.status, 422);
    } finally {
      await api.close();
    }
  });

  test('signale que les sauvegardes Drive sont réservées au desktop', async () => {
    const api = await startApi();
    try {
      assert.equal((await api.post('/api/google/backup/export')).status, 503);
      assert.equal((await api.get('/api/google/backup/list')).status, 503);
    } finally {
      await api.close();
    }
  });
});
