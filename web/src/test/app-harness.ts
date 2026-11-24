import { afterEach, beforeEach, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { useRealApi } from './server';
import { discardPendingSaves, flushPendingSaves } from '../autosave';
import { resetAiFallbackMemory, saveGoogleAiConsent } from '../ai-suggest';

// Socle commun des fichiers `App*.test.tsx` : découpés pour que vitest les répartisse sur ses
// workers (un seul fichier de 312 tests prenait 4 min sur un worker, les autres à l’arrêt).

export let api: Awaited<ReturnType<typeof useRealApi>>;
/** Relance la vraie API, sur une base neuve (et un partage s’il est donné) ; l’ancienne est déjà fermée. */
export async function reopenApi(options?: Parameters<typeof useRealApi>[0]) {
  api = await useRealApi(options);
  return api;
}

/** Vraie API sur une base jetable, IA non simulée refusée, confirmations acceptées. */
export function useAppHarness() {
  beforeEach(async () => {
    api = await useRealApi();
    localStorage.clear();
    resetAiFallbackMemory();
    const diverted = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/chat/completions')) throw new Error('Ce test doit simuler la réponse IA.');
      return diverted(input, init);
    });
    saveGoogleAiConsent(true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  // Un brouillon en échec fait lever `flushPendingSaves` : le test reste rouge avec ce
  // message, mais le reste est rangé et le brouillon oublié, sans quoi il se rejouerait
  // sur le serveur du test suivant (« entrée introuvable »).
  afterEach(async () => {
    try {
      await flushPendingSaves();
    } finally {
      discardPendingSaves();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await api.close();
    }
  });
}

export const journal = () => screen.getByRole('region', { name: 'Journal' });
export const board = () => screen.getByRole('region', { name: 'Tâches' });
export const editor = () => screen.getByRole('region', { name: 'Entrée' });
export const filters = () => screen.getByRole('group', { name: 'Filtrer par projet' });
/** Ouvre le menu « ✨ IA » (celui de l'entrée par défaut) et rend l'action demandée. */
export async function aiAction(name: string, scope: HTMLElement = document.body, menu = 'Assistance IA') {
  const trigger = await within(scope).findByRole('button', { name: menu });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return within(scope).findByRole('menuitem', { name });
}
export const row = (db: typeof api.db, sql: string, ...args: unknown[]) =>
  db.prepare(sql).get(...args) as Record<string, unknown>;

export function seedGoogleLink(db: typeof api.db, entryId: string, documentId: string) {
  const rich = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Google' }] }] });
  db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(rich, entryId);
  db.prepare(`INSERT INTO google_documents (entry_id,document_id,tab_id,revision_id,synced_content_json,document_title,tab_title,tab_order,tab_depth)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(entryId, documentId, 'tab-0', 'r1', rich, 'Document Google', 'Onglet', 0, 0);
}

// Le fetch détourné vers l'API locale ne voit que le relatif : l'URL absolue
// du service IA reste mockable sans toucher au backend réel.
export const aiBodies: unknown[] = [];
export function mockAiSuggest(content: string) {
  aiBodies.length = 0;
  const diverted = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('chat/completions')) {
      if (init?.body) aiBodies.push(JSON.parse(init.body as string));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
    }
    return diverted(input, init);
  }));
}

/** Les largeurs au pixel près vivent dans Paramètres › Affichage. */
export async function openDisplaySettings() {
  fireEvent.click(await screen.findByRole('button', { name: 'Compte et paramètres' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
  return within(await screen.findByRole('region', { name: 'Affichage' }));
}

/** La gestion des projets s'ouvre par-dessus le bandeau, depuis son bouton. */
export async function openProjects() {
  // L'état chargé (les statistiques de l'en-tête en dépendent) : la liste est complète.
  await screen.findByText(/cette semaine/);
  fireEvent.click(screen.getByRole('button', { name: 'Gérer les projets' }));
  return within(await screen.findByRole('dialog', { name: /^Projets/ }));
}
