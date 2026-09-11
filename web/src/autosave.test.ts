import { expect, test } from 'vitest';
import { Autosave, flushPendingSaves, hasPendingSaves } from './autosave';

test('fermer avant le délai enregistre le dernier brouillon', async () => {
  const saved: string[] = [];
  const queue = new Autosave<string>(async (value) => { saved.push(value); });
  queue.update('première frappe');
  queue.update('dernière frappe');
  expect(hasPendingSaves()).toBe(true);
  await flushPendingSaves();
  expect(saved).toEqual(['dernière frappe']);
  expect(hasPendingSaves()).toBe(false);
});

test('une frappe pendant la requête est enregistrée ensuite, dans l’ordre', async () => {
  const saved: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queue = new Autosave<string>(async (value) => { await gate; saved.push(value); });
  queue.update('A');
  const flush = queue.flush();
  queue.update('B');
  expect(queue.flush()).toBe(flush);
  release();
  await flush;
  expect(saved).toEqual(['A', 'B']);
  expect(hasPendingSaves()).toBe(false);
});

test('un échec empêche la fermeture et permet de réessayer', async () => {
  let fails = true;
  const queue = new Autosave<string>(async () => { if (fails) throw new Error('Disque indisponible'); });
  queue.update('à conserver');
  await expect(flushPendingSaves()).rejects.toThrow('Disque indisponible');
  expect(hasPendingSaves()).toBe(true);
  fails = false;
  await flushPendingSaves();
  expect(hasPendingSaves()).toBe(false);
});
