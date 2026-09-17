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
      // Le multipart Drive exige de vrais CRLF (13,10), pas des antislashs littéraux.
      const boundary = upload.options.headers['Content-Type'].split('boundary=')[1];
      assert.ok(boundary && !/[\r\n]/.test(boundary));
      assert.ok(upload.options.body.includes(Buffer.from('\r\n')), 'le corps multipart utilise des CRLF');
      assert.ok(!upload.options.body.includes(Buffer.from('\\r\\n')), 'pas de séquence antislash-r-n littérale');
      assert.ok(upload.options.body.subarray(0, boundary.length + 4).equals(Buffer.from(`--${boundary}\r\n`)));
      assert.ok(upload.options.body.subarray(-boundary.length - 8).equals(Buffer.from(`\r\n--${boundary}--\r\n`)));

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

  test('les priorités survivent à l’export et les anciens exports reviennent en « normale »', async () => {
    const { restoreBackup } = await import('../src/backup.js');
    const api = await startApi();
    try {
      const haute = await make.task(api, { title: 'Prioritaire', priority: 'high' });
      const exported = (await api.get('/api/export')).body;
      assert.equal(exported.tasks.find((task) => task.id === haute.id).priority, 'high');

      await api.del(`/api/tasks/${haute.id}`);
      restoreBackup(api.db, exported);
      assert.equal(api.db.prepare('SELECT priority FROM tasks WHERE id=?').get(haute.id).priority, 'high');

      // Export d’avant la fonctionnalité : pas de champ priority.
      const legacy = structuredClone(exported);
      for (const task of legacy.tasks) delete task.priority;
      await api.del(`/api/tasks/${haute.id}`);
      restoreBackup(api.db, legacy);
      assert.equal(api.db.prepare('SELECT priority FROM tasks WHERE id=?').get(haute.id).priority, 'normal');

      legacy.tasks[0].priority = 'critique';
      assert.throws(() => restoreBackup(api.db, legacy), /Priorité de tâche invalide/);
    } finally {
      await api.close();
    }
  });

  test('l’archivage survit à l’export et les anciens exports restent visibles', async () => {
    const { restoreBackup } = await import('../src/backup.js');
    const api = await startApi();
    try {
      const entry = await make.entry(api, { title: 'À archiver' });
      await api.put(`/api/entries/${entry.id}`, { archived: 1 });
      const exported = (await api.get('/api/export')).body;
      assert.equal(exported.entries.find((row) => row.id === entry.id).archived, 1);

      await api.del(`/api/entries/${entry.id}`);
      restoreBackup(api.db, exported);
      assert.equal(api.db.prepare('SELECT archived FROM entries WHERE id=?').get(entry.id).archived, 1);

      const legacy = structuredClone(exported);
      for (const row of legacy.entries) delete row.archived;
      await api.del(`/api/entries/${entry.id}`);
      restoreBackup(api.db, legacy);
      assert.equal(api.db.prepare('SELECT archived FROM entries WHERE id=?').get(entry.id).archived, 0);

      legacy.entries[0].archived = 2;
      assert.throws(() => restoreBackup(api.db, legacy), /Archivage d’entrée invalide/);
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
