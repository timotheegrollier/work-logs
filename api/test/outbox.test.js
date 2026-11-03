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
  test('un bilan plus récent ne ressuscite pas une source supprimée ; une nouvelle saisie le peut', async () => {
    const payload = outbox({ attachments: [] });
    const box = { payload };
    const api = await startApi({ google: mockGoogle(box) });
    try {
      await api.post('/api/google/outbox/ob-1/import');
      await api.del('/api/tasks/tk_mob');
      await api.del('/api/entries/en_mob');
      api.db.prepare('UPDATE sync_tombstones SET deleted_at=? WHERE kind IN (?,?)').run(T1, 'entry', 'task');
      const later = '2026-09-18T14:00:00.000Z';
      for (const row of [...payload.entries, ...payload.tasks]) row.follow_up = {
        enabled: true, enabled_at: later,
        report: { status: 'doing', summary: 'Bilan reçu après la suppression.', completed: [], next_steps: [],
          blockers: [], warnings: [], generated_at: later, source_key: 'fu_deleted_source' },
      };
      for (const sourceTime of [T0, T1]) {
        for (const row of [...payload.entries, ...payload.tasks]) row.updated_at = sourceTime;
        const ignored = await api.post('/api/google/outbox/ob-1/import');
        assert.equal(ignored.body.conflicts, 2);
        assert.equal(ignored.body.entries, 0);
        assert.equal(ignored.body.tasks, 0);
        assert.equal(api.db.prepare('SELECT COUNT(*) n FROM entries WHERE id=?').get('en_mob').n, 0);
        assert.equal(api.db.prepare('SELECT COUNT(*) n FROM tasks WHERE id=?').get('tk_mob').n, 0);
        assert.equal(api.db.prepare('SELECT COUNT(*) n FROM task_entries').get().n, 0);
      }

      payload.entries[0].content_md = 'Nouvelle saisie mobile après la suppression.';
      payload.tasks[0].title = 'Tâche retouchée après la suppression';
      for (const row of [...payload.entries, ...payload.tasks]) row.updated_at = later;
      const resurrected = await api.post('/api/google/outbox/ob-1/import');
      assert.equal(resurrected.body.entries, 1);
      assert.equal(resurrected.body.tasks, 1);
      assert.equal(resurrected.body.conflicts, 0);
      assert.equal(api.db.prepare('SELECT content_md FROM entries WHERE id=?').get('en_mob').content_md, payload.entries[0].content_md);
      assert.equal(api.db.prepare('SELECT title FROM tasks WHERE id=?').get('tk_mob').title, payload.tasks[0].title);
    } finally { await api.close(); }
  });

  test('fusionne les suivis IA avec leurs horloges sans rajeunir ni remplacer les sources du PC', async () => {
    const tracking = { enabled: true, enabled_at: T0, report: {
      status: 'doing', summary: 'Devis prêt.', completed: ['Devis préparé'], next_steps: ['Signer'],
      blockers: [], warnings: [], generated_at: T0, source_key: 'fu_imported',
    } };
    const payload = outbox({ attachments: [] });
    payload.entries[0].follow_up = structuredClone(tracking);
    payload.tasks[0].follow_up = structuredClone(tracking);
    const box = { payload };
    const api = await startApi({ google: mockGoogle(box) });
    try {
      const imported = await api.post('/api/google/outbox/ob-1/import');
      assert.equal(imported.status, 200);
      assert.deepEqual((await api.get('/api/follow-up/entry/en_mob')).body.follow_up, tracking);
      assert.deepEqual((await api.get('/api/follow-up/task/tk_mob')).body.follow_up, tracking);
      assert.equal((await api.post('/api/google/outbox/ob-1/import')).body.conflicts, 0);
      for (const row of [...box.payload.entries, ...box.payload.tasks]) {
        row.follow_up.report.generated_at = T1;
        row.follow_up.report.summary = 'Signature obtenue.';
      }
      const reportOnly = await api.post('/api/google/outbox/ob-1/import');
      assert.equal(reportOnly.body.updated, 2, 'un bilan seul est importé même à horloge de source égale');
      assert.equal(reportOnly.body.conflicts, 0, 'une différence de bilan ne crée pas un conflit de source');
      assert.equal((await api.get('/api/follow-up/task/tk_mob')).body.follow_up.report.summary, 'Signature obtenue.');
      assert.equal(api.db.prepare('SELECT updated_at FROM entries WHERE id=?').get('en_mob').updated_at, T0);
      assert.equal(api.db.prepare('SELECT updated_at FROM tasks WHERE id=?').get('tk_mob').updated_at, T0);
      for (const row of [...box.payload.entries, ...box.payload.tasks]) row.follow_up.report.summary = 'Autre bilan au même instant.';
      assert.equal((await api.post('/api/google/outbox/ob-1/import')).body.conflicts, 0);
      assert.equal((await api.get('/api/follow-up/entry/en_mob')).body.follow_up.report.summary, 'Signature obtenue.');

      const desktopTime = '2026-09-18T14:00:00.000Z';
      const reportTime = '2026-09-18T16:00:00.000Z';
      api.db.prepare('UPDATE entries SET content_md=?,updated_at=? WHERE id=?').run('Texte corrigé sur le PC', desktopTime, 'en_mob');
      api.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('doing', desktopTime, 'tk_mob');
      for (const row of [...box.payload.entries, ...box.payload.tasks]) {
        row.follow_up.enabled = false;
        row.follow_up.enabled_at = reportTime;
        row.follow_up.report.generated_at = reportTime;
        row.follow_up.report.summary = 'Bilan mobile reçu après la correction du PC.';
      }
      const olderSource = await api.post('/api/google/outbox/ob-1/import');
      assert.equal(olderSource.body.updated, 2, 'le nouveau suivi est conservé même si sa source est ancienne');
      assert.equal(olderSource.body.conflicts, 2, 'les différences de sources restent signalées');
      const entry = (await api.get('/api/entries/en_mob')).body;
      const task = (await api.get('/api/state')).body.tasks.find((row) => row.id === 'tk_mob');
      assert.equal(entry.content_md, 'Texte corrigé sur le PC');
      assert.equal(task.status, 'doing');
      assert.equal(entry.updated_at, desktopTime);
      assert.equal(task.updated_at, desktopTime);
      assert.equal(entry.follow_up.enabled, false);
      assert.equal(task.follow_up.report.generated_at, reportTime);
    } finally { await api.close(); }
  });

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
