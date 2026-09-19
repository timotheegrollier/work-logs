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
}

export const DEFAULT_AI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai';
export const DEFAULT_AI_MODEL = 'gemini-3.5-flash-lite';
const AI_TIMEOUT_MS = 30_000;
const MAX_SUGGESTIONS = 8;

const LS_ENDPOINT = 'worklogs-ai-endpoint';
const LS_MODEL = 'worklogs-ai-model';
const LS_KEY = 'worklogs-ai-key';

/** Réglages lus depuis l'appareil ; la clé reste vide tant qu'elle n'est pas collée. */
export function readAiSettings(): AiSettings {
  const stored = (key: string) => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  };
  return {
    endpoint: stored(LS_ENDPOINT).trim() || import.meta.env.VITE_DEFAULT_AI_ENDPOINT || DEFAULT_AI_ENDPOINT,
    model: stored(LS_MODEL).trim() || import.meta.env.VITE_DEFAULT_AI_MODEL || DEFAULT_AI_MODEL,
    // Clé de test locale (`.env.local`, jamais committée) ou clé collée en Paramètres.
    key: stored(LS_KEY).trim() || import.meta.env.VITE_DEFAULT_AI_KEY || '',
  };
}

export function saveAiSettings(settings: AiSettings): void {
  try {
    localStorage.setItem(LS_ENDPOINT, settings.endpoint.trim());
    localStorage.setItem(LS_MODEL, settings.model.trim());
    localStorage.setItem(LS_KEY, settings.key.trim());
  } catch {
    // Stockage indisponible : les champs restent modifiables en mémoire.
  }
}

/** Consigne : découpage concret et vérifiable, en français, une idée par ligne. */
export function buildSuggestPrompt(title: string): { system: string; user: string } {
  return {
    system: `Tu découpes une tâche en sous-tâches concrètes et vérifiables, en français.
Réponds uniquement avec les sous-tâches, une par ligne, texte seul : ni puces,
ni numéros, ni cases à cocher, ni phrases d'introduction. Au plus ${MAX_SUGGESTIONS},
courtes (moins de 60 caractères chacune).`,
    user: `Tâche : ${title.trim()}`,
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

export class AiError extends Error {}

/**
 * Un clic = un appel, jamais d'envoi automatique. Le titre seul part vers
 * l'endpoint configuré ; tout échec rend un message français, jamais d'exception
 * réseau brute, jamais de nouvel essai en boucle.
 */
export async function suggestSubtasks(settings: AiSettings, title: string, timeoutMs = AI_TIMEOUT_MS): Promise<string> {
  const key = settings.key.trim();
  if (!key) throw new AiError('Colle ta clé IA dans ⚙ Paramètres pour activer les suggestions.');
  const prompt = buildSuggestPrompt(title);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${settings.endpoint.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: settings.model.trim(),
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.4,
        max_tokens: 300,
      }),
      signal: controller.signal,
    });
  } catch {
    throw new AiError('IA injoignable : hors ligne, délai dépassé ou endpoint incorrect.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AiError('Clé IA refusée : vérifie-la dans ⚙ Paramètres (une clé AI Studio suffit).');
  }
  if (res.status === 429) {
    throw new AiError('Limite du service IA atteinte : réessaie dans une minute.');
  }
  if (!res.ok) {
    throw new AiError(`Service IA indisponible (${res.status}) : réessaie plus tard.`);
  }
  const content = await res.json().catch(() => null).then((body) => body?.choices?.[0]?.message?.content);
  if (typeof content !== 'string' || !content.trim()) throw new AiError('Réponse IA illisible : réessaie.');
  return cleanSuggestionLines(content);
}
