import { describe, expect, test } from 'vitest';
import { createIndexedDbDatabase, createMemoryDatabase } from './storage';

describe('base mémoire', () => {
  test('put/get/all/remove/clear isolent les lignes', async () => {
    const db = createMemoryDatabase();
    const projects = db.table<{ id: string; name: string }>('projects');
    await projects.put({ id: 'pr_1', name: 'Perso' });
    await projects.put({ id: 'pr_2', name: 'Pro' });
    expect(await projects.get('pr_1')).toEqual({ id: 'pr_1', name: 'Perso' });
    expect((await projects.all()).map((p) => p.id).sort()).toEqual(['pr_1', 'pr_2']);
    await projects.remove('pr_1');
    expect(await projects.get('pr_1')).toBeUndefined();
    await projects.clear();
    expect(await projects.all()).toEqual([]);
  });

  test('les tables sont indépendantes et typées par le schéma', async () => {
    const db = createMemoryDatabase();
    expect(() => db.table('inconnue')).toThrow('Table inconnue');
    await expect(db.table('projects').put({ name: 'sans clé' })).rejects.toThrow('Clé manquante');
  });

  test('put recopie : muter l’objet d’origine ne change pas la base', async () => {
    const db = createMemoryDatabase();
    const row = { id: 'pr_1', name: 'Perso' };
    await db.table('projects').put(row);
    row.name = 'Modifié';
    expect((await db.table<{ id: string; name: string }>('projects').get('pr_1'))?.name).toBe('Perso');
  });

  test('les insertions sur plusieurs tables sont atomiques', async () => {
    const db = createMemoryDatabase();
    const rows = [
      { table: 'tasks', value: { id: 'tk_1' } },
      { table: 'entries', value: { id: 'en_1' } },
      { table: 'task_entries', value: { id: 'tk_1\0en_1' } },
    ];
    await db.table('task_entries').put(rows[2].value);
    await expect(db.addAll(rows)).rejects.toThrow('Clé déjà présente');
    expect(await db.table('tasks').all()).toEqual([]);
    expect(await db.table('entries').all()).toEqual([]);
    await db.table('task_entries').clear();
    await db.addAll(rows);
    for (const { table, value } of rows) expect(await db.table(table).all()).toEqual([value]);
  });

  test('une mise à jour liée est annulée si une écriture du lot échoue', async () => {
    const db = createMemoryDatabase();
    const entries = db.table<{ id: string; status: string }>('entries');
    await entries.put({ id: 'en_1', status: 'todo' });
    await expect(db.writeAll([
      { table: 'entries', value: { id: 'en_1', status: 'doing' } },
      { table: 'task_entries', key: 'association', operation: 'delete' },
      { table: 'tasks', value: { progress: 20 }, operation: 'add' },
    ])).rejects.toThrow('Clé manquante');
    expect(await entries.get('en_1')).toEqual({ id: 'en_1', status: 'todo' });
    expect(await db.table('tasks').all()).toEqual([]);
  });
});

describe("repli sans IndexedDB", () => {
  test('le backend IndexedDB rejette proprement quand il est indisponible', async () => {
    if (typeof indexedDB !== 'undefined') return;
    const db = createIndexedDbDatabase();
    await expect(db.table('projects').all()).rejects.toThrow('IndexedDB indisponible');
  });
});
