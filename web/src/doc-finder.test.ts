import { afterEach, describe, expect, test, vi } from 'vitest';
import { AiCancelled } from './ai-suggest';
import { findDocuments, MAX_FOUND, rankFoundDocuments, type FoundDocument } from './doc-finder';
import { api, type AppState, type EntrySummary, type SharedSearch, type SharedSearchResult } from './lib';

const entry = (id: string, title: string, kind: 'note' | 'procedure' = 'note', updated_at = '2026-10-01T00:00:00.000Z'): EntrySummary => ({
  id, title, kind, updated_at, entry_date: updated_at.slice(0, 10), project_id: null, archived: 0, excerpt: '', attachments: 0,
});
const file = (path: string, type: 'file' | 'dir' = 'file'): SharedSearchResult => ({
  path, type, name: path.split('/').pop()!, dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', ext: '',
});
const summary = (documents: FoundDocument[]) => documents.map((document) =>
  `${document.kind} ${document.kind === 'shared' ? document.file.path : document.entry.title} ${document.score} ${document.terms.join('+')}`);
const searched = (results: SharedSearchResult[], extra: Partial<SharedSearch> = {}): SharedSearch =>
  ({ query: '', dir: '', results, partial: false, offline: false, denied: 0, ...extra });

afterEach(() => vi.restoreAllMocks());

describe('classement des documents trouvés', () => {
  test('le premier mot pèse le plus, un mot du titre compte double, les mots trouvés s’additionnent', () => {
    const ranked = rankFoundDocuments(['imprimante', 'pilote'], [
      { entries: [entry('en_titre', 'Installer une Imprimante'), entry('en_texte', 'Compte rendu')], files: [] },
      { entries: [entry('en_texte', 'Compte rendu'), entry('en_pilote', 'Pilote réseau')], files: [file('Imprimantes/Pilote HP.docx'), file('Pilotes', 'dir')] },
    ], new Set());
    expect(summary(ranked)).toEqual([
      'note Installer une Imprimante 4 imprimante',
      'note Compte rendu 3 imprimante+pilote',
      // Un nom du partage compte comme un texte : il passe après le titre d'une note.
      'note Pilote réseau 2 pilote',
      'shared Imprimantes/Pilote HP.docx 1 pilote',
    ]);
  });

  test('un nom du partage compte comme un texte : à mots égaux, la note ou la procédure de WorkLogs passe devant le fichier', () => {
    const ranked = rankFoundDocuments(['toner', 'bureau'], [
      { entries: [entry('en_texte', 'Compte rendu du mardi')], files: [file('Imprimantes/Toner.pdf'), file('Toner bureau.md')] },
      { entries: [entry('en_texte', 'Compte rendu du mardi'), entry('en_proc', 'Accueil', 'procedure')], files: [file('Toner bureau.md'), file('Bureau 2.md')] },
    ], new Set());
    expect(summary(ranked)).toEqual([
      // Trouvés par les mêmes mots : la note d'abord, puis le fichier.
      'note Compte rendu du mardi 3 toner+bureau',
      'shared Toner bureau.md 3 toner+bureau',
      'shared Imprimantes/Toner.pdf 2 toner',
      'procedure Accueil 1 bureau',
      'shared Bureau 2.md 1 bureau',
    ]);
  });

  test('titre comparé sans accents ni casse ; documents liés écartés ; à égalité procédure, note, partage, puis le plus récent ; huit au plus', () => {
    const ranked = rankFoundDocuments(['ecran'], [{
      entries: [
        entry('en_lie', 'Écran du poste 2'),
        entry('en_ancienne', 'ÉCRAN : réglages', 'note', '2026-01-01T00:00:00.000Z'),
        entry('en_recente', 'Écran neuf', 'note', '2026-10-01T00:00:00.000Z'),
        entry('en_proc', 'Changer un écran', 'procedure', '2025-01-01T00:00:00.000Z'),
      ],
      files: [file('Écrans/Ecran Dell.pdf')],
    }], new Set(['en_lie']));
    expect(summary(ranked)).toEqual([
      'procedure Changer un écran 2 ecran',
      'note Écran neuf 2 ecran',
      'note ÉCRAN : réglages 2 ecran',
      'shared Écrans/Ecran Dell.pdf 1 ecran',
    ]);
    const many = Array.from({ length: 12 }, (_, index) => entry(`en_${index}`, `Note ${index}`));
    expect(rankFoundDocuments(['pompe'], [{ entries: many, files: [] }], new Set())).toHaveLength(MAX_FOUND);
  });
});

describe('recherche dans WorkLogs et le partage', () => {
  const stateWith = (entries: EntrySummary[]) => ({ entries } as unknown as AppState);

  test('un partage qui tombe en route garde ce qu’il a trouvé, n’est plus interrogé et le dit', async () => {
    vi.spyOn(api, 'sharedStatus').mockResolvedValue({ available: true, root: '/partage' });
    const state = vi.spyOn(api, 'state').mockImplementation(async (q = '') => stateWith(q === 'toner' ? [entry('en_toner', 'Toner')] : []));
    const search = vi.spyOn(api, 'searchShared')
      .mockResolvedValueOnce(searched([file('Imprimante.md')]))
      .mockRejectedValueOnce(new Error('Partage injoignable'));
    const found = await findDocuments(['imprimante', 'pilote', 'toner'], new Set());
    expect(summary(found.documents)).toEqual(['shared Imprimante.md 3 imprimante', 'note Toner 2 toner']);
    expect(found.sharedNote).toBe('Partage : recherche partielle.');
    expect(state.mock.calls).toEqual([['imprimante', ''], ['pilote', ''], ['toner', '']]);
    expect(search).toHaveBeenCalledTimes(2);
  });

  test('partage non réglé ou relais injoignable : WorkLogs seul, sans appel au partage ; hors ligne : les dernières listes', async () => {
    vi.spyOn(api, 'state').mockResolvedValue(stateWith([]));
    const search = vi.spyOn(api, 'searchShared').mockResolvedValue(searched([], { partial: true, offline: true }));
    const status = vi.spyOn(api, 'sharedStatus');
    for (const unusable of [{ available: false }, { available: true, root: null }, { available: true, root: 'https://relais', relayError: 'Failed to fetch' }]) {
      status.mockResolvedValueOnce(unusable);
      expect((await findDocuments(['pompe'], new Set())).sharedNote).toBe('Dossier partagé indisponible : recherche dans WorkLogs seulement.');
    }
    expect(search).not.toHaveBeenCalled();
    status.mockResolvedValueOnce({ available: true, root: '/partage', reach: 'offline' });
    expect((await findDocuments(['pompe'], new Set())).sharedNote).toBe('Partage hors ligne : dernières listes vues.');
  });

  test('Arrêter : aucun mot suivant n’est cherché', async () => {
    vi.spyOn(api, 'sharedStatus').mockResolvedValue({ available: true, root: '/partage' });
    const stop = new AbortController();
    const state = vi.spyOn(api, 'state').mockImplementation(async () => {
      stop.abort();
      return stateWith([]);
    });
    const search = vi.spyOn(api, 'searchShared').mockResolvedValue(searched([]));
    await expect(findDocuments(['pompe', 'joint'], new Set(), stop.signal)).rejects.toBeInstanceOf(AiCancelled);
    expect(state.mock.calls).toEqual([['pompe', '']]);
    expect(search).toHaveBeenCalledOnce();
  });

  test('au-delà de 10 s, le partage n’est plus interrogé : WorkLogs continue et le dit', async () => {
    vi.spyOn(api, 'sharedStatus').mockResolvedValue({ available: true, root: '/partage' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.spyOn(api, 'state').mockImplementation(async (q = '') => stateWith(q === 'toner' ? [entry('en_toner', 'Toner')] : []));
    const search = vi.spyOn(api, 'searchShared').mockImplementation(async (term) => {
      clock.mockReturnValue(term === 'pilote' ? 11_000 : 11_001);
      return searched([file(`${term}.md`)]);
    });
    // Tout juste 10 s : le deuxième mot passe encore.
    const found = await findDocuments(['pilote', 'bureau', 'toner'], new Set());
    expect(search.mock.calls.map(([term]) => term)).toEqual(['pilote', 'bureau']);
    expect(summary(found.documents)).toEqual(['shared pilote.md 3 pilote', 'note Toner 2 toner', 'shared bureau.md 2 bureau']);
    expect(found.sharedNote).toBe('Partage : recherche partielle.');
  });
});
