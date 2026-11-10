import { api, type EntrySummary } from './lib';
import { compactTitles, recurringVocabulary, type AiWorkContext } from './ai-suggest';
import { richToMarkdown } from './rich-markdown';

const PROJECT_CONTEXTS_KEY = 'worklogs-ai-project-contexts';
const MAX_PROJECT_BRIEF = 2000;
const MAX_SOURCES = 3;
const MAX_SOURCE_TEXT = 2000;
// La recherche est locale, mais un brouillon très long ne doit pas dominer le
// titre ni rendre le classement coûteux. On garde aussi la fin du document.
const MAX_QUERY_TEXT = 12000;
const MAX_QUERY_WORDS = 80;
// Chaque mot du titre cherché dans les textes coûte une lecture complète de l'état.
const MAX_BODY_SEARCHES = 4;
const STOPWORDS = new Set(
  'le la les de des du un une et est en dans pour avec sur par au aux ce cette ces ses son ton ta tes mes que qui quoi dont ou comme tout tous toute toutes plus moins aussi bien faire fait font etre ete avoir leur leurs notre nos votre vos mais donc car ni si elle il ils elles nous vous je tu on ne pas encore entre vers chez sans sous apres avant pendant depuis contre autre autres tel telle tels telles cela ceci note notes procedure procedures creer nouvelle nouveau mettre jour mon sont ont cet ici voir mise reunion faut peut doit dois tres meme quand alors puis ainsi afin selon lors chaque plusieurs quelques aucun aucune besoin demain hier aujourd hui'.split(' ')
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
    // Un intitulé générique ne doit pas rapprocher deux sujets sans rapport.
    .replace(/\b(?:comptes?[ -]+rendus?|sans titre)\b/g, ' ')
    // Un lien, une image, un chemin, un courriel ou une adresse IP non plus ; les autres nombres identifient (404, HP 3015).
    // Chemin et courriel ancrés au début du mot : sans ancre, un long mot sans espace coûte un temps quadratique.
    .replace(/\]\([^)]*\)|(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)+\/\S*|(?:^|\s)(?:\/|\S+@)\S+|\b\d{1,3}(?:\.\d{1,3}){3}\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    // Un sigle garde son s : la recherche par sous-chaîne de « na » (NAS) toucherait presque tout.
    .map((word) => word.length > 3 ? word.replace(/s$/, '') : word)
    .filter((word) => !STOPWORDS.has(word)));
}
export { words as contextWords };

function matches(text: string, keywords: Set<string>): number {
  const tokens = words(text);
  // L'année reste dans words() pour garder le seuil de deux mots cherchés, mais ne rapproche pas deux documents.
  // shortcut: un identifiant en forme d'année (HP 2015) ne compte plus, à revoir si de tels modèles doivent retenir un document.
  return [...keywords].filter((word) => tokens.has(word) && !/^(?:19|20)\d{2}$/.test(word)).length;
}

/** Les commandes et les étapes espacées restent des blocs indivisibles. */
function contextParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let lines: string[] = [];
  let fence = '';
  const flush = () => {
    const paragraph = lines.join('\n').trim();
    if (paragraph) {
      const list = /^(?:[-*+]|\d+[.)])\s/;
      const previous = paragraphs.at(-1);
      if (previous && list.test(previous) && list.test(paragraph)) paragraphs[paragraphs.length - 1] += '\n\n' + paragraph;
      else paragraphs.push(paragraph);
    }
    lines = [];
  };
  for (const line of text.trim().split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) fence = marker;
    else if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = '';
    if (!line.trim() && !fence) flush();
    else lines.push(line);
  }
  flush();
  return paragraphs;
}

/**
 * Garde les sections pertinentes (titres et avertissements compris), ou le
 * voisinage d'un passage sans titre. Sans correspondance dans le texte, le
 * document choisi par son titre ou son lien garde le repli borné habituel.
 * Un paragraphe très long est fenêtré autour du premier mot pertinent.
 */
function relevantExcerpt(text: string, keywords: Set<string>): string {
  const paragraphs = contextParagraphs(text);
  const scored = paragraphs.map((paragraph, index) => ({
    paragraph, index, score: matches(paragraph, keywords), level: /^(#{1,6})\s+/.exec(paragraph)?.[1].length ?? 0,
  }));
  const hits = scored.filter((item) => item.score > 0);
  const selected = new Set<number>();
  for (const hit of hits) {
    let heading = hit.index;
    while (heading >= 0 && !scored[heading].level) heading--;
    if (heading >= 0) {
      let level = scored[heading].level;
      let end = heading + 1;
      while (end < scored.length && (!scored[end].level || scored[end].level > level)) end++;
      for (let index = heading; index < end; index++) selected.add(index);
      for (let index = heading - 1; index >= 0; index--) {
        if (scored[index].level && scored[index].level < level) { selected.add(index); level = scored[index].level; }
      }
    } else {
      for (let index = Math.max(0, hit.index - 1); index <= Math.min(scored.length - 1, hit.index + 1); index++) {
        if (!scored[index].level) selected.add(index);
      }
    }
  }
  const ranked = scored.filter((item) => !hits.length || selected.has(item.index))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: { text: string; index: number }[] = [];
  // Réserver les marques d'omission évite de raccorder deux passages comme s'ils
  // étaient contigus ; le texte final reste sous le même plafond de 2 000 caractères.
  let remaining = MAX_SOURCE_TEXT - 10;
  for (const item of ranked) {
    const separator = chosen.length ? 7 : 0;
    const available = remaining - separator;
    if (available <= 0 || (available < 80 && item.paragraph.length > available)) break;
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
  chosen.sort((a, b) => a.index - b.index);
  if (!chosen.length) return '';
  return (chosen[0].index ? '[…]\n\n' : '')
    + chosen.map((item, index) => (index ? (item.index > chosen[index - 1].index + 1 ? '\n\n[…]\n\n' : '\n\n') : '') + item.text).join('')
    + (chosen.at(-1)!.index < paragraphs.length - 1 ? '\n\n[…]' : '');
}

export interface LoadAiContextOptions {
  projectId: string | null;
  title: string;
  /** Brouillon courant : sert localement à retrouver les sources pertinentes. */
  text?: string;
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
  const titleWords = words(options.title);
  // L'extrait s'arrête à 240 caractères : la recherche locale voit tout le texte.
  // shortcut: recherche par sous-chaîne (« port » trouve « rapport »), à revoir si des documents hors sujet remontent.
  const searched = [...titleWords].sort((a, b) => b.length - a.length).slice(0, MAX_BODY_SEARCHES);
  let states;
  try {
    // L'API ne possède pas de filtre « sans projet » : on filtre aussi localement.
    states = await Promise.all(['', ...searched].map((word) => api.state(word, options.projectId ?? '')));
  } catch {
    throw new Error('Impossible de charger le contexte IA du projet. Réessaie avant de lancer l’assistance.');
  }
  const [state, ...searches] = states;
  const bodyHits = new Map<string, number>();
  for (const search of searches) for (const { id } of search.entries) bodyHits.set(id, (bodyHits.get(id) ?? 0) + 1);
  // Un mot courant ou l'année d'un titre daté toucheraient trop de documents : deux mots, ou l'unique mot du titre.
  const bodyHitsNeeded = searched.length === 1 && !/^\d+$/.test(searched[0]) ? 1 : 2;
  const projectTasks = state.tasks.filter((task) => task.project_id === options.projectId);
  const currentTask = projectTasks.find((task) => task.id === options.taskId);
  const linkedIds = new Set([
    ...(options.linkedDocumentIds ?? []),
    ...(currentTask?.documents ?? []).map((document) => document.id),
  ]);
  const byId = new Map<string, EntrySummary>();
  for (const summary of [...(currentTask?.documents ?? []), ...states.flatMap((item) => item.entries)]) byId.set(summary.id, summary);
  const eligible = [...byId.values()].filter((summary) =>
    summary.project_id === options.projectId && summary.id !== options.entryId && !summary.archived
    && !summary.google_document_id && !summary.google_tab_id);
  const siblings = new Set(projectTasks.filter((task) => task.documents.some((document) => document.id === options.entryId))
    .flatMap((task) => task.documents.map((document) => document.id)));
  const rawText = options.text ?? '';
  const queryText = rawText.length > MAX_QUERY_TEXT
    ? rawText.slice(0, MAX_QUERY_TEXT / 2) + '\n' + rawText.slice(-MAX_QUERY_TEXT / 2)
    : rawText;
  const allTextWords = [...words(queryText)].filter((word) => !titleWords.has(word));
  const textWords = new Set(allTextWords.length > MAX_QUERY_WORDS
    ? [...allTextWords.slice(0, MAX_QUERY_WORDS / 2), ...allTextWords.slice(-MAX_QUERY_WORDS / 2)]
    : allTextWords);
  const keywords = new Set([...titleWords, ...textWords]);
  const candidates = eligible.map((summary) => {
    const titleScore = 3 * matches(summary.title, titleWords) + matches(summary.excerpt || '', titleWords);
    return {
      summary, titleScore, linked: linkedIds.has(summary.id),
      // +2 : retenu par son texte ou une tâche commune, mais derrière un titre correspondant (3 et plus).
      score: titleScore + 2 * matches(summary.title, textWords) + matches(summary.excerpt || '', textWords)
        + ((bodyHits.get(summary.id) ?? 0) >= bodyHitsNeeded ? 2 : 0) + (siblings.has(summary.id) ? 2 : 0),
    };
  })
    // Un seul mot du brouillon dans un extrait ne mérite pas une place de 2 000 caractères.
    .filter((item) => item.linked || item.titleScore > 0 || item.score >= 2)
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
      // La date d'une procédure est celle de sa création : elle la ferait passer pour dépassée.
      return { id: entry.id, title: entry.title, kind: entry.kind, text: relevantExcerpt(text, keywords), date: entry.kind === 'note' ? entry.entry_date : undefined };
    } catch {
      throw new Error(`Impossible de lire « ${summary.title} » pour le contexte IA. Réessaie avant de lancer l’assistance.`);
    }
  }));
  const linkedTaskDocuments = new Set([...linkedIds, ...(options.entryId ? [options.entryId] : [])]);
  const rankedOpenTasks = projectTasks.filter((task) => task.id !== options.taskId && task.status !== 'done')
    .map((task, index) => ({
      task, index, score: 3 * matches(task.title, titleWords) + matches(task.title, textWords),
      linked: task.documents.some((document) => linkedTaskDocuments.has(document.id)),
    }))
    .filter((item) => item.linked || item.score > 0)
    .sort((a, b) => Number(b.linked) - Number(a.linked) || b.score - a.score || a.index - b.index);
  const openTasks = rankedOpenTasks.map(({ task }) => task);
  const relatedTaskTitles = compactTitles(openTasks.map((task) => task.title));
  const planningTitles = relatedTaskTitles;
  const relatedTaskPlanning = planningTitles.flatMap((title) => {
    const task = openTasks.find((candidate) => compactTitles([candidate.title])[0] === title);
    if (!task) return [];
    const date = task.due_date && /^\d{4}-\d{2}-\d{2}$/.test(task.due_date) ? new Date(`${task.due_date}T00:00:00Z`) : null;
    return [{ title, priority: task.priority === 'high' || task.priority === 'low' ? task.priority : 'normal' as const,
      due_date: date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === task.due_date ? task.due_date : null }];
  });
  const vocabularyInputs = {
    tasks: relatedTaskTitles,
    entries: sources.map((source) => ({ id: source.id, title: source.title })),
  };
  return {
    project: state.projects.find((project) => project.id === options.projectId)?.name,
    projectBrief: readProjectAiBrief(options.projectId),
    sources,
    relatedTasks: relatedTaskTitles,
    relatedTaskPlanning,
    vocabulary: recurringVocabulary([...vocabularyInputs.tasks, ...vocabularyInputs.entries.map((entry) => entry.title)]),
    vocabularyInputs,
  };
}

/** Une exclusion retire également le titre de la note des indications annexes. */
export function selectedAiContext(context: AiWorkContext, excludedIds: string[]): AiWorkContext {
  const excluded = new Set(excludedIds);
  // Les titres nécessaires au calcul restent dans le contexte local, jamais
  // dans l'objet prêt à transmettre au client IA.
  const { vocabularyInputs, ...selected } = context;
  // Dédupliquer après l'exclusion : retirer la première copie doit laisser la
  // seconde disponible. Des titres ou types différents gardent leur provenance.
  const seenSources = new Set<string>();
  const sources = context.sources?.filter((source) => {
    if (excluded.has(source.id)) return false;
    const key = JSON.stringify([source.kind, source.title, source.text.trim()]);
    if (seenSources.has(key)) return false;
    seenSources.add(key);
    return true;
  });
  const selectedIds = new Set(sources?.map((source) => source.id));
  return {
    ...selected,
    sources,
    vocabulary: vocabularyInputs
      ? recurringVocabulary([...vocabularyInputs.tasks, ...vocabularyInputs.entries.filter((entry) => selectedIds.has(entry.id)).map((entry) => entry.title)])
      : context.vocabulary,
  };
}
