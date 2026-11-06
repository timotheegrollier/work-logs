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
});

describe("repli sans IndexedDB", () => {
  test('le backend IndexedDB rejette proprement quand il est indisponible', async () => {
    if (typeof indexedDB !== 'undefined') return;
    const db = createIndexedDbDatabase();
    await expect(db.table('projects').all()).rejects.toThrow('IndexedDB indisponible');
  });
});
