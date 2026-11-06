import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clearLocalOutbox, exportLocalOutbox, localApi, onLocalChange, setLocalDatabase } from './localApi';
import { createMemoryDatabase, type Database } from './storage';
import type { Task } from '../lib';
// @ts-expect-error — marqueur partagé avec la migration SQLite.
import { TASK_CATEGORY_MIGRATION } from '../../../api/src/task-categories.js';

beforeEach(() => { localStorage.clear(); setLocalDatabase(createMemoryDatabase()); });
afterEach(() => { onLocalChange(null); });

async function fixture() {
  const project = await localApi.createProject({ name: 'Chantier' });
  const otherProject = await localApi.createProject({ name: 'Ailleurs' });
  const first = await localApi.createCategory({ name: 'Devis', project_id: project.id });
  const second = await localApi.createCategory({ name: 'Livraison', project_id: project.id });
  return { project, otherProject, first, second };
}
const classification = async (id: string) => (await localApi.state()).tasks.find((row) => row.id === id)?.category_id;

function rejectTaskWriteOnce(memory: Database, taskId: string): Database {
  let rejectWrite = true;
  return {
    table<T extends object>(name: string) {
      const table = memory.table<T>(name);
      return {
        ...table,
        put: async (row: T) => {
          const task = row as Partial<Task>;
          if (name === 'tasks' && task.id === taskId && task.category_id && rejectWrite) {
            rejectWrite = false;
            throw new Error('stockage temporairement indisponible');
          }
          await table.put(row);
        },
      };
    },
  };
}

test('PWA : lier une entrée classée remplit la catégorie sans remplacer un choix ni changer le projet', async () => {
  const { project, otherProject, first, second } = await fixture();
  const note = await localApi.createEntry({ title: 'Note', project_id: project.id, category_id: first.id });
  const task = await localApi.createTask({ title: 'À classer', project_id: project.id });
  const explicit = await localApi.createTask({ title: 'Choisie', project_id: project.id, category_id: second.id });
  const foreign = await localApi.createTask({ title: 'Ailleurs', project_id: otherProject.id });
  const unassigned = await localApi.createTask({ title: 'Sans projet' });
  clearLocalOutbox();
  for (const target of [task, explicit, foreign, unassigned]) await localApi.linkTaskDocument(target.id, note.id);
  expect(await classification(task.id)).toBe(first.id);
  expect(await classification(explicit.id)).toBe(second.id);
  expect(await classification(foreign.id)).toBeNull();
  expect(await classification(unassigned.id)).toBeNull();
  expect((await exportLocalOutbox()).tasks.map((row) => row.id)).toEqual([task.id]);
  await localApi.linkTaskDocument(task.id, note.id);
  const otherNote = await localApi.createEntry({ title: 'Note', project_id: project.id, category_id: second.id });
  await localApi.linkTaskDocument(task.id, otherNote.id);
  expect(await classification(task.id)).toBe(first.id);
  expect((await localApi.state('', project.id, first.id)).tasks.map((row) => row.id)).toEqual([task.id]);
});

test('PWA : classer une entrée liée remplit les tâches libres et inscrit entrée et tâches dans la boîte mobile', async () => {
  const { project, otherProject, first, second } = await fixture();
  const note = await localApi.createEntry({ title: 'Note', project_id: project.id });
  const task = await localApi.createTask({ title: 'À classer', project_id: project.id });
  const explicit = await localApi.createTask({ title: 'Choisie', project_id: project.id, category_id: second.id });
  const foreign = await localApi.createTask({ title: 'Ailleurs', project_id: otherProject.id });
  for (const target of [task, explicit, foreign]) await localApi.linkTaskDocument(target.id, note.id);
  clearLocalOutbox();
  const snapshots: string[][] = [];
  onLocalChange(() => { snapshots.push(JSON.parse(localStorage.getItem('worklogs-outbox')!).tasks as string[]); });
  await localApi.updateEntry(note.id, { category_id: first.id });
  expect(await classification(task.id)).toBe(first.id);
  expect(await classification(explicit.id)).toBe(second.id);
  expect(await classification(foreign.id)).toBeNull();
  const outbox = await exportLocalOutbox();
  expect(outbox.tasks.map((row) => row.id)).toEqual([task.id]);
  expect(outbox.entries.map((row) => row.id)).toEqual([note.id]);
  expect(snapshots).toEqual([[task.id]]);
});

test('PWA : les catégories distinctes de plusieurs entrées restent ambiguës pour une tâche libre', async () => {
  const memory = createMemoryDatabase();
  setLocalDatabase(memory);
  const { project, first, second } = await fixture();
  const a = await localApi.createEntry({ title: 'Note', project_id: project.id, category_id: first.id });
  const b = await localApi.createEntry({ title: 'Note', project_id: project.id, category_id: second.id });
  const task = await localApi.createTask({ title: 'Ambiguë', project_id: project.id });
  await localApi.linkTaskDocument(task.id, a.id);
  const tasks = memory.table<Task>('tasks');
  await tasks.put({ ...(await tasks.get(task.id))!, category_id: null });
  await localApi.linkTaskDocument(task.id, b.id);
  expect(await classification(task.id)).toBeNull();
  await localApi.updateEntry(b.id, { category_id: first.id });
  expect(await classification(task.id)).toBe(first.id);
});

test('PWA : migration initiale unique, non ambiguë et sans notification réentrante ; choix ultérieurs conservés', async () => {
  const memory = createMemoryDatabase();
  setLocalDatabase(memory);
  const { project, otherProject, first, second } = await fixture();
  const a = await localApi.createEntry({ title: 'Note', project_id: project.id, category_id: first.id });
  const b = await localApi.createEntry({ title: 'Note', project_id: project.id, category_id: second.id });
  const unique = await localApi.createTask({ title: 'Unique', project_id: project.id });
  const ambiguous = await localApi.createTask({ title: 'Ambiguë', project_id: project.id });
  const explicit = await localApi.createTask({ title: 'Choisie', project_id: project.id, category_id: second.id });
  const foreign = await localApi.createTask({ title: 'Ailleurs', project_id: otherProject.id });
  for (const target of [unique, ambiguous, explicit, foreign]) await localApi.linkTaskDocument(target.id, a.id);
  await localApi.linkTaskDocument(ambiguous.id, b.id);
  const tasks = memory.table<Task>('tasks');
  for (const target of [unique, ambiguous]) await tasks.put({ ...(await tasks.get(target.id))!, category_id: null });
  clearLocalOutbox();
  localStorage.removeItem(TASK_CATEGORY_MIGRATION);
  const notified = vi.fn();
  onLocalChange(notified);
  setLocalDatabase(memory);
  const state = await localApi.state();
  expect(state.tasks.find((row) => row.id === unique.id)?.category_id).toBe(first.id);
  expect(state.tasks.find((row) => row.id === ambiguous.id)?.category_id).toBeNull();
  expect(state.tasks.find((row) => row.id === explicit.id)?.category_id).toBe(second.id);
  expect(state.tasks.find((row) => row.id === foreign.id)?.category_id).toBeNull();
  expect((await exportLocalOutbox()).tasks.map((row) => row.id)).toEqual([unique.id]);
  expect(notified).not.toHaveBeenCalled();
  await localApi.updateTask(unique.id, { category_id: null });
  setLocalDatabase(memory);
  expect(await classification(unique.id)).toBeNull();
});

test('PWA : un remplissage interrompu garde en outbox les tâches persistées et reprend sans marqueur', async () => {
  const memory = createMemoryDatabase();
  setLocalDatabase(memory);
  const { project, first } = await fixture();
  const note = await localApi.createEntry({ title: 'Note', project_id: project.id, category_id: first.id });
  const firstTask = await localApi.createTask({ title: 'Première', project_id: project.id });
  const secondTask = await localApi.createTask({ title: 'Seconde', project_id: project.id });
  const tasks = memory.table<Task>('tasks');
  for (const task of [firstTask, secondTask]) {
    await localApi.linkTaskDocument(task.id, note.id);
    await tasks.put({ ...(await tasks.get(task.id))!, category_id: null });
  }
  clearLocalOutbox();
  localStorage.removeItem(TASK_CATEGORY_MIGRATION);
  setLocalDatabase(rejectTaskWriteOnce(memory, secondTask.id));
  const notified = vi.fn();
  onLocalChange(notified);
  await expect(localApi.state()).rejects.toThrow('stockage temporairement indisponible');
  expect((await tasks.get(firstTask.id))?.category_id).toBe(first.id);
  expect((await tasks.get(secondTask.id))?.category_id).toBeNull();
  expect(JSON.parse(localStorage.getItem('worklogs-outbox')!).tasks).toEqual([firstTask.id]);
  expect(localStorage.getItem(TASK_CATEGORY_MIGRATION)).toBeNull();
  const resumed = await localApi.state();
  expect(resumed.tasks.filter((task) => [firstTask.id, secondTask.id].includes(task.id)).every((task) => task.category_id === first.id)).toBe(true);
  expect((await exportLocalOutbox()).tasks.map((task) => task.id).sort()).toEqual([firstTask.id, secondTask.id].sort());
  expect(localStorage.getItem(TASK_CATEGORY_MIGRATION)).toBe('1');
  expect(notified).not.toHaveBeenCalled();
});


test('PWA : une liaison persistée avant un héritage refusé reste en outbox et reprend au même appel', async () => {
  const memory = createMemoryDatabase();
  setLocalDatabase(memory);
  const { project, first } = await fixture();
  const note = await localApi.createEntry({ title: 'Note', project_id: project.id, category_id: first.id });
  const task = await localApi.createTask({ title: 'À classer', project_id: project.id });
  clearLocalOutbox();
  setLocalDatabase(rejectTaskWriteOnce(memory, task.id));
  await expect(localApi.linkTaskDocument(task.id, note.id)).rejects.toThrow('stockage temporairement indisponible');
  const interrupted = await exportLocalOutbox();
  expect(interrupted.task_entries.map((link) => [link.task_id, link.entry_id])).toEqual([[task.id, note.id]]);
  expect(await classification(task.id)).toBeNull();
  const persisted = await memory.table<{ id: string; created_at: string }>('task_entries').all();
  expect(persisted).toHaveLength(1);
  await localApi.linkTaskDocument(task.id, note.id);
  expect(await classification(task.id)).toBe(first.id);
  expect((await exportLocalOutbox()).tasks.map((row) => row.id)).toEqual([task.id]);
  expect(await memory.table('task_entries').all()).toEqual(persisted);
});

test('PWA : une entrée persistée reste en outbox après un héritage partiel et reprend le même classement', async () => {
  const memory = createMemoryDatabase();
  setLocalDatabase(memory);
  const { project, first } = await fixture();
  const note = await localApi.createEntry({ title: 'Note', project_id: project.id });
  const firstTask = await localApi.createTask({ title: 'Première', project_id: project.id });
  const secondTask = await localApi.createTask({ title: 'Seconde', project_id: project.id });
  for (const task of [firstTask, secondTask]) await localApi.linkTaskDocument(task.id, note.id);
  clearLocalOutbox();
  setLocalDatabase(rejectTaskWriteOnce(memory, secondTask.id));
  await expect(localApi.updateEntry(note.id, { category_id: first.id })).rejects.toThrow('stockage temporairement indisponible');
  const interrupted = await exportLocalOutbox();
  expect(interrupted.entries.map((row) => row.id)).toEqual([note.id]);
  expect(interrupted.tasks.map((row) => row.id)).toEqual([firstTask.id]);
  expect((await localApi.entry(note.id)).category_id).toBe(first.id);
  expect(await classification(firstTask.id)).toBe(first.id);
  expect(await classification(secondTask.id)).toBeNull();
  await localApi.updateEntry(note.id, { category_id: first.id });
  expect(await classification(secondTask.id)).toBe(first.id);
  expect((await exportLocalOutbox()).tasks.map((row) => row.id).sort()).toEqual([firstTask.id, secondTask.id].sort());
});
