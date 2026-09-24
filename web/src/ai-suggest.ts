/**
 * Suggestions de sous-tâches par IA (clé personnelle, jamais d'appel automatique).
 *
 * Un seul client générique compatible OpenAI (`POST {endpoint}/chat/completions`,
 * `Authorization: Bearer <clé>`) : il parle aussi bien à OpenAI qu'à la clé
 * gratuite d'AI Studio via l'endpoint OpenAI-compatible de Gemini
 * (`https://generativelanguage.googleapis.com/v1beta/openai`, modèle
 * `gemini-3.5-flash-lite` par défaut). Aucune dépendance, `fetch` natif.
 */

export interface AiSettings {
  endpoint: string;
  model: string;
  key: string;
  /** Contexte de travail écrit une fois (ex. solo dev en pisciculture), joint à chaque appel. */
  profile: string;
}

export const DEFAULT_AI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai';
export const DEFAULT_AI_MODEL = 'gemini-3.5-flash-lite';
/**
 * Chaîne de secours sur l'endpoint Gemini, du plus fiable au moins fiable d'après
 * des appels réels le 2026-09-24 (trois passages, clé gratuite) : `3-flash-preview`
 * et `2.5-flash` 3/3 en ~3 s ; `3.5-flash` lent (15–25 s) ; `3.6-flash` 2/3 ;
 * `3.5-flash-lite`, `3.1-flash-lite`, `flash-latest` et `3.7/3.8-flash` en 503
 * « high demand » presque à chaque fois. Les modèles gratuits servent les clés
 * gratuites en dernier : aucun n'est sûr seul, plusieurs le sont ensemble. Un
 * modèle refusé à une clé (404 : `2.5-flash-lite` pour les nouvelles clés) est
 * simplement sauté.
 */
export const GEMINI_FALLBACK_MODELS = [
  'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.6-flash',
  'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
];

export interface AiModelOption {
  id: string;
  label: string;
}

/**
 * Modèles proposés dans le select des Paramètres : chacun a répondu « OK » à
 * un appel réel le 2026-09-24 (clé de l'appareil, consigne « Réponds uniquement
 * avec : OK »). `gemini-2.5-flash-lite` en est exclu : Google le refuse en 404
 * (« no longer available to new users »). Le bouton « Tester » de l'écran ne
 * sert plus qu'au diagnostic de connexion.
 */
export const AI_MODELS: AiModelOption[] = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite — rapide et économique (défaut)' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash — le plus capable' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite — stable et léger' },
];

/** Valeur du select quand le modèle enregistré n'est dans aucune option. */
export const AI_CUSTOM_MODEL = 'personnalise';
const AI_TIMEOUT_MS = 30_000;
/**
 * Les modèles qui « raisonnent » (2.5-flash, 3.x-flash) décomptent leur réflexion
 * de ce budget : à 300 jetons, les sous-tâches revenaient tronquées. Le nettoyage
 * garde de toute façon huit lignes au plus.
 */
const SUGGEST_MAX_TOKENS = 1024;
const MAX_SUGGESTIONS = 8;

const LS_ENDPOINT = 'worklogs-ai-endpoint';
const LS_MODEL = 'worklogs-ai-model';
const LS_KEY = 'worklogs-ai-key';
const LS_PROFILE = 'worklogs-ai-profile';

/** Réglages lus depuis l'appareil ; la clé reste vide tant qu'elle n'est pas collée. */
export function readAiSettings(): AiSettings {
  const stored = (key: string) => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  };
  // Clés de test locales (`.env.local`, jamais committé) : ignorées en test
  // pour que `npm test` reste déterministe avec ou sans fichier local.
  const envDefault = (name: string) =>
    import.meta.env.MODE === 'test' ? '' : import.meta.env[name] || '';
  return {
    endpoint: stored(LS_ENDPOINT).trim() || envDefault('VITE_DEFAULT_AI_ENDPOINT') || DEFAULT_AI_ENDPOINT,
    model: stored(LS_MODEL).trim() || envDefault('VITE_DEFAULT_AI_MODEL') || DEFAULT_AI_MODEL,
    key: stored(LS_KEY).trim() || envDefault('VITE_DEFAULT_AI_KEY'),
    profile: stored(LS_PROFILE).trim(),
  };
}

export function saveAiSettings(settings: AiSettings): void {
  try {
    localStorage.setItem(LS_ENDPOINT, settings.endpoint.trim());
    localStorage.setItem(LS_MODEL, settings.model.trim());
    localStorage.setItem(LS_KEY, settings.key.trim());
    localStorage.setItem(LS_PROFILE, settings.profile.trim());
  } catch {
    // Stockage indisponible : les champs restent modifiables en mémoire.
  }
}

import type { EntrySummary, Project, Task } from './lib';

/** Contexte de travail joint au titre : ce que l'IA doit connaître du projet en cours. */
export interface SuggestContext {
  /** Profil écrit en Paramètres (ex. dev solo en pisciculture). */
  profile?: string;
  /** Nom du projet de la tâche, quand elle en a un. */
  project?: string;
  /** Titres des tâches voisines en cours, pour ne pas proposer de doublons. */
  relatedTasks?: string[];
  /** Titres des notes récentes du projet, pour coller au travail en cours. */
  recentNotes?: string[];
  /** Mots du métier appris des titres existants, tous projets confondus. */
  vocabulary?: string[];
  /** Extrait du texte déjà présent dans l'entrée (plafonné à l'envoi). */
  entryText?: string;
  /** Sous-tâches déjà présentes dans l'entrée : à ne jamais reproposer. */
  existingSubtasks?: { text: string; done: boolean }[];
  /** Noms des pièces jointes de l'entrée. */
  attachments?: string[];
  /** Titres des tâches déjà liées à l'entrée. */
  linkedTasks?: string[];
  /** Titres des documents déjà liés à la tâche (créateur d'entrée liée). */
  linkedDocuments?: string[];
}

const MAX_CONTEXT_ITEMS = 5;
const MAX_TITLE_LENGTH = 80;

/** Compacte une liste de titres : rognés, dédupliqués, plafonnés. */
export function compactTitles(titles: string[]): string[] {
  const seen = new Set<string>();
  const compacted: string[] = [];
  for (const raw of titles) {
    const title = raw.trim().replace(/\s+/g, ' ');
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    compacted.push(title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH - 1) + '…' : title);
    if (compacted.length >= MAX_CONTEXT_ITEMS) break;
  }
  return compacted;
}

/** Mots vides français : le vocabulaire appris ne retient que les mots du métier. */
const STOPWORDS = new Set(
  'le la les de des du un une et est en dans pour avec sur par au aux ce cette ces ses ton ta tes mes que qui quoi dont ou comme tout tous toute toutes plus moins aussi bien faire fait font etre ete avoir leur leurs notre nos votre vos mais donc car ni si elle il ils elles nous vous je tu on ne pas y encore entre vers chez sans sous apres avant pendant depuis contre entre autre autres tel telle tels telles ca cela ceci cela'.split(' ')
);

const MAX_VOCABULARY = 8;
const MAX_ENTRY_TEXT = 1500;

/**
 * Vocabulaire auto-appris : les mots qui reviennent dans les titres existants
 * (ex. bassin, filtration…), triés par fréquence puis alphabétiquement. C'est
 * ainsi que l'IA « apprend seule » le métier, sans fiche à remplir.
 */
export function recurringVocabulary(titles: string[]): string[] {
  const counts = new Map<string, number>();
  for (const raw of titles) {
    for (const word of raw.toLowerCase().split(/[^a-zàâäéèêëîïôöùûüçñ]+/i)) {
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_VOCABULARY)
    .map(([word]) => word);
}

/** Tronque un texte long en gardant le début, avec marque de coupe. */
export function truncate(text: string, max = MAX_ENTRY_TEXT): string {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
}

/** Sous-tâches à cases déjà présentes dans un contenu Markdown. */
export function parseChecklist(contentMd: string): { text: string; done: boolean }[] {
  const items: { text: string; done: boolean }[] = [];
  for (const line of contentMd.split('\n')) {
    const match = line.trim().match(/^(?:[-*•]\s*)?\[([ xX])\]\s*(.+)$/);
    if (!match || !match[2].trim()) continue;
    items.push({ text: match[2].trim(), done: match[1].toLowerCase() === 'x' });
  }
  return items;
}

/** Consigne : découpage concret et vérifiable, en français, une idée par ligne. */
export function buildSuggestPrompt(title: string, context: SuggestContext = {}): { system: string; user: string } {
  const sections: string[] = [];
  if (context.profile?.trim()) sections.push(`Profil : ${context.profile.trim()}`);
  sections.push(`Tâche : ${title.trim()}`);
  if (context.project) sections.push(`Projet : ${context.project}`);
  const related = compactTitles(context.relatedTasks ?? []);
  if (related.length > 0) sections.push(`Tâches voisines en cours :\n${related.map((t) => `- ${t}`).join('\n')}`);
  const notes = compactTitles(context.recentNotes ?? []);
  if (notes.length > 0) sections.push(`Notes récentes du projet :\n${notes.map((n) => `- ${n}`).join('\n')}`);
  const vocabulary = (context.vocabulary ?? []).filter((word) => word.trim());
  if (vocabulary.length > 0) sections.push(`Vocabulaire du métier : ${vocabulary.join(', ')}`);
  if (context.entryText?.trim()) sections.push(`Contenu actuel de l'entrée (extrait) :\n${truncate(context.entryText)}`);
  const existing = (context.existingSubtasks ?? []).filter((item) => item.text.trim());
  if (existing.length > 0) {
    sections.push(
      `Sous-tâches déjà présentes (ne les repropose jamais) :\n${existing.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n')}`
    );
  }
  const attachments = compactTitles(context.attachments ?? []);
  if (attachments.length > 0) sections.push(`Pièces jointes : ${attachments.join(', ')}`);
  const linkedTasks = compactTitles(context.linkedTasks ?? []);
  if (linkedTasks.length > 0) sections.push(`Tâches déjà liées : ${linkedTasks.join(', ')}`);
  const linkedDocuments = compactTitles(context.linkedDocuments ?? []);
  if (linkedDocuments.length > 0) sections.push(`Documents déjà liés : ${linkedDocuments.join(', ')}`);
  return {
    system: `Tu aides à découper le travail de l'utilisateur dans WorkLogs, son journal de travail personnel : il y écrit ce qu'il fait (notes en Markdown) et y suit ses tâches.
Tiens compte de son profil, de son vocabulaire métier et du contexte (projet, tâches voisines, notes récentes, contenu déjà présent dans l'entrée) pour des sous-tâches concrètes et vérifiables, en français : jamais de doublon avec l'existant — surtout jamais une sous-tâche déjà présente, cochée ou non — vocabulaire du métier quand c'est pertinent.
Réponds uniquement avec les sous-tâches, une par ligne, texte seul : ni puces,
ni numéros, ni cases à cocher, ni phrase d'introduction. Au plus ${MAX_SUGGESTIONS},
courtes (moins de 60 caractères chacune).`,
    user: sections.join('\n'),
  };
}

/**
 * Lignes brutes de l'IA → une sous-tâche par ligne, sans puces ni numéros.
 * `subtasksMd()` se charge ensuite des cases à cocher.
 */
export function cleanSuggestionLines(text: string): string {
  const items = text.split('\n').map((line) => {
    const cleaned = line
      .trim()
      .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      .replace(/^[-*•]$/, '')
      .trim();
    return cleaned;
  }).filter((item) => item.length > 0);
  return items.slice(0, MAX_SUGGESTIONS).join('\n');
}

/**
 * Contexte d'une tâche : nom du projet, voisines en cours (hors terminées et
 * hors elle-même), notes récentes du projet, vocabulaire appris de tous les
 * titres existants. Pur et testé ; le compactage (déduplication, plafond) a
 * lieu dans `buildSuggestPrompt`.
 */
export function taskSuggestContext(
  task: Pick<Task, 'id' | 'project_id'>,
  tasks: Pick<Task, 'id' | 'title' | 'project_id' | 'status'>[],
  entries: Pick<EntrySummary, 'title' | 'project_id'>[],
  projects: Pick<Project, 'id' | 'name'>[]
): SuggestContext {
  return {
    project: projects.find((project) => project.id === task.project_id)?.name,
    relatedTasks: tasks
      .filter((other) => other.id !== task.id && other.project_id === task.project_id && other.status !== 'done')
      .map((other) => other.title),
    recentNotes: entries.filter((entry) => entry.project_id === task.project_id).map((entry) => entry.title),
    vocabulary: recurringVocabulary([
      ...tasks.map((other) => other.title),
      ...entries.map((entry) => entry.title),
    ]),
  };
}

export class AiError extends Error {}

/**
 * Le dernier secours qui a répondu passe en tête pendant dix minutes : seul le
 * premier appel attend que le modèle choisi, s'il traîne, épuise sa tranche. Passé
 * ce délai, le modèle choisi retrouve sa chance. En mémoire seulement.
 */
const PREFERRED_MS = 10 * 60_000;
let preferred: { chosen: string; model: string; until: number } | null = null;

/** Pour les tests : oublie le secours mémorisé. */
export function resetAiFallbackMemory(): void {
  preferred = null;
}

/** Échec propre à ce modèle (saturé, trop lent, absent pour cette clé, réponse vide) : un autre a sa chance. */
class AiTryNext extends AiError {
  constructor(message: string, readonly overloaded = false) { super(message); }
}

const OVERLOADED_MESSAGE = 'Modèle IA surchargé chez le fournisseur : réessaie dans quelques minutes, ou choisis un autre modèle dans ⚙ Paramètres.';

/**
 * Motif renvoyé par le fournisseur (ex. Google `models/… is not found`) :
 * plafonné à 200 caractères, chaîne vide si le corps est illisible. Une 404
 * avec une clé valide vient presque toujours du modèle ou de l'endpoint
 * enregistrés en Paramètres, pas de la clé — autant le montrer.
 */
async function providerDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const message = body?.error?.message ?? body?.message;
    return typeof message === 'string' && message.trim() ? message.trim().slice(0, 200) : '';
  } catch {
    return '';
  }
}

/**
 * Un clic = une demande : jamais d'envoi automatique, jamais de boucle. Seule
 * exception, bornée : sur l'endpoint Gemini, si le modèle choisi est saturé
 * (503…) ou ne répond pas à temps, **un** essai avec le modèle de secours. Il
 * n'aurait aucun sens ailleurs (un autre fournisseur n'a pas ce modèle).
 * Tout échec rend un message français, jamais d'exception réseau brute.
 */
async function postChatCompletions(
  settings: AiSettings,
  feature: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number
): Promise<string> {
  const key = settings.key.trim();
  if (!key) throw new AiError(`Colle ta clé IA dans ⚙ Paramètres pour activer ${feature}.`);
  const model = settings.model.trim();
  // Un autre fournisseur n'a pas ces modèles : un seul essai, le sien.
  if (!/^https:\/\/generativelanguage\.googleapis\.com\//.test(settings.endpoint.trim())) {
    return postOnce(settings, model, key, system, user, maxTokens, timeoutMs);
  }
  // Chaque modèle au plus une fois, dans un budget total borné : pas une boucle.
  // Un 503 répond en ~0,5 s, un essai raté coûte donc peu ; seul un modèle qui
  // traîne consomme sa tranche (deux tiers du délai), puis on passe au suivant.
  const remembered = preferred && preferred.chosen === model && preferred.until > Date.now() ? preferred.model : null;
  const candidates = [...(remembered ? [remembered] : []), model, ...GEMINI_FALLBACK_MODELS]
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
  const deadline = Date.now() + timeoutMs * 1.5;
  const slice = Math.round((timeoutMs * 2) / 3);
  let last: AiTryNext | null = null;
  let allOverloaded = true;
  for (const candidate of candidates) {
    const remaining = deadline - Date.now();
    if (remaining < Math.min(2000, slice / 2)) break;
    try {
      const content = await postOnce(settings, candidate, key, system, user, maxTokens, Math.min(remaining, slice));
      preferred = candidate === model ? null : { chosen: model, model: candidate, until: Date.now() + PREFERRED_MS };
      return content;
    } catch (e) {
      // Clé refusée ou pas de réseau : insister sur un autre modèle n'y changera rien.
      if (!(e instanceof AiTryNext)) throw e;
      last = e;
      allOverloaded &&= e.overloaded;
    }
  }
  if (!last || allOverloaded) throw new AiError(OVERLOADED_MESSAGE);
  throw new AiError(last.message);
}

async function postOnce(
  settings: AiSettings,
  model: string,
  key: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${settings.endpoint.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.4,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
  } catch {
    // Délai dépassé ≠ hors ligne : le message « injoignable » accusait à tort la connexion.
    if (controller.signal.aborted) throw new AiTryNext(OVERLOADED_MESSAGE, true);
    throw new AiError('IA injoignable : hors ligne ou endpoint incorrect.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 503 || res.status === 502 || res.status === 504 || res.status === 500) {
    throw new AiTryNext(OVERLOADED_MESSAGE, true);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AiError('Clé IA refusée : vérifie-la dans ⚙ Paramètres (une clé AI Studio suffit).');
  }
  if (res.status === 429) {
    // Le quota gratuit est compté par modèle : un autre peut encore répondre.
    throw new AiTryNext('Limite du service IA atteinte : réessaie dans une minute.');
  }
  if (!res.ok) {
    const detail = await providerDetail(res);
    // 404 : modèle absent pour cette clé ; le suivant a sa chance.
    throw new (res.status === 404 ? AiTryNext : AiError)(
      detail
        ? `Service IA indisponible (${res.status}) : ${detail} — vérifie le modèle et l’endpoint dans ⚙ Paramètres.`
        : `Service IA indisponible (${res.status}) : réessaie plus tard.`
    );
  }
  const content = await res.json().catch(() => null).then((body) => body?.choices?.[0]?.message?.content);
  if (typeof content !== 'string' || !content.trim()) throw new AiTryNext('Réponse IA illisible : réessaie.');
  return content;
}

/**
 * Essai réel avec la clé de l'appareil : un appel minimal (« OK » attendu),
 * jamais de nouvel essai. Rend la durée en millisecondes ; tout échec rend le
 * motif du fournisseur via `postChatCompletions` (modèle inconnu, clé refusée…).
 * Budget de 300 jetons : les modèles à raisonnement (`gemini-3.5-flash`) y
 * consomment leur réflexion avant le premier jeton de réponse (mesuré : 10 ne
 * suffisent pas, 200 oui).
 */
export async function testAiConnection(
  settings: AiSettings,
  options: { model?: string; timeoutMs?: number } = {}
): Promise<number> {
  const model = (options.model ?? settings.model).trim() || settings.model;
  const started = Date.now();
  await postChatCompletions({ ...settings, model }, 'le test de connexion', 'Réponds uniquement avec : OK', 'test', 300, options.timeoutMs ?? 15_000);
  return Date.now() - started;
}

/**
 * Un clic = un appel, jamais d'envoi automatique. Le titre seul part vers
 * l'endpoint configuré ; tout échec rend un message français, jamais d'exception
 * réseau brute, jamais de nouvel essai en boucle.
 */
export async function suggestSubtasks(
  settings: AiSettings,
  title: string,
  options: { context?: SuggestContext; timeoutMs?: number } = {}
): Promise<string> {
  // Le profil vit dans les réglages : chaque appel connaît le métier, sans que
  // les écrans aient à le renseigner.
  const prompt = buildSuggestPrompt(title, { ...options.context, profile: settings.profile });
  return cleanSuggestionLines(
    await postChatCompletions(settings, 'les suggestions', prompt.system, prompt.user, SUGGEST_MAX_TOKENS, options.timeoutMs ?? AI_TIMEOUT_MS)
  );
}

/** Au-delà, la réponse serait tronquée : on refuse plutôt que de corrompre. */
export const MAX_PROOFREAD_CHARS = 12000;

/**
 * Consigne : corriger et mettre en page, sans inventer ni changer le sens. Une
 * procédure (mode opératoire) garde en plus ses étapes en liste numérotée.
 */
export function buildProofreadPrompt(title: string, text: string, profile = '', procedure = false): { system: string; user: string } {
  const user = `${profile.trim() ? `Profil : ${profile.trim()}\n` : ''}${procedure ? 'Procédure' : 'Titre'} : ${title.trim()}\n\nTexte :\n${text}`;
  return {
    system: `${procedure
      ? "Tu relis une procédure de l'utilisateur dans WorkLogs, son journal de travail personnel : un mode opératoire en Markdown qu'il suivra plus tard, pas à pas."
      : "Tu relis le journal de travail personnel de l'utilisateur dans WorkLogs : il y écrit ce qu'il fait en Markdown."}
Corrige l'orthographe, la grammaire, la conjugaison et la typographie française (accents, majuscules, espaces), et mets en page le Markdown (titres, listes, tableaux, citations) sans changer le sens et sans rien inventer.${procedure ? ' Présente les étapes en liste numérotée, une action par étape.' : ''} Conserve tels quels les liens, images, blocs de code et cases à cocher.
Réponds uniquement avec le texte corrigé en Markdown, sans introduction ni explication.`,
    user,
  };
}

/** Retire l'éventuel bloc de code qui enveloppe la réponse, puis les blancs. */
export function cleanProofreadMarkdown(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, '$1')
    .trim();
}

/**
 * Mise en page + correction d'une entrée Markdown : le texte entier part vers
 * l'endpoint configuré, la version corrigée revient à relire avant application.
 * Documents riches exclus (comme les suggestions) : leur JSON ne transite pas.
 */
export async function proofreadEntry(
  settings: AiSettings,
  title: string,
  content: string,
  options: { timeoutMs?: number; procedure?: boolean } = {}
): Promise<string> {
  const text = content.trim();
  if (!text) throw new AiError('Rien à corriger : l’entrée est vide.');
  if (text.length > MAX_PROOFREAD_CHARS) {
    throw new AiError(`Texte trop long pour une relecture (${text.length} caractères, ${MAX_PROOFREAD_CHARS} maximum).`);
  }
  const prompt = buildProofreadPrompt(title, text, settings.profile, options.procedure);
  const cleaned = cleanProofreadMarkdown(
    await postChatCompletions(settings, 'la mise en page', prompt.system, prompt.user,
      Math.min(8000, Math.max(1200, Math.ceil(text.length / 2))), options.timeoutMs ?? AI_TIMEOUT_MS)
  );
  if (!cleaned) throw new AiError('Réponse IA illisible : réessaie.');
  return cleaned;
}

/** Au-delà, la procédure deviendrait une liste qu'on ne suit plus. */
const MAX_PROCEDURE_STEPS = 15;

/** Ce que l'IA sait d'une procédure : son projet, ses fichiers, ce qui est déjà écrit. */
export interface ProcedureContext {
  project?: string;
  attachments?: string[];
  /** Procédure déjà écrite, en Markdown : gardée et complétée, jamais effacée. */
  text?: string;
}

/** Consigne : un mode opératoire pas à pas, sans rien inventer de précis. */
export function buildProcedurePrompt(title: string, context: ProcedureContext = {}, profile = ''): { system: string; user: string } {
  const sections: string[] = [];
  if (profile.trim()) sections.push(`Profil : ${profile.trim()}`);
  sections.push(`Procédure : ${title.trim()}`);
  if (context.project) sections.push(`Projet : ${context.project}`);
  const attachments = compactTitles(context.attachments ?? []);
  if (attachments.length > 0) sections.push(`Pièces jointes : ${attachments.join(', ')}`);
  sections.push(context.text?.trim() ? `Déjà écrit :\n${context.text.trim()}` : 'Déjà écrit : rien pour l’instant.');
  return {
    system: `Tu aides l'utilisateur à rédiger ses procédures dans WorkLogs, son journal de travail personnel : une procédure est un mode opératoire qu'il suivra plus tard, pas à pas.
Propose la procédure complète en Markdown, en français : une phrase d'objectif, puis « ## Prérequis » (matériel, accès, sécurité) si utile, « ## Étapes » en liste numérotée — une action concrète et vérifiable par étape, ${MAX_PROCEDURE_STEPS} au plus — et « ## Vérifications » si utile.
Garde tout ce qui est déjà écrit (étapes, valeurs, liens, images) en l'intégrant au bon endroit. N'invente ni valeur chiffrée, ni référence, ni nom propre absents du contexte : écris « à préciser » à la place.
Réponds uniquement avec la procédure en Markdown, sans titre de premier niveau, sans introduction ni explication.`,
    user: sections.join('\n'),
  };
}

/**
 * Suggestion de procédure : un clic = un appel avec le titre, le projet, les
 * noms des pièces jointes et ce qui est déjà écrit. La proposition revient en
 * Markdown, à relire avant application — comme la mise en page.
 */
export async function suggestProcedure(
  settings: AiSettings,
  title: string,
  options: { context?: ProcedureContext; timeoutMs?: number } = {}
): Promise<string> {
  const text = options.context?.text?.trim() ?? '';
  const named = title.trim() && !/^sans titre$/i.test(title.trim());
  if (!named && !text) throw new AiError('Donne un titre à la procédure : l’IA s’en sert pour proposer les étapes.');
  if (text.length > MAX_PROOFREAD_CHARS) {
    throw new AiError(`Procédure trop longue pour une suggestion (${text.length} caractères, ${MAX_PROOFREAD_CHARS} maximum).`);
  }
  const prompt = buildProcedurePrompt(title, options.context, settings.profile);
  const cleaned = cleanProofreadMarkdown(
    await postChatCompletions(settings, 'les suggestions de procédure', prompt.system, prompt.user,
      Math.min(8000, Math.max(1500, Math.ceil(text.length / 2) + 1000)), options.timeoutMs ?? AI_TIMEOUT_MS)
  ).replace(/^#\s[^\n]*\n*/, ''); // le titre existe déjà : un `# Titre` en tête ferait doublon
  if (!cleaned.trim()) throw new AiError('Réponse IA illisible : réessaie.');
  return cleaned.trim();
}
