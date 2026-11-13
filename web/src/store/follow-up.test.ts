import { beforeEach, expect, test } from 'vitest';
import { ApiError, remoteApi, type FollowUp, type FollowUpKind, type FollowUpReportDraft } from '../lib';
import { useRealApi } from '../test/server';
import { applySyncSnapshot, clearLocalOutbox, exportLocalOutbox, importLocalBackup, localApi, localSyncSnapshot, setLocalDatabase } from './localApi';
import { createMemoryDatabase } from './storage';

let database = createMemoryDatabase();
beforeEach(() => {
  localStorage.clear();
  database = createMemoryDatabase();
  setLocalDatabase(database);
});
const REPORT: FollowUpReportDraft = {
  status: 'blocked', summary: 'Devis prêt, signature attendue.', completed: ['Devis préparé'],
  next_steps: ['Obtenir la signature'], blockers: ['Signature attendue'], warnings: [],
};
async function saveReport(kind: FollowUpKind, id: string) {
  const value = await localApi.followUp(kind, id);
  return localApi.saveFollowUp(kind, id, { report: REPORT, source_key: value.source_key });
}

test('PWA : le suivi reste séparé du texte et du statut et remonte dans les résumés', async () => {
  const entry = await localApi.createEntry({ title: 'Avancées', content_md: '- [x] Devis préparé\nSignature attendue' });
  const task = await localApi.createTask({ title: 'Signer' });
  await localApi.linkTaskDocument(task.id, entry.id);
  const beforeEntry = (await localApi.entry(entry.id)).updated_at;
  const beforeTask = (await localApi.state()).tasks.find((row) => row.id === task.id)!.updated_at;
  const initial = await localApi.followUp('entry', entry.id);
  expect(initial.follow_up).toBeNull();
  const configured = await localApi.saveFollowUp('entry', entry.id, { enabled: true });
  const saved = await saveReport('entry', entry.id);
  await saveReport('task', task.id);
  const state = await localApi.state();
  expect(state.entries.find((row) => row.id === entry.id)?.follow_up).toEqual(saved.follow_up);
  expect(state.entries.find((row) => row.id === entry.id)?.follow_up_key).toBe(initial.source_key);
  expect(state.tasks.find((row) => row.id === task.id)?.status).toBe('todo');
  expect((await localApi.entry(entry.id)).updated_at).toBe(beforeEntry);
  expect(state.tasks.find((row) => row.id === task.id)?.updated_at).toBe(beforeTask);
  expect(saved.follow_up?.enabled_at).toBe(configured.follow_up?.enabled_at);
  expect((await localApi.entry(entry.id)).content_md).toBe(entry.content_md);
  expect((await localApi.entry(entry.id)).archived).toBe(0);
  expect((await localApi.copyEntry(entry.id)).follow_up ?? null).toBeNull();
  const paused = await localApi.saveFollowUp('entry', entry.id, { enabled: false });
  expect(paused.follow_up?.report).toEqual(saved.follow_up?.report);
  expect(paused.source_key).toBe(initial.source_key);
  expect((await localApi.entry(entry.id)).updated_at).toBe(beforeEntry);
  // « Désactiver » : plus d'automatisme ni de bilan, le texte ne bouge pas.
  const off = await localApi.saveFollowUp('entry', entry.id, { enabled: false, report: null });
  expect(off.follow_up).toMatchObject({ enabled: false, report: null, cleared_at: off.follow_up?.enabled_at });
  expect((await localApi.state()).entries.find((row) => row.id === entry.id)?.follow_up).toEqual(off.follow_up);
  expect((await localApi.entry(entry.id)).updated_at).toBe(beforeEntry);
  await expect(localApi.saveFollowUp('entry', entry.id, { enabled: true, report: null })).rejects.toBeInstanceOf(ApiError);
});

test('PWA : une avancée enregistrée invalide le bilan lié et une réponse obsolète garde le dernier bilan', async () => {
  const entry = await localApi.createEntry({ title: 'Avancées', content_md: 'Devis prêt' });
  const task = await localApi.createTask({ title: 'Signer' });
  await localApi.linkTaskDocument(task.id, entry.id);
  const saved = await saveReport('task', task.id);
  await localApi.updateEntry(entry.id, { content_md: 'Devis prêt\nSignature reçue' });
  const current = await localApi.followUp('task', task.id);
  expect(current.source_key).not.toBe(saved.source_key);
  expect((await localApi.state()).tasks.find((row) => row.id === task.id)?.follow_up_key).toBe(current.source_key);
  await expect(localApi.saveFollowUp('task', task.id, { report: REPORT, source_key: saved.source_key }))
    .rejects.toMatchObject({ code: 'FOLLOW_UP_STALE' });
  expect((await localApi.followUp('task', task.id)).follow_up).toEqual(saved.follow_up);
  await expect(localApi.saveFollowUp('task', task.id, { enabled: 'oui' } as never)).rejects.toBeInstanceOf(ApiError);
  await expect(localApi.followUp('entry', 'absente')).rejects.toThrow('entrée introuvable');
});

test('PWA : statut et échéance restent lus sans rendre le bilan obsolète, un nouveau titre le rend obsolète', async () => {
  const task = await localApi.createTask({ title: 'Signer' });
  const saved = await saveReport('task', task.id);
  await localApi.updateTask(task.id, { status: 'doing', due_date: '2026-12-01' });
  await localApi.moveTask(task.id, 'done', 0);
  const closed = await localApi.followUp('task', task.id);
  expect(closed.source_key).toBe(saved.source_key);
  expect(closed.source).toMatchObject({ status: 'done', due_date: '2026-12-01' });
  await localApi.updateTask(task.id, { title: 'Signer le devis' });
  expect((await localApi.followUp('task', task.id)).source_key).not.toBe(saved.source_key);
});

test('PWA : sauvegarde, restauration et boîte mobile conservent les bilans ; les vieux exports restent valides', async () => {
  const entry = await localApi.createEntry({ title: 'Bilan à garder', content_md: 'Devis prêt' });
  const task = await localApi.createTask({ title: 'Signer' });
  await localApi.saveFollowUp('entry', entry.id, { enabled: true });
  const saved = await saveReport('entry', entry.id);
  const taskSaved = await saveReport('task', task.id);
  const box = await exportLocalOutbox();
  expect(box.entries.find((row) => row.id === entry.id)?.follow_up).toEqual(saved.follow_up);
  expect(box.tasks.find((row) => row.id === task.id)?.follow_up).toEqual(taskSaved.follow_up);

  const backup = JSON.parse(await (await localApi.exportBackup()).blob.text());
  setLocalDatabase(createMemoryDatabase());
  await importLocalBackup(backup);
  expect((await localApi.entry(entry.id)).follow_up).toEqual(saved.follow_up);
  expect((await localApi.followUp('task', task.id)).follow_up).toEqual(taskSaved.follow_up);
  for (const row of [...backup.entries, ...backup.tasks]) delete row.follow_up;
  await importLocalBackup(backup);
  expect((await localApi.followUp('entry', entry.id)).follow_up).toBeNull();
  expect((await localApi.followUp('task', task.id)).follow_up).toBeNull();
});

test('PWA : la synchro ne recouvre pas un suivi modifié localement dans la même milliseconde', async () => {
  const entry = await localApi.createEntry({ title: 'Avancées', content_md: 'Devis prêt' });
  const task = await localApi.createTask({ title: 'Signer' });
  await localApi.saveFollowUp('entry', entry.id, { enabled: true });
  await saveReport('entry', entry.id);
  await localApi.saveFollowUp('task', task.id, { enabled: true });
  await saveReport('task', task.id);
  const base = await localSyncSnapshot();
  const merged = structuredClone(base);
  for (const [tableName, id] of [['entries', entry.id], ['tasks', task.id]] as const) {
    const table = database.table<{ id: string; follow_up: FollowUp; updated_at: string }>(tableName);
    const row = (await table.get(id))!;
    await table.put({ ...row, follow_up: { ...row.follow_up, enabled: false } });
    const incoming = merged[tableName].find((value) => value.id === id)!;
    incoming.follow_up!.report!.summary = 'Bilan reçu de l’autre appareil';
  }
  clearLocalOutbox();
  const result = await applySyncSnapshot(merged, base);
  expect(result).toEqual({ changed: 0, skipped: 1 });
  expect((await localApi.followUp('entry', entry.id)).follow_up?.enabled).toBe(false);
  expect((await localApi.followUp('task', task.id)).follow_up?.enabled).toBe(false);
});

test('les sources et leurs empreintes sont identiques entre serveur et PWA après restauration', async () => {
  const server = await useRealApi();
  try {
    const project = await remoteApi.createProject({ name: 'Chantier commun' });
    const entry = await remoteApi.createEntry({ title: 'Avancées', project_id: project.id,
      content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Devis prêt' }] }] } });
    const task = await remoteApi.createTask({ title: 'Signer', project_id: project.id, due_date: '2026-12-10' });
    await remoteApi.linkTaskDocument(task.id, entry.id);
    await remoteApi.saveFollowUp('entry', entry.id, { enabled: true });
    const source = await remoteApi.followUp('task', task.id);
    await remoteApi.saveFollowUp('task', task.id, { report: REPORT, source_key: source.source_key });
    await importLocalBackup(await (await fetch('/api/export')).json());
    const previousKeys = new Map<FollowUpKind, string>();
    for (const [kind, id] of [['entry', entry.id], ['task', task.id]] as const) {
      const snapshot = await localApi.followUp(kind, id);
      expect(snapshot).toEqual(await remoteApi.followUp(kind, id));
      expect(snapshot.source.documents[0].kind).toBe('note');
      previousKeys.set(kind, snapshot.source_key);
    }
    await remoteApi.updateEntry(entry.id, { kind: 'procedure' });
    await localApi.updateEntry(entry.id, { kind: 'procedure' });
    for (const [kind, id] of [['entry', entry.id], ['task', task.id]] as const) {
      const snapshot = await localApi.followUp(kind, id);
      expect(snapshot.source.documents[0].kind).toBe('procedure');
      expect(snapshot.source_key).not.toBe(previousKeys.get(kind));
      expect(snapshot).toEqual(await remoteApi.followUp(kind, id));
    }
  } finally { await server.close(); }
});
