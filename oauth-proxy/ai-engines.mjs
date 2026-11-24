// Moteurs de l'IA gratuite et compteur partagé de leur usage (décision §98).
//
// Ordre : Gemini Flash, puis Flash-Lite, avec la clé gratuite du propriétaire gardée en secret
// du Worker (`GEMINI_API_KEY`), puis Gemma 4 sur Workers AI quand Google refuse. Google ne publie
// ses limites gratuites que dans AI Studio et ne les expose par aucune API : le Worker compte
// donc lui-même l'usage, pour tous les appareils, et retient les limites que Google cite en
// refusant. Sans dépendance : la classe Durable Object n'étend pas `cloudflare:workers`, pour que
// `node --test` la charge telle quelle.

export const GEMMA_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Sans liste de modèles encore lue : les alias de Google suivent ses nouvelles versions. */
export const DEFAULT_GEMINI_CHAIN = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const CATALOG_MAX_AGE = 6 * 3600_000;
// Barème Workers AI de Gemma 4 (neurones par million de jetons, page tarifs du 2026-11-18).
const GEMMA_NEURONS = { input: 9091, output: 27273 };
export const GEMMA_DAILY_NEURONS = 10_000;

const pacificParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** Jour du quota : minuit heure du Pacifique pour Google, minuit UTC pour Cloudflare. */
export function quotaDay(provider, now) {
  if (provider === 'cloudflare') return new Date(now).toISOString().slice(0, 10);
  const p = Object.fromEntries(pacificParts.formatToParts(now).map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function nextReset(provider, now) {
  if (provider === 'cloudflare') {
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

/** Flash et Flash-Lite retenus dans la liste de Google : l'alias « latest », sinon la version la plus haute. */
export function pickGemini(models) {
  const usable = new Map((Array.isArray(models) ? models : [])
    .filter((m) => typeof m?.name === 'string' && m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => [m.name.replace(/^models\//, ''), m]));
  const pick = (alias, pattern) => usable.has(alias) ? alias : [...usable.keys()].filter((id) => pattern.test(id)).sort(newer)[0];
  return [
    pick('gemini-flash-latest', /^gemini-\d+(?:\.\d+)*-flash$/),
    pick('gemini-flash-lite-latest', /^gemini-\d+(?:\.\d+)*-flash-lite$/),
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

/** Événements appliqués dans l'ordre par l'objet durable : lecture-écriture sans course. */
export function applyEvent(state, event, now) {
  if (event?.type === 'catalog') {
    state.catalog = { checked_at: now, models: Array.isArray(event.models) ? event.models : [] };
    return state;
  }
  const id = typeof event?.model === 'string' ? event.model : null;
  if (!id) return state;
  const provider = event.provider === 'cloudflare' ? 'cloudflare' : 'google';
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
  } else if (event.type === 'blocked') {
    entry.blocked_until = Number(event.until) || now + 60_000;
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

/** Modèles Gemini à essayer : catalogue lu, sinon les alias de Google. */
export function geminiChain(state) {
  const models = state?.catalog?.models;
  return Array.isArray(models) && models.length ? models.map(({ id }) => id) : DEFAULT_GEMINI_CHAIN;
}

/** Liste des modèles relue toutes les 6 h au plus, avec la clé du Worker. */
export async function refreshCatalog(env, state, store, now) {
  if (!env.GEMINI_API_KEY || (state?.catalog && now - state.catalog.checked_at < CATALOG_MAX_AGE)) return state;
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
  const catalog = state?.catalog?.models ?? [];
  const known = new Map(catalog.map((m) => [m.id, m]));
  const gemini = env.GEMINI_API_KEY ? geminiChain(state) : [];
  const engines = [
    ...gemini.map((id) => ({ id, provider: 'google', label: known.get(id)?.label ?? id, version: known.get(id)?.version ?? null })),
    { id: GEMMA_MODEL, provider: 'cloudflare', label: 'Gemma 4 26B (Cloudflare Workers AI)', version: null },
  ];
  return {
    updated_at: iso(now),
    gemini_configured: Boolean(env.GEMINI_API_KEY),
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
 * Un essai Gemini (compatibilité OpenAI). Rend `{ result }` sur une réponse 200, `{ block }`
 * (motif et échéance pendant laquelle ce modèle n'est plus essayé) ou `{ skip }` : refus propre
 * à cette demande, le modèle reste disponible pour la suivante.
 * Gemini 3.6+ ignore `temperature` et la refusera bientôt : elle n'est pas transmise.
 */
export async function askGemini(model, params, key, now) {
  let response;
  try {
    response = await fetch(`${GEMINI_BASE}/openai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: params.messages,
        max_tokens: params.max_completion_tokens,
        reasoning_effort: params.reasoning_effort ?? 'low',
        ...(params.response_format && { response_format: params.response_format }),
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    return { block: { until: now + 60_000, reason: 'Google injoignable' } };
  }
  const body = await response.json().catch(() => null);
  if (response.ok) return { result: body };
  if (response.status === 429) {
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
  if (response.status === 404) return { block: { until: now + 6 * 3600_000, reason: 'modèle introuvable chez Google' } };
  if ([400, 401, 403].includes(response.status)) {
    const message = String((Array.isArray(body) ? body[0] : body)?.error?.message ?? '');
    if (/api key/i.test(message) || response.status !== 400) return { block: { until: now + 3600_000, reason: 'clé Gemini refusée' } };
    return { skip: 'demande refusée par Google' };
  }
  return { block: { until: now + 60_000, reason: 'Google indisponible' } };
}
