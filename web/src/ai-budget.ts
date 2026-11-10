/**
 * Plafond quotidien de l'IA. Google compte par projet et par modèle, remet ses
 * requêtes à zéro à minuit heure du Pacifique et ne publie pas ses chiffres gratuits :
 * la requête est la ressource rare, c'est elle que ce compteur protège.
 */
// shortcut: compteur par appareil alors que Google compte par projet, à revoir si WorkLogs peut lire la consommation du projet.

export const DEFAULT_DAILY_REQUESTS = 150; // ordre de grandeur arrondi : 7 modèles gratuits × 20 requêtes (le plus bas relevé) = 140
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

/** AAAA-MM-JJ à Los Angeles : le jour du quota, pas celui de l'utilisateur. */
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

const boundedLimit = (limit: number) => Number.isFinite(limit)
  ? Math.min(MAX_DAILY_REQUESTS, Math.max(MIN_DAILY_REQUESTS, Math.round(limit)))
  : DEFAULT_DAILY_REQUESTS;

export function readDailyLimit(): number {
  try {
    return boundedLimit(Number(localStorage.getItem(LS_LIMIT) || NaN));
  } catch {
    return DEFAULT_DAILY_REQUESTS;
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
export function aiBudgetRefusal(background: boolean): string | null {
  const usage = readAiUsage();
  const limit = readDailyLimit();
  const tokens = limit * TOKENS_PER_REQUEST;
  const reached = usage.requests >= limit ? `${formatted(limit)} requêtes`
    : usage.tokens >= tokens ? `${formatted(tokens)} jetons` : '';
  if (reached) return `Plafond quotidien d’IA atteint sur cet appareil (${reached}) : il revient à ${aiResetTime()}, ou relève-le dans ⚙ Paramètres.`;
  return background && usage.background >= Math.ceil(limit / 3)
    ? 'Actualisation automatique suspendue pour aujourd’hui : elle ne prend qu’un tiers du plafond quotidien. « Actualiser » reste disponible.'
    : null;
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

export function aiUsageLabel(): string {
  const usage = readAiUsage();
  return `Aujourd’hui : ${formatted(usage.requests)} / ${formatted(readDailyLimit())} requêtes · ≈ ${formatted(usage.tokens)} jetons`;
}
