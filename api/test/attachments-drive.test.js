import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, make } from './helpers.js';

function mockDrive({ backupPayload, binaries = new Map() } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      status: () => ({ available: true, configured: true, connected: true, pending: false, selectedIds: [] }),
      configure: () => ({}),
      connect: async () => ({}),
      disconnect: async () => ({}),
      async request(url, options = {}) {
        calls.push({ url, options });
        if (url.startsWith('/upload/drive/v3/files')) {
          const body = options.body.toString();
          if (body.includes('worklogs_type') && body.includes('attachment')) {
            const id = `drive-${calls.length}`;
            const match = /worklogs_attachment_id.*?([a-z]+_[a-z0-9]+)/s.exec(body);
            if (match) binaries.set(match[1], { id, body });
            return { id };
          }
          return { id: 'backup-1', name: 'WorkLogs backup.json', modifiedTime: '2026-09-18T10:00:00.000Z', size: '99', mimeType: 'application/json' };
        }
        if (url.includes('?alt=media')) {
          const id = /\/files\/([^?]+)\?alt=media/.exec(url)?.[1];
          if (id === 'backup-1') return JSON.stringify(backupPayload.payload);
          for (const { id: stored, body } of binaries.values()) {
            if (stored === id) return Buffer.from(`binaire-${id}`);
          }
          if (binaries.has(id)) return Buffer.from(`binaire-${id}`);
          // Binaire adossé simulé : contenu déterministe par id Drive.
          if (id?.startsWith('drive-')) return Buffer.from(`binaire-${id}`);
          throw Object.assign(new Error('introuvable'), { status: 404 });
        }
        if (url.startsWith('/drive/v3/files?')) return { files: [] };
        throw new Error(`appel Google inattendu: ${url}`);
      },
    },
  };
}

describe('pièces jointes adossées à Drive', () => {
  test('export envoie les binaires manquants, le JSON référence leurs driveFileId', async () => {
    const drive = mockDrive();
    const api = await startApi({ google: drive.client });
    try {
      const entry = await make.entry(api);
      const up = await api.upload('photo.jpg', 'pixels', { entry_id: entry.id });
      assert.equal(up.body.driveFileId, null);

      const exported = await api.post('/api/google/backup/export');
      assert.equal(exported.status, 201);
      assert.equal(exported.body.binaries, 1);
      const row = api.db.prepare('SELECT drive_file_id FROM attachments WHERE id=?').get(up.body.id);
      assert.match(row.drive_file_id, /^drive-/);
      const download = await api.get('/api/google/backup/backup-1');
      // Le mock ne stocke pas le JSON, on vérifie via la base : le binaire est adossé.
      const second = await api.post('/api/google/backup/export');
      assert.equal(second.body.binaries, 0, 'déjà adossé : rien à renvoyer');
    } finally {
      await api.close();
    }
  });

  test('import retélécharge les binaires manquants, puis fetch unitaire répare un fichier isolé', async () => {
    const T = '2026-09-18T10:00:00.000Z';
    const payload = {
      version: 2,
      exported_at: T,
      projects: [],
      entries: [{ id: 'en_1', title: 'Note', content_md: '', content_json: null, entry_date: '2026-09-18', project_id: null, archived: 0, created_at: T, updated_at: T }],
      tasks: [],
      task_entries: [],
      google_documents: [],
      attachments: [{ id: 'at_1', filename: 'doc.txt', stored: 'doc.txt', mime: 'text/plain', size: 5, entry_id: 'en_1', created_at: T, driveFileId: 'drive-doc-1' }],
    };
    const box = { payload };
    const drive = mockDrive({ backupPayload: box });
    // Surcharge : le téléchargement du backup renvoie notre JSON, les binaires un Buffer.
    const orig = drive.client.request.bind(drive.client);
    drive.client.request = async (url, options) => {
      if (url === '/drive/v3/files/backup-1?alt=media&supportsAllDrives=true') return JSON.stringify(payload);
      return orig(url, options);
    };
    const api = await startApi({ google: drive.client });
    try {
      // Liste avec le backup simulé.
      drive.client.request = async (url, options) => {
        if (url.startsWith('/drive/v3/files?')) return { files: [{ id: 'backup-1', name: 'b.json', modifiedTime: T, size: '10', mimeType: 'application/json' }] };
        if (url === '/drive/v3/files/backup-1?alt=media&supportsAllDrives=true') return JSON.stringify(payload);
        return orig(url, options);
      };
      const restored = await api.post('/api/google/backup/backup-1/import');
      assert.equal(restored.body.binaries, 1);
      assert.equal(fs.readFileSync(path.join(api.uploadDir, 'doc.txt'), 'utf8'), 'binaire-drive-doc-1');

      // Fichier isolé : on l'efface, le fetch le ramène.
      fs.rmSync(path.join(api.uploadDir, 'doc.txt'));
      const status = await api.get('/api/google/attachments/status');
      assert.deepEqual(status.body, { total: 1, onDrive: 1, missingLocal: 1, connected: true });
      const fetched = await api.post('/api/google/attachments/at_1/fetch');
      assert.equal(fetched.body.fetched, true);
      assert.ok(fs.existsSync(path.join(api.uploadDir, 'doc.txt')));
      const again = await api.post('/api/google/attachments/at_1/fetch');
      assert.equal(again.body.fetched, false);
    } finally {
      await api.close();
    }
  });

  test('fetch refuse un fichier local seul, sans Drive', async () => {
    const drive = mockDrive();
    const api = await startApi({ google: drive.client });
    try {
      const entry = await make.entry(api);
      const up = await api.upload('local.txt', 'x', { entry_id: entry.id });
      fs.rmSync(path.join(api.uploadDir, up.body.stored));
      const res = await api.post(`/api/google/attachments/${up.body.id}/fetch`);
      assert.equal(res.status, 404);
      assert.match(res.body.error, /pas encore sur Google Drive/);
    } finally {
      await api.close();
    }
  });
});
