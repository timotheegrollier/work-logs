/**
 * Plafond quotidien de WorkLogs, par appareil. La remise à zéro historique
 * reste à minuit heure du Pacifique, indépendamment des limites du fournisseur.
 */
export const DEFAULT_DAILY_REQUESTS = 50;
export const DEFAULT_WORKLOGS_DAILY_REQUESTS = 150;
export const MIN_DAILY_REQUESTS = 10;
export const MAX_DAILY_REQUESTS = 5000;
export const TOKENS_PER_REQUEST = 10_000; // plafond de jetons = requêtes × ce volume

export interface AiUsage {
  day: string;
  requests: number;
  tokens: number;
  background: number;
}

const LS_USAGE = 'worklogs-ai-usage';
const LS_LIMIT = 'worklogs-ai-daily-limit';
const PACIFIC_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const requestsInFlight = new Set<{ background: boolean; tokens: number }>();

/** AAAA-MM-JJ à Los Angeles : la journée de comptage WorkLogs. */
export function pacificDay(now = new Date()): string {
  const { year, month, day } = Object.fromEntries(PACIFIC_DATE.formatToParts(now).map((part) => [part.type, part.value]));
  return `${year}-${month}-${day}`;
}

/** Prochain minuit à Los Angeles : 7 h UTC en heure d'été, 8 h UTC en heure d'hiver. */
export function nextAiReset(now = new Date()): Date {
  const [year, month, day] = pacificDay(now).split('-').map(Number);
  const summer = new Date(Date.UTC(year, month - 1, day + 1, 7));
  return pacificDay(summer) === pacificDay(now) ? new Date(Date.UTC(year, month - 1, day + 1, 8)) : summer;
}

/** Heure locale « HH:MM » du retour du quota. */
export function aiResetTime(now = new Date()): string {
  return nextAiReset(now).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Compteur du jour ; zéro après minuit à Los Angeles, stockage indisponible ou valeur corrompue. */
export function readAiUsage(now = new Date()): AiUsage {
  const zero = { day: pacificDay(now), requests: 0, tokens: 0, background: 0 };
  try {
    const { day, requests, tokens, background } = JSON.parse(localStorage.getItem(LS_USAGE) ?? '{}');
    return day === zero.day && [requests, tokens, background].every((count) => Number.isFinite(count) && count >= 0)
      ? { day, requests, tokens, background }
      : zero;
  } catch {
    return zero;
  }
}

const boundedLimit = (limit: number, fallback = DEFAULT_DAILY_REQUESTS) => Number.isFinite(limit)
  ? Math.min(MAX_DAILY_REQUESTS, Math.max(MIN_DAILY_REQUESTS, Math.round(limit)))
  : fallback;

export function readDailyLimit(fallback = DEFAULT_DAILY_REQUESTS): number {
  try {
    return boundedLimit(Number(localStorage.getItem(LS_LIMIT) || NaN), fallback);
  } catch {
    return fallback;
  }
}

export function saveDailyLimit(limit: number): void {
  try {
    localStorage.setItem(LS_LIMIT, String(boundedLimit(limit)));
  } catch {
    // Stockage indisponible : le plafond par défaut reste en vigueur.
  }
}

/** Espace ordinaire : selon sa version, ICU sépare les milliers par U+00A0 ou U+202F. */
const formatted = (count: number) => count.toLocaleString('fr-FR').replace(/\s/g, ' ');

/** Motif du refus, ou null : le suivi automatique ne peut pas assécher les gestes explicites. */
export function aiBudgetRefusal(background: boolean, fallback?: number): string | null {
  return budgetRefusal(readAiUsage(), readDailyLimit(fallback), background);
}

function budgetRefusal(usage: AiUsage, limit: number, background: boolean): string | null {
  const tokens = limit * TOKENS_PER_REQUEST;
  const reached = usage.requests >= limit ? `${formatted(limit)} requêtes`
    : usage.tokens >= tokens ? `${formatted(tokens)} jetons` : '';
  if (reached) return `Plafond quotidien d’IA atteint sur cet appareil (${reached}) : il revient à ${aiResetTime()}, ou relève-le dans ⚙ Paramètres.`;
  return background && usage.background >= Math.ceil(limit / 3)
    ? 'Actualisation automatique suspendue pour aujourd’hui : elle ne prend qu’un tiers du plafond quotidien. « Actualiser » reste disponible.'
    : null;
}

/** Garde une place pendant l’appel. Seule une réponse facturable alimente le compteur persistant. */
export function reserveAiRequest(background: boolean, estimatedTokens: number, fallback?: number): { release: () => void } | { reason: string; temporary: boolean } {
  const usage = readAiUsage();
  const limit = readDailyLimit(fallback);
  const refusal = budgetRefusal(usage, limit, background);
  if (refusal) return { reason: refusal, temporary: false };

  for (const pending of requestsInFlight) {
    usage.requests += 1;
    usage.tokens += pending.tokens;
    usage.background += Number(pending.background);
  }
  if (budgetRefusal(usage, limit, background)) {
    return { reason: 'Les demandes IA en cours occupent le quota disponible. Réessaie après leur réponse.', temporary: true };
  }

  const request = { background, tokens: estimatedTokens };
  requestsInFlight.add(request);
  return { release: () => { requestsInFlight.delete(request); } };
}

export function recordAiUsage(tokens: number, background: boolean): void {
  const usage = readAiUsage();
  try {
    localStorage.setItem(LS_USAGE, JSON.stringify({
      ...usage,
      requests: usage.requests + 1,
      tokens: usage.tokens + tokens,
      background: usage.background + Number(background),
    }));
  } catch {
    // Stockage indisponible : l'appel a abouti, seul le compte est perdu.
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function aiUsageLabel(fallback?: number): string {
  const usage = readAiUsage();
  return `Aujourd’hui : ${formatted(usage.requests)} / ${formatted(readDailyLimit(fallback))} requêtes · ≈ ${formatted(usage.tokens)} jetons`;
}
