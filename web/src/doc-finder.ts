import { api, type EntrySummary, type SharedSearchResult } from './lib';

/** Une note ou une procédure de WorkLogs, ou un fichier du partage, avec les mots qui l'ont trouvé. */
export type FoundDocument = { terms: string[]; score: number } & (
  | { kind: EntrySummary['kind']; entry: EntrySummary }
  | { kind: 'shared'; file: SharedSearchResult }
);

/** Ce qu'un mot a trouvé : des entrées de WorkLogs, des noms du partage. */
export interface TermHits {
  entries: EntrySummary[];
  files: SharedSearchResult[];
}

export const MAX_FOUND = 8;
/** À score égal : la procédure explique, la note raconte, le fichier du partage n'est trouvé que par son nom. */
const KIND_ORDER = { procedure: 0, note: 1, shared: 2 };
const UNAVAILABLE = 'Dossier partagé indisponible : recherche dans WorkLogs seulement.';
const PARTIAL = 'Partage : recherche partielle.';

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Chaque mot rapporte d'autant plus qu'il est haut dans la liste de l'IA, le
 * double s'il est dans le titre (le partage ne cherche que dans les noms, donc
 * toujours). Documents déjà liés et dossiers écartés ; à égalité, le plus récent.
 */
export function rankFoundDocuments(terms: string[], hits: TermHits[], excludedIds: ReadonlySet<string>): FoundDocument[] {
  const found = new Map<string, FoundDocument>();
  const add = (key: string, fresh: FoundDocument, term: string, points: number) => {
    const document = found.get(key) ?? fresh;
    document.terms.push(term);
    document.score += points;
    found.set(key, document);
  };
  hits.forEach(({ entries, files }, rank) => {
    const term = terms[rank];
    const weight = terms.length - rank;
    for (const entry of entries) {
      if (excludedIds.has(entry.id)) continue;
      add(entry.id, { kind: entry.kind, entry, terms: [], score: 0 }, term, fold(entry.title).includes(fold(term)) ? 2 * weight : weight);
    }
    for (const file of files) {
      if (file.type === 'file') add('partage:' + file.path, { kind: 'shared', file, terms: [], score: 0 }, term, 2 * weight);
    }
  });
  const date = (document: FoundDocument) => (document.kind === 'shared' ? '' : document.entry.updated_at);
  const name = (document: FoundDocument) => (document.kind === 'shared' ? document.file.path : document.entry.title);
  return [...found.values()]
    .sort((a, b) => b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      || date(b).localeCompare(date(a)) || name(a).localeCompare(name(b)))
    .slice(0, MAX_FOUND);
}

/**
 * Un mot après l'autre : WorkLogs (titres et textes, tous projets, archives
 * comprises) et, s'il répond, le partage (noms de fichiers). Un partage qui
 * tombe en route garde ce qu'il a trouvé et le dit ; WorkLogs ne l'attend pas.
 */
export async function findDocuments(terms: string[], excludedIds: ReadonlySet<string>): Promise<{ documents: FoundDocument[]; sharedNote: string }> {
  const status = await api.sharedStatus().catch(() => null);
  // Relais injoignable (PWA) : chaque recherche attendrait son délai pour rien.
  let usable = Boolean(status?.available && status.root && !status.relayError);
  let sharedNote = usable ? '' : UNAVAILABLE;
  const hits: TermHits[] = [];
  for (const term of terms) {
    const [state, search] = await Promise.all([api.state(term, ''), usable ? api.searchShared(term).catch(() => null) : null]);
    if (usable && !search) {
      usable = false;
      sharedNote ||= hits.length > 0 ? PARTIAL : UNAVAILABLE;
    }
    if (search?.offline) sharedNote = 'Partage hors ligne : dernières listes vues.';
    else if (search?.partial) sharedNote ||= PARTIAL;
    hits.push({ entries: state.entries, files: search?.results ?? [] });
  }
  return { documents: rankFoundDocuments(terms, hits, excludedIds), sharedNote };
}
