// Moteurs de l'IA gratuite et compteur partagé de leur usage (décision §98).
//
// Ordre (§100) : Mistral, puis Groq, puis Gemini Flash-Lite et Flash, chacun avec la clé
// gratuite du propriétaire gardée en secret du Worker (`MISTRAL_API_KEY`, `GROQ_API_KEY`,
// `GEMINI_API_KEY`) ; un fournisseur sans clé est sauté. Gemma 4 sur Workers AI répond en
// dernier. Aucun ne publie ses limites gratuites par une API : le Worker compte lui-même
// l'usage, pour tous les appareils, et retient les limites citées dans les refus. Sans dépendance : la classe Durable Object n'étend pas `cloudflare:workers`, pour que
// `node --test` la charge telle quelle.

export const GEMMA_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Fournisseurs à clé, tous compatibles OpenAI ; `product` nomme la clé dans les motifs. */
export const PROVIDERS = {
  mistral: { name: 'Mistral', product: 'Mistral', secret: 'MISTRAL_API_KEY', url: 'https://api.mistral.ai/v1/chat/completions' },
  groq: { name: 'Groq', product: 'Groq', secret: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions' },
  google: { name: 'Google', product: 'Gemini', secret: 'GEMINI_API_KEY', url: `${GEMINI_BASE}/openai/chat/completions` },
};
const PROVIDER_IDS = new Set([...Object.keys(PROVIDERS), 'cloudflare']);
/**
 * Modèles fixes de Mistral et Groq, essayés avant Gemini. `effort` : modèle qui raisonne et
 * accepte `reasoning_effort` (les autres le refusent).
 * shortcut: liste écrite à la main ; un modèle retiré répond 404 et reste écarté 6 h, à remplacer ici.
 */
export const FIXED_ENGINES = [
  { id: 'mistral-medium-latest', provider: 'mistral', label: 'Mistral Medium' },
  { id: 'mistral-small-latest', provider: 'mistral', label: 'Mistral Small' },
  { id: 'openai/gpt-oss-120b', provider: 'groq', label: 'GPT-OSS 120B (Groq)', effort: true },
  { id: 'llama-3.3-70b-versatile', provider: 'groq', label: 'Llama 3.3 70B (Groq)' },
];
/**
 * Temps laissé aux modèles à clé avant Gemma : l'app abandonne à 30 s, Gemma répond en
 * quelques secondes. Chaque essai a au plus ce qui reste.
 */
export const CHAIN_BUDGET_MS = 20_000;
/** Sans liste de modèles encore lue : les alias de Google suivent ses nouvelles versions. */
export const DEFAULT_GEMINI_CHAIN = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
const CATALOG_MAX_AGE = 6 * 3600_000;
/** À changer quand la règle de choix change : le catalogue gardé est alors relu. */
const CATALOG_VERSION = 3;
/** Pannes passagères : écart doublé à chaque échec d'affilée, une heure au plus, remis à zéro au succès. */
const SLOW_BACKOFF = 5 * 60_000;
const DOWN_BACKOFF = 60_000;
const MAX_BACKOFF = 3600_000;
// Barème Workers AI de Gemma 4 (neurones par million de jetons, page tarifs du 2026-11-18).
const GEMMA_NEURONS = { input: 9091, output: 27273 };
export const GEMMA_DAILY_NEURONS = 10_000;

const pacificParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** Jour du quota : minuit heure du Pacifique pour Google, minuit UTC pour les autres. */
export function quotaDay(provider, now) {
  if (provider !== 'google') return new Date(now).toISOString().slice(0, 10);
  const p = Object.fromEntries(pacificParts.formatToParts(now).map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function nextReset(provider, now) {
  if (provider !== 'google') {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  const p = Object.fromEntries(pacificParts.formatToParts(now).map(({ type, value }) => [type, value]));
  const elapsed = (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000 + now % 1000;
  // shortcut: une heure d'écart les deux nuits de changement d'heure, sans effet sur un quota du jour.
  return now - elapsed + 86_400_000;
}

const versionOf = (id) => id.match(/^gemini-(\d+(?:\.\d+)*)-flash/)?.[1].split('.').map(Number) ?? [];
const newer = (a, b) => {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

/**
 * Flash-Lite puis Flash, retenus dans la liste de Google : la version stable la plus haute (Google
 * la conseille en production), l'alias « latest » faute de mieux. Flash-Lite d'abord : le 2026-11-24,
 * Flash ne répondait pas en 25 s quand Flash-Lite répondait en moins de deux secondes.
 */
export function pickGemini(models) {
  const usable = new Map((Array.isArray(models) ? models : [])
    .filter((m) => typeof m?.name === 'string' && m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => [m.name.replace(/^models\//, ''), m]));
  const pick = (alias, pattern) => [...usable.keys()].filter((id) => pattern.test(id)).sort(newer)[0] ?? (usable.has(alias) ? alias : undefined);
  return [
    pick('gemini-flash-lite-latest', /^gemini-\d+(?:\.\d+)*-flash-lite$/),
    pick('gemini-flash-latest', /^gemini-\d+(?:\.\d+)*-flash$/),
  ].filter(Boolean).map((id) => {
    const m = usable.get(id);
    return { id, label: String(m.displayName || id), version: m.version ? String(m.version) : null };
  });
}

/** Limite citée par Google dans un refus 429 : jour ou minute, valeur, délai conseillé. */
export function geminiRefusal(body) {
  const error = (Array.isArray(body) ? body[0] : body)?.error ?? {};
  const details = Array.isArray(error.details) ? error.details : [];
  const violation = details.flatMap((d) => Array.isArray(d?.violations) ? d.violations : []).find((v) => v?.quotaId || v?.quotaMetric) ?? {};
  const text = String(error.message ?? '');
  const id = `${violation.quotaId ?? ''} ${violation.quotaMetric ?? ''} ${text}`;
  const tokens = /token/i.test(id);
  const perDay = /PerDay|per day|daily|quota_exceeded/i.test(`${id} ${error.status ?? ''} ${error.code ?? ''}`);
  const value = Number(violation.quotaValue ?? text.match(/limit:\s*(\d+)/)?.[1]);
  const retry = String(details.find((d) => d?.retryDelay)?.retryDelay ?? text.match(/retry in ([\d.]+)\s*s/i)?.[1] ?? '');
  const seconds = Number.parseFloat(retry);
  return {
    kind: `${tokens ? 'tokens' : 'requests'}_per_${perDay ? 'day' : 'minute'}`,
    value: Number.isSafeInteger(value) ? value : null,
    retrySeconds: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null,
  };
}

const RATE_KINDS = { RPM: 'requests_per_minute', RPD: 'requests_per_day', TPM: 'tokens_per_minute', TPD: 'tokens_per_day' };

/**
 * Refus 429 de Mistral ou Groq : délai (en-tête `Retry-After`, sinon « try again in 1m2.5s »)
 * et limite citée (Groq : « tokens per day (TPD): Limit 200000 »).
 */
export function rateRefusal(headers, body) {
  const text = String(body?.error?.message ?? body?.message ?? '');
  const cited = text.match(/\((RPM|RPD|TPM|TPD)\)\s*:?\s*Limit\s*(\d+)/i);
  const header = Number(headers?.get?.('retry-after'));
  const spoken = text.match(/try again in\s*((?:\d+(?:\.\d+)?[hms])+)/i)?.[1];
  const seconds = header > 0 ? header : spoken
    ? [...spoken.matchAll(/(\d+(?:\.\d+)?)([hms])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * { h: 3600, m: 60, s: 1 }[unit], 0)
    : null;
  return {
    kind: cited ? RATE_KINDS[cited[1].toUpperCase()] : null,
    value: cited ? Number(cited[2]) : null,
    retrySeconds: seconds > 0 ? Math.ceil(seconds) : null,
    daily: /per day|\b(?:TPD|RPD)\b|daily|month/i.test(text),
  };
}

/** Événements appliqués dans l'ordre par l'objet durable : lecture-écriture sans course. */
export function applyEvent(state, event, now) {
  if (event?.type === 'catalog') {
    state.catalog = { checked_at: now, version: CATALOG_VERSION, models: Array.isArray(event.models) ? event.models : [] };
    return state;
  }
  const id = typeof event?.model === 'string' ? event.model : null;
  if (!id) return state;
  const provider = PROVIDER_IDS.has(event.provider) ? event.provider : 'google';
  const day = quotaDay(provider, now);
  const entry = state.models[id] ??= { provider, limits: {} };
  if (entry.day !== day) Object.assign(entry, { day, requests: 0, input_tokens: 0, output_tokens: 0, minute: [] });
  entry.minute = (entry.minute ?? []).filter((t) => t > now - 60_000);
  if (event.type === 'success') {
    entry.requests += 1;
    entry.input_tokens += Math.max(0, Number(event.input_tokens) || 0);
    entry.output_tokens += Math.max(0, Number(event.output_tokens) || 0);
    entry.minute.push(now);
    entry.last_used_at = now;
    if (typeof event.resolved === 'string' && event.resolved) entry.resolved = event.resolved;
    if ((entry.blocked_until ?? 0) <= now) delete entry.blocked_reason;
    entry.failures = 0;
  } else if (event.type === 'blocked') {
    entry.failures = (entry.failures ?? 0) + 1;
    const backoff = Number(event.backoff);
    entry.blocked_until = backoff > 0
      ? now + Math.min(backoff * 2 ** (entry.failures - 1), MAX_BACKOFF)
      : Number(event.until) || now + 60_000;
    entry.blocked_reason = String(event.reason ?? 'indisponible');
    if (event.limit?.kind && Number.isSafeInteger(event.limit.value)) {
      entry.limits[event.limit.kind] = { value: event.limit.value, learned_at: now };
    }
    entry.last_error = { at: now, reason: entry.blocked_reason };
  } else if (event.type === 'error') {
    entry.last_error = { at: now, reason: String(event.reason ?? 'erreur') };
  }
  return state;
}

/** Compteur partagé : un seul objet durable pour tout le compte. */
export class AiUsage {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const state = (await this.storage.get('state')) ?? { models: {}, catalog: null };
    if (request.method === 'POST') {
      applyEvent(state, await request.json(), Date.now());
      await this.storage.put('state', state);
    }
    return Response.json(state);
  }
}

/** Accès au compteur ; sans binding (tests, `wrangler dev`), l'IA marche sans rien compter. */
export function usageStore(env) {
  const namespace = env.AI_USAGE;
  const stub = namespace?.get?.(namespace.idFromName('global'));
  const call = async (init) => {
    if (!stub) return null;
    try {
      const response = await stub.fetch('https://usage/state', init);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  return {
    state: () => call(),
    record: (event) => call({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) }),
  };
}

/** Modèles Gemini à essayer : catalogue lu selon la règle en vigueur, sinon les alias de Google. */
export function geminiChain(state) {
  const models = state?.catalog?.version === CATALOG_VERSION ? state.catalog.models : null;
  return Array.isArray(models) && models.length ? models.map(({ id }) => id) : DEFAULT_GEMINI_CHAIN;
}

/** Modèles à clé dans l'ordre d'essai : Mistral, Groq (clé posée), puis Gemini. */
export function engineChain(env, state) {
  const known = new Map((state?.catalog?.models ?? []).map((m) => [m.id, m]));
  return [
    ...FIXED_ENGINES.filter(({ provider }) => env[PROVIDERS[provider].secret]).map((engine) => ({ version: null, ...engine })),
    ...(env.GEMINI_API_KEY ? geminiChain(state) : []).map((id) => ({
      id, provider: 'google', label: known.get(id)?.label ?? id, version: known.get(id)?.version ?? null, effort: true,
    })),
  ];
}

/** Liste des modèles relue toutes les 6 h au plus, avec la clé du Worker. */
export async function refreshCatalog(env, state, store, now) {
  const fresh = state?.catalog?.version === CATALOG_VERSION && now - state.catalog.checked_at < CATALOG_MAX_AGE;
  if (!env.GEMINI_API_KEY || fresh) return state;
  try {
    const response = await fetch(`${GEMINI_BASE}/models?pageSize=1000`, {
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return state;
    const models = pickGemini((await response.json())?.models);
    return models.length ? (await store.record({ type: 'catalog', models })) ?? state : state;
  } catch {
    return state;
  }
}

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/** Vue publique de `/ai/status` : modèles dans l'ordre d'essai, usage du jour, limites connues. */
export function statusView(env, state, now) {
  const engines = [
    ...engineChain(env, state).map(({ effort: _effort, ...engine }) => engine),
    { id: GEMMA_MODEL, provider: 'cloudflare', label: 'Gemma 4 26B (Cloudflare Workers AI)', version: null },
  ];
  return {
    updated_at: iso(now),
    gemini_configured: Boolean(env.GEMINI_API_KEY),
    // Fournisseurs dont la clé n'est pas encore posée sur le Worker, dans l'ordre d'essai.
    missing_providers: Object.values(PROVIDERS).filter(({ secret }) => !env[secret]).map(({ product }) => product),
    catalog_checked_at: iso(state?.catalog?.checked_at),
    models: engines.map((engine) => {
      const entry = state?.models?.[engine.id];
      const current = entry?.day === quotaDay(engine.provider, now);
      const input = current ? entry.input_tokens : 0;
      const output = current ? entry.output_tokens : 0;
      const blocked = (entry?.blocked_until ?? 0) > now;
      return {
        ...engine,
        resolved: entry?.resolved ?? null,
        today: { requests: current ? entry.requests : 0, input_tokens: input, output_tokens: output },
        last_minute: (entry?.minute ?? []).filter((t) => t > now - 60_000).length,
        limits: Object.fromEntries(Object.entries(entry?.limits ?? {}).map(([kind, { value, learned_at }]) => [kind, { value, learned_at: iso(learned_at) }])),
        ...(engine.provider === 'cloudflare' && {
          neurons: {
            used: Math.round(input * GEMMA_NEURONS.input / 1e6 + output * GEMMA_NEURONS.output / 1e6),
            limit: GEMMA_DAILY_NEURONS,
          },
        }),
        reset_at: iso(nextReset(engine.provider, now)),
        blocked_until: blocked ? iso(entry.blocked_until) : null,
        blocked_reason: blocked ? entry.blocked_reason : null,
        last_used_at: iso(entry?.last_used_at),
        last_error: entry?.last_error ? { at: iso(entry.last_error.at), reason: entry.last_error.reason } : null,
      };
    }),
  };
}

/**
 * Un essai d'un modèle à clé (API compatible OpenAI). Rend `{ result }` sur une réponse 200,
 * `{ block }` (motif et échéance pendant laquelle ce modèle n'est plus essayé) ou `{ skip }` :
 * refus propre à cette demande, le modèle reste disponible pour la suivante.
 * `temperature` n'est pas transmise : Gemini 3.6+ l'ignore et la refusera bientôt.
 */
export async function askEngine(engine, params, key, now, timeoutMs = CHAIN_BUDGET_MS) {
  const { name, product, url } = PROVIDERS[engine.provider];
  const google = engine.provider === 'google';
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: engine.id,
        messages: params.messages,
        max_tokens: params.max_completion_tokens,
        ...(engine.effort && { reasoning_effort: params.reasoning_effort ?? 'low' }),
        ...(params.response_format && { response_format: params.response_format }),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Trop lent : 5 min, puis 10, 20… pour qu'une seule demande paie l'attente de temps en temps.
    if (error?.name === 'TimeoutError') return { block: { backoff: SLOW_BACKOFF, reason: `${name} trop lent (plus de ${Math.round(timeoutMs / 1000)} s)` } };
    return { block: { backoff: DOWN_BACKOFF, reason: `${name} injoignable` } };
  }
  const body = await response.json().catch(() => null);
  const error = (Array.isArray(body) ? body[0] : body)?.error;
  // Code HTTP et statut du fournisseur (« 503 UNAVAILABLE ») : affichés tels quels dans les quotas.
  const status = String(error?.status ?? '').match(/^[A-Z_]{1,40}$/)?.[0];
  const code = `${response.status}${status ? ` ${status}` : ''}`;
  if (response.ok) return { result: body };
  if (response.status === 429) {
    if (!google) {
      const refusal = rateRefusal(response.headers, body);
      // Type et code du fournisseur (« service_tier_capacity_exceeded 3505 » chez Mistral) : un
      // palier gratuit saturé ne se distingue d'un quota que par eux.
      const cause = [error?.type ?? body?.type, error?.code ?? body?.code]
        .map((part) => String(part ?? '').match(/^[\w.-]{1,60}$/)?.[0]).filter(Boolean).join(' ');
      return {
        block: {
          until: refusal.retrySeconds ? now + refusal.retrySeconds * 1000 : refusal.daily ? nextReset(engine.provider, now) : now + 60_000,
          reason: `${refusal.daily ? 'quota du jour atteint' : 'limite par minute atteinte'}${cause ? ` (${cause})` : ''}`,
          ...(refusal.kind && refusal.value && { limit: { kind: refusal.kind, value: refusal.value } }),
        },
      };
    }
    const refusal = geminiRefusal(body);
    if (refusal.value === 0) return { block: { until: now + 86_400_000, reason: 'absent du palier gratuit' } };
    const daily = refusal.kind.endsWith('_day');
    return {
      block: {
        until: daily ? nextReset('google', now) : now + (refusal.retrySeconds ?? 60) * 1000,
        reason: daily ? 'quota du jour atteint' : 'limite par minute atteinte',
        ...(refusal.value && { limit: { kind: refusal.kind, value: refusal.value } }),
      },
    };
  }
  if (response.status === 404) return { block: { until: now + 6 * 3600_000, reason: `modèle introuvable chez ${name}` } };
  // Groq refuse en 413 une demande plus grosse que sa limite de jetons par minute : la suivante peut passer.
  if (response.status === 413) return { skip: `demande trop longue pour ${name} (413)` };
  if ([400, 401, 403, 422].includes(response.status)) {
    const message = String(error?.message ?? body?.message ?? '');
    if (/api.?key/i.test(message) || response.status === 401 || response.status === 403) {
      return { block: { until: now + 3600_000, reason: `clé ${product} refusée` } };
    }
    return { skip: `demande refusée par ${name} (${code})` };
  }
  return { block: { backoff: DOWN_BACKOFF, reason: `${name} indisponible (${code})` } };
}
