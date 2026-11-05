import { beforeEach, expect, test } from 'vitest';
import { ApiError, type Task, type TaskPlanningSnapshot } from '../lib';
import { localApi, setLocalDatabase } from './localApi';
import { createMemoryDatabase } from './storage';

beforeEach(() => { localStorage.clear(); setLocalDatabase(createMemoryDatabase()); });
const expected = (task: Task): TaskPlanningSnapshot => ({
  title: task.title, status: task.status, priority: task.priority, due_date: task.due_date,
  project_id: task.project_id, pinned: task.pinned, follow_up_key: task.follow_up_key ?? null,
});
const current = async (id: string) => (await localApi.state()).tasks.find((task) => task.id === id)!;

test('PWA : la replanification comparée garde statut et texte ; les gestes habituels restent utilisables', async () => {
  const task = await localApi.createTask({ title: 'Contrôler', status: 'doing' });
  const result = await localApi.updateTask(task.id, { priority: 'high', due_date: '2026-11-06', expected_planning: expected(task) });
  expect(result).toMatchObject({ title: 'Contrôler', status: 'doing', priority: 'high', due_date: '2026-11-06' });
  await localApi.updateTask(task.id, { title: 'Contrôler la vanne' });
  expect((await current(task.id)).title).toBe('Contrôler la vanne');
});

test('PWA : statut, priorité, date ou titre modifiés depuis la proposition font refuser le PUT sans mutation', async () => {
  for (const patch of [{ status: 'done' as const }, { priority: 'high' as const }, { due_date: '2026-11-20' }, { title: 'Autre titre' }, { pinned: 1 as const }]) {
    const task = await localApi.createTask({ title: 'Action à dater' });
    await localApi.updateTask(task.id, patch);
    const before = await current(task.id);
    await expect(localApi.updateTask(task.id, { due_date: '2026-11-07', priority: 'low', expected_planning: expected(task) })).rejects.toMatchObject({ code: 'TASK_PLANNING_STALE' });
    expect(await current(task.id)).toEqual(before);
  }
});

test('PWA : la nouvelle source d’un suivi est comparée et la réponse réussie contient la nouvelle empreinte', async () => {
  const task = await localApi.createTask({ title: 'Intervenir' });
  const note = await localApi.createEntry({ title: 'Avancées', content_md: 'Pièce attendue.' });
  await localApi.linkTaskDocument(task.id, note.id);
  await localApi.saveFollowUp('task', task.id, { enabled: true });
  const snapshot = await current(task.id);
  await localApi.updateEntry(note.id, { content_md: 'Pièce reçue.' });
  const before = await current(task.id);
  await expect(localApi.updateTask(task.id, { priority: 'high', due_date: '2026-11-07', expected_planning: expected(snapshot) })).rejects.toMatchObject({ code: 'TASK_PLANNING_STALE' });
  expect(await current(task.id)).toEqual(before);
  const updated = await localApi.updateTask(task.id, { priority: 'high', due_date: '2026-11-07', expected_planning: expected(before) });
  expect(updated.follow_up_key).toBe((await current(task.id)).follow_up_key);
  expect(updated.follow_up_key).not.toBe(before.follow_up_key);
});

test('PWA : la file locale compare chaque application au moment de l’écriture et refuse de rejouer un instantané utilisé', async () => {
  const task = await localApi.createTask({ title: 'Tâche unique' });
  const results = await Promise.allSettled(['2026-11-06', '2026-11-07'].map((due_date) => localApi.updateTask(task.id, { priority: 'high', due_date, expected_planning: expected(task) })));
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'TASK_PLANNING_STALE' });
  const before = await current(task.id);
  await expect(localApi.updateTask(task.id, { priority: before.priority, due_date: before.due_date, expected_planning: expected(task) })).rejects.toMatchObject({ code: 'TASK_PLANNING_STALE' });
  expect(await current(task.id)).toEqual(before);
});

test('PWA : un instantané mal formé n’écrit rien, et la file accepte la mutation suivante', async () => {
  const task = await localApi.createTask({ title: 'Garder' });
  const before = await current(task.id);
  for (const invalid of [null, [], {}, { ...expected(task), status: 'blocked' }, { ...expected(task), due_date: 5 }, { ...expected(task), typo: true }]) {
    await expect(localApi.updateTask(task.id, { due_date: '2026-11-07', expected_planning: invalid as never })).rejects.toBeInstanceOf(ApiError);
    expect(await current(task.id)).toEqual(before);
  }
  expect((await localApi.updateTask(task.id, { title: 'Toujours utilisable' })).title).toBe('Toujours utilisable');
});
