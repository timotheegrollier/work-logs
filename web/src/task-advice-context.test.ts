import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, type Entry, type EntrySummary, type Task } from './lib';
import { prepareTaskAdvice } from './task-advice-context';

const summary = (id: string, extra: Partial<EntrySummary> = {}): EntrySummary => ({
  id, title: `Note ${id}`, entry_date: '2026-10-30', project_id: 'p', archived: 0,
  kind: 'note', updated_at: '2026-10-30', excerpt: '', attachments: 0, ...extra,
});
const task = (id: string, documents: EntrySummary[] = []): Task => ({
  id, title: `Tâche ${id}`, status: 'todo', priority: 'normal', due_date: null, pinned: 0,
  position: 0, project_id: 'p', created_at: '2026-10-01', updated_at: '2026-10-30', documents,
});
const entry = (id: string): Entry => ({
  id, title: `Note ${id}`, content_md: `Contexte ${id} ${'x'.repeat(700)}`, entry_date: '2026-10-30',
  project_id: 'p', archived: 0, kind: 'note', created_at: '2026-10-01', updated_at: '2026-10-30', attachments: [],
});
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('préparation des conseils IA', () => {
  test('lit les seuls documents locaux liés, les déduplique et annonce les sources ignorées', async () => {
    const read = vi.spyOn(api, 'entry').mockImplementation(async (id) => entry(id));
    const docs = [summary('a'), summary('b'), summary('google', { google_document_id: 'g' }), summary('c'), summary('d')];
    const prepared = await prepareTaskAdvice([task('1', docs), task('2', [summary('a')])], []);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).not.toHaveBeenCalledWith('google');
    expect(prepared.sources.map((source) => source.id)).toEqual(['a', 'b', 'c']);
    expect(prepared.tasks[1].sources.map((source) => source.id)).toEqual(['a']);
    expect(prepared.sources[0].text.length).toBe(600);
    expect(prepared.omitted).toBe(2);
  });

  test('borne le nombre total de documents et annonce ceux qui restent hors contexte', async () => {
    const read = vi.spyOn(api, 'entry').mockImplementation(async (id) => entry(id));
    const tasks = Array.from({ length: 14 }, (_, index) => task(String(index),
      [0, 1, 2].map((offset) => summary(`s${index * 3 + offset}`))));
    const prepared = await prepareTaskAdvice(tasks, []);
    expect(read).toHaveBeenCalledTimes(40);
    expect(prepared.sources).toHaveLength(40);
    expect(prepared.omitted).toBe(2);
  });

  test('une annulation pendant la lecture ne prépare pas de requête', async () => {
    const controller = new AbortController();
    vi.spyOn(api, 'entry').mockImplementation(async (id) => { controller.abort(); return entry(id); });
    await expect(prepareTaskAdvice([task('1', [summary('a')])], [], controller.signal)).rejects.toThrow(/arrêtée/);
  });

  test('plus de 60 tâches ou une source devenue Google sont refusées avant tout envoi IA', async () => {
    const read = vi.spyOn(api, 'entry').mockImplementation(async (id) => ({ ...entry(id), google_sync: { document_id: 'g', dirty: false, synced_at: null } }));
    await expect(prepareTaskAdvice(Array.from({ length: 61 }, (_, index) => task(String(index))), [])).rejects.toThrow(/61, 60 au plus/);
    expect(read).not.toHaveBeenCalled();
    await expect(prepareTaskAdvice([task('1', [summary('a')])], [])).rejects.toThrow(/Impossible de lire/);
  });
});
