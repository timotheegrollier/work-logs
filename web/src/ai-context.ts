import { api, type EntrySummary } from './lib';
import { compactTitles, recurringVocabulary, type AiWorkContext } from './ai-suggest';
import { richToMarkdown } from './rich-markdown';

const PROJECT_CONTEXTS_KEY = 'worklogs-ai-project-contexts';
const MAX_PROJECT_BRIEF = 2000;
const MAX_SOURCES = 3;
const MAX_SOURCE_TEXT = 2000;
const STOPWORDS = new Set(
  'le la les de des du un une et est en dans pour avec sur par au aux ce cette ces ses son ton ta tes mes que qui quoi dont ou comme tout tous toute toutes plus moins aussi bien faire fait font etre ete avoir leur leurs notre nos votre vos mais donc car ni si elle il ils elles nous vous je tu on ne pas encore entre vers chez sans sous apres avant pendant depuis contre autre autres tel telle tels telles cela ceci note notes procedure procedures creer nouvelle nouveau mettre jour'.split(' ')
);

function projectBriefs(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROJECT_CONTEXTS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Fiche facultative, locale à cet appareil, séparée du profil métier général. */
export function readProjectAiBrief(projectId: string | null): string {
  const value = projectBriefs()[projectId ?? ''];
  return typeof value === 'string' ? value.trim().slice(0, MAX_PROJECT_BRIEF) : '';
}

export function saveProjectAiBrief(projectId: string | null, brief: string): void {
  const briefs: Record<string, unknown> = Object.assign(Object.create(null), projectBriefs());
  const key = projectId ?? '';
  const value = brief.trim().slice(0, MAX_PROJECT_BRIEF);
  if (value) briefs[key] = value;
  else delete briefs[key];
  try {
    localStorage.setItem(PROJECT_CONTEXTS_KEY, JSON.stringify(briefs));
  } catch {
    // Comme les autres réglages : l'absence de stockage ne bloque pas la saisie.
  }
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map((word) => word.replace(/s$/, '')));
}

function matches(text: string, keywords: Set<string>): number {
  const tokens = words(text);
  return [...keywords].filter((word) => tokens.has(word)).length;
}

/**
 * Garde les paragraphes les plus proches du sujet, même en fin de document.
 * Un paragraphe très long est fenêtré autour du premier mot pertinent.
 */
function relevantExcerpt(text: string, keywords: Set<string>): string {
  const paragraphs = text.trim().split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const ranked = paragraphs.map((paragraph, index) => ({ paragraph, index, score: matches(paragraph, keywords) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: { text: string; index: number }[] = [];
  let remaining = MAX_SOURCE_TEXT;
  for (const item of ranked) {
    const separator = chosen.length ? 2 : 0;
    const available = remaining - separator;
    if (available < 80) break;
    let excerpt = item.paragraph;
    if (excerpt.length > available) {
      const folded = excerpt.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
      const positions = [...keywords].map((word) => folded.indexOf(word)).filter((position) => position >= 0);
      const match = positions.length ? Math.min(...positions) : 0;
      const start = Math.max(0, Math.min(match - 180, excerpt.length - available + 2));
      const prefix = start > 0 ? '…' : '';
      excerpt = prefix + excerpt.slice(start, start + available - prefix.length - 1) + '…';
    }
    chosen.push({ text: excerpt, index: item.index });
    remaining -= excerpt.length + separator;
  }
  return chosen.sort((a, b) => a.index - b.index).map((item) => item.text).join('\n\n');
}

export interface LoadAiContextOptions {
  projectId: string | null;
  title: string;
  entryId?: string;
  taskId?: string;
  linkedDocumentIds?: string[];
}

/**
 * Lecture explicite de documents locaux du même projet. Les métadonnées Google
 * sont éliminées avant toute lecture, y compris lorsqu'une copie est en cache.
 * Ce module n'appelle jamais le fournisseur IA et ne lit aucune pièce jointe.
 */
export async function loadAiContext(options: LoadAiContextOptions): Promise<AiWorkContext> {
  let state;
  try {
    // L'API ne possède pas de filtre « sans projet » : on filtre aussi localement.
    state = await api.state('', options.projectId ?? '');
  } catch {
    throw new Error('Impossible de charger le contexte IA du projet. Réessaie avant de lancer l’assistance.');
  }
  const projectTasks = state.tasks.filter((task) => task.project_id === options.projectId);
  const currentTask = projectTasks.find((task) => task.id === options.taskId);
  const linkedIds = new Set([
    ...(options.linkedDocumentIds ?? []),
    ...(currentTask?.documents ?? []).map((document) => document.id),
  ]);
  const byId = new Map<string, EntrySummary>();
  for (const summary of [...(currentTask?.documents ?? []), ...state.entries]) byId.set(summary.id, summary);
  const eligible = [...byId.values()].filter((summary) =>
    summary.project_id === options.projectId && summary.id !== options.entryId && !summary.archived
    && !summary.google_document_id && !summary.google_tab_id);
  const keywords = words(options.title);
  const candidates = eligible.map((summary) => ({
    summary,
    linked: linkedIds.has(summary.id),
    score: 3 * matches(summary.title, keywords) + matches(summary.excerpt || '', keywords),
  })).filter((item) => item.linked || item.score > 0)
    .sort((a, b) => Number(b.linked) - Number(a.linked)
      || b.score - a.score
      || Number(b.summary.kind === 'procedure') - Number(a.summary.kind === 'procedure')
      || b.summary.updated_at.localeCompare(a.summary.updated_at)
      || a.summary.id.localeCompare(b.summary.id))
    .slice(0, MAX_SOURCES);
  const sources = await Promise.all(candidates.map(async ({ summary }) => {
    try {
      const entry = await api.entry(summary.id);
      if (entry.project_id !== options.projectId || entry.google_sync) {
        throw new Error('source déplacée ou liée à Google');
      }
      const text = entry.content_json ? richToMarkdown(entry.content_json) : entry.content_md;
      return { id: entry.id, title: entry.title, kind: entry.kind, text: relevantExcerpt(text, keywords) };
    } catch {
      throw new Error(`Impossible de lire « ${summary.title} » pour le contexte IA. Réessaie avant de lancer l’assistance.`);
    }
  }));
  const openTasks = projectTasks.filter((task) => task.id !== options.taskId && task.status !== 'done');
  return {
    project: state.projects.find((project) => project.id === options.projectId)?.name,
    projectBrief: readProjectAiBrief(options.projectId),
    sources,
    relatedTasks: compactTitles(openTasks.map((task) => task.title)),
    recentNotes: compactTitles(sources.filter((source) => source.kind === 'note').map((source) => source.title)),
    vocabulary: recurringVocabulary([...projectTasks.map((task) => task.title), ...eligible.map((entry) => entry.title)]),
  };
}

/** Une exclusion retire également le titre de la note des indications annexes. */
export function selectedAiContext(context: AiWorkContext, excludedIds: string[]): AiWorkContext {
  const excluded = new Set(excludedIds);
  const sources = context.sources?.filter((source) => !excluded.has(source.id));
  const removedTitles = new Set(context.sources?.filter((source) => excluded.has(source.id)).map((source) => source.title));
  const keptTitles = new Set(sources?.map((source) => source.title));
  return {
    ...context,
    sources,
    recentNotes: context.recentNotes?.filter((title) => !removedTitles.has(title) || keptTitles.has(title)),
  };
}
