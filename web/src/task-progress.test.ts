import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { pacificDay } from './ai-budget';
import { checklistProgress } from './markdown';
import { autoTaskState, refreshTaskProgress } from './task-progress';

const response = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }) as Response;
const note = 'Pompe démontée et joint commandé. Reste à remonter la pompe puis à tester le circuit.';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
  localStorage.setItem('worklogs-ai-model', 'test');
  localStorage.setItem('worklogs-ai-key', 'cle-test');
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('avancement d’une tâche d’après sa note', () => {
  test('les cases cochées donnent l’avancement, sans case il n’y en a pas', () => {
    expect(checklistProgress('- [x] Démonter\n- [ ] Remonter\n* [X] Commander')).toBe(67);
    expect(checklistProgress('Texte libre sans case')).toBeNull();
  });

  test('un avancement automatique ne termine jamais la tâche et laisse une tâche terminée', () => {
    expect(autoTaskState({ status: 'doing', progress: 40 }, 100)).toEqual({ status: 'doing', progress: 99 });
    expect(autoTaskState({ status: 'todo', progress: 0 }, 30)).toEqual({ status: 'doing', progress: 30 });
    expect(autoTaskState({ status: 'doing', progress: 50 }, 0)).toEqual({ status: 'doing', progress: 0 });
    expect(autoTaskState({ status: 'doing', progress: 30 }, 30)).toBeNull();
    expect(autoTaskState({ status: 'done', progress: 100 }, 20)).toBeNull();
  });

  test('une liste de cases règle l’avancement sans appeler l’IA, une seule fois par texte', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const task = { id: 'tk_1', status: 'todo' as const, progress: 0 };
    await expect(refreshTaskProgress(task, 'Pompe', '- [x] Démonter\n- [ ] Remonter')).resolves.toEqual({ status: 'doing', progress: 50 });
    await expect(refreshTaskProgress(task, 'Pompe', '- [x] Démonter\n- [ ] Remonter')).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('sans case, l’IA estime en appel de fond court, et pas deux fois le même texte', async () => {
    const fetch = vi.fn(async () => response('{"progress": 40}')); vi.stubGlobal('fetch', fetch);
    const task = { id: 'tk_2', status: 'doing' as const, progress: 10 };
    await expect(refreshTaskProgress(task, 'Réparer la pompe', note)).resolves.toEqual({ status: 'doing', progress: 40 });
    await expect(refreshTaskProgress({ ...task, progress: 40 }, 'Réparer la pompe', note)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.max_tokens).toBeLessThanOrEqual(256);
    expect(JSON.stringify(body.messages)).toContain('Réparer la pompe');
    expect(JSON.parse(localStorage.getItem('worklogs-ai-usage') ?? '{}')).toMatchObject({ requests: 1, background: 1 });
  });

  test('l’IA qui ne peut pas juger, un texte trop court, une IA absente ou le quota de fond épuisé ne changent rien', async () => {
    const fetch = vi.fn(async () => response('{"progress": null}')); vi.stubGlobal('fetch', fetch);
    await expect(refreshTaskProgress({ id: 'tk_3', status: 'doing', progress: 20 }, 'Pompe', note)).resolves.toBeNull();
    await expect(refreshTaskProgress({ id: 'tk_4', status: 'doing', progress: 20 }, 'Pompe', 'À voir.')).resolves.toBeNull();
    // Le tiers du plafond réservé au fond (150 / 3) est épuisé : l'estimation attend demain.
    localStorage.setItem('worklogs-ai-usage', JSON.stringify({ day: pacificDay(), requests: 50, tokens: 0, background: 50 }));
    await expect(refreshTaskProgress({ id: 'tk_5', status: 'doing', progress: 20 }, 'Pompe', note)).resolves.toBeNull();
    localStorage.removeItem('worklogs-ai-key');
    await expect(refreshTaskProgress({ id: 'tk_6', status: 'doing', progress: 20 }, 'Pompe', `${note} Autre texte.`)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
