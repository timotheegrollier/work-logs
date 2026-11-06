import { beforeEach, expect, test } from 'vitest';
import { applySyncSnapshot, clearLocalOutbox, exportLocalOutbox, importLocalBackup, localApi, localSyncSnapshot, readLocalTombstones, setLocalDatabase } from './localApi';
import { createMemoryDatabase } from './storage';
// @ts-expect-error — validation pure partagée avec l’API.
import { validateBackup, validateOutbox } from '../../../api/src/backup-format.js';

beforeEach(() => { localStorage.clear(); setLocalDatabase(createMemoryDatabase()); });
async function tree() {
  const project = await localApi.createProject({ name: 'Chantier' });
  const root = await localApi.createCategory({ name: 'Travaux', project_id: project.id });
  const child = await localApi.createCategory({ name: 'Toiture', project_id: project.id, parent_id: root.id, color: '#123456' });
  return { project, root, child };
}

test('PWA : classement, descendants, recherche, compteurs et héritage des documents/tâches', async () => {
  const { project, root, child } = await tree();
  const note = await localApi.createEntry({ title: 'Devis', project_id: project.id, category_id: child.id });
  const task = await localApi.createTaskFromEntry(note.id);
  expect(task.category_id).toBe(child.id);
  expect((await localApi.createEntryFromTask(task.id)).category_id).toBe(child.id);
  expect((await localApi.copyEntry(note.id)).category_id).toBe(child.id);
  const filtered = await localApi.state('Devis', project.id, root.id);
  expect(filtered.entries).toHaveLength(3);
  expect(filtered.tasks.map((row) => row.id)).toEqual([task.id]);
  expect(filtered.categories?.find((row) => row.id === child.id)).toMatchObject({ entries: 3, open_tasks: 1 });
  expect((await localApi.state('', project.id, '__none__')).entries).toEqual([]);
  await localApi.updateEntry(note.id, { category_id: null });
  expect((await localApi.state('', project.id, '__none__')).entries.map((row) => row.id)).toEqual([note.id]);
  expect((await localApi.updateTask(task.id, { project_id: null })).category_id).toBeNull();
});

test('PWA : cycles et catégories de projet différent refusés, reparentage et suppression sans perte', async () => {
  const { project, root, child } = await tree();
  await expect(localApi.updateCategory(root.id, { parent_id: child.id })).rejects.toThrow('sous-catégorie');
  await expect(localApi.createCategory({ name: '', project_id: project.id })).rejects.toThrow('nom de catégorie');
  await expect(localApi.createCategory({ name: 'X', project_id: project.id, color: 'red' })).rejects.toThrow('couleur');
  await expect(localApi.createEntry({ title: 'X', category_id: root.id })).rejects.toThrow('même projet');
  const grandchild = await localApi.createCategory({ name: 'Isolation', project_id: project.id, parent_id: child.id });
  const note = await localApi.createEntry({ title: 'Devis', project_id: project.id, category_id: child.id });
  const task = await localApi.createTask({ title: 'Relire', project_id: project.id, category_id: child.id });
  await localApi.updateCategory(child.id, { name: 'Couverture', color: '#abcdef' });
  await localApi.deleteCategory(child.id);
  const state = await localApi.state();
  expect(state.categories?.find((row) => row.id === grandchild.id)?.parent_id).toBe(root.id);
  expect((await localApi.entry(note.id)).category_id).toBe(root.id);
  expect(state.tasks.find((row) => row.id === task.id)?.category_id).toBe(root.id);
  expect(readLocalTombstones()).toContainEqual(expect.objectContaining({ kind: 'category', id: child.id }));
  await localApi.deleteProject(project.id);
  expect((await localApi.entry(note.id))).toMatchObject({ project_id: null, category_id: null });
  expect((await localApi.state()).categories).toEqual([]);
});

test('PWA : sauvegarde, restauration et boîte mobile gardent catégories, parents et affectations', async () => {
  const { project, root, child } = await tree();
  clearLocalOutbox();
  const note = await localApi.createEntry({ title: 'Devis', project_id: project.id, category_id: child.id });
  const box = await exportLocalOutbox();
  expect(box.categories?.map((row) => row.id).sort()).toEqual([root.id, child.id].sort());
  expect(box.projects.map((row) => row.id)).toEqual([project.id]);
  validateOutbox(box);
  const saved = await localSyncSnapshot();
  validateBackup({ version: 2, ...saved });
  await localApi.deleteCategory(child.id);
  await importLocalBackup({ version: 2, ...saved });
  expect((await localApi.entry(note.id)).category_id).toBe(child.id);
  expect((await localApi.state()).categories?.find((row) => row.id === child.id)?.parent_id).toBe(root.id);
});

test('PWA : déplacement pendant la synchro relance une fusion avant de pouvoir former un cycle', async () => {
  const { project, root } = await tree();
  const other = await localApi.createCategory({ name: 'Autre', project_id: project.id });
  const base = await localSyncSnapshot();
  const merged = structuredClone(base);
  merged.categories!.find((row) => row.id === other.id)!.parent_id = root.id;
  await localApi.updateCategory(root.id, { parent_id: other.id });
  expect(await applySyncSnapshot(merged, base)).toEqual({ changed: 0, skipped: 1 });
  expect((await localSyncSnapshot()).categories?.find((row) => row.id === other.id)?.parent_id).toBeNull();
});

test('PWA : un classement pendant la synchro empêche de supprimer sa catégorie sur une base périmée', async () => {
  const { project, root } = await tree();
  const note = await localApi.createEntry({ title: 'À classer', project_id: project.id });
  const base = await localSyncSnapshot();
  const merged = structuredClone(base);
  merged.categories = [];
  await localApi.updateEntry(note.id, { category_id: root.id });
  expect(await applySyncSnapshot(merged, base)).toEqual({ changed: 0, skipped: 1 });
  validateBackup({ version: 2, ...await localSyncSnapshot() });
});

test('PWA : un classement attend la fin des écritures de synchro puis valide la catégorie restante', async () => {
  const memory = createMemoryDatabase();
  let pause = false;
  let release!: () => void;
  let removed!: () => void;
  const waiting = new Promise<void>((resolve) => { removed = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setLocalDatabase({
    table<T extends object>(name: string) {
      const table = memory.table<T>(name);
      return {
        ...table,
        remove: async (id: string) => {
          if (name === 'categories' && pause) { removed(); await gate; }
          await table.remove(id);
        },
      };
    },
  });
  const { project, root } = await tree();
  const note = await localApi.createEntry({ title: 'À classer', project_id: project.id });
  const base = await localSyncSnapshot();
  const merged = structuredClone(base);
  merged.categories = [];
  pause = true;
  const applying = applySyncSnapshot(merged, base);
  await waiting;
  let settled = false;
  const editing = localApi.updateEntry(note.id, { category_id: root.id }).finally(() => { settled = true; });
  // Two microtasks are enough to run a call that was not serialized.
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await applying;
  await expect(editing).rejects.toThrow('catégorie introuvable');
  validateBackup({ version: 2, ...await localSyncSnapshot() });
  expect((await localApi.entry(note.id)).category_id).toBeNull();
});

test('PWA : supprimer un projet vide pendant la lecture Drive empêche une catégorie distante orpheline', async () => {
  const project = await localApi.createProject({ name: 'Projet vide' });
  const base = await localSyncSnapshot();
  const merged = structuredClone(base);
  const time = new Date().toISOString();
  merged.categories = [{ id: 'ca_remote', name: 'Distante', project_id: project.id, parent_id: null, color: '#64748b', created_at: time, updated_at: time }];
  await localApi.deleteProject(project.id);
  expect(await applySyncSnapshot(merged, base)).toEqual({ changed: 0, skipped: 1 });
  const snapshot = await localSyncSnapshot();
  expect(snapshot.categories).toEqual([]);
  validateBackup({ version: 2, ...snapshot });
});
