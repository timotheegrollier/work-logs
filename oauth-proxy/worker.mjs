// Relais de jetons Google de la PWA WorkLogs — Cloudflare Worker, sans dépendance.
// La PWA est sur GitHub Pages (décision §97) : ce Worker ne sert plus de front, et
// renvoie toute autre adresse vers la même page de GitHub Pages.
// `/ai/pdf` extrait le texte d'un PDF joint explicitement à une demande IA.
// `/ai/chat/completions` sert l'assistant : Mistral, Groq, puis Gemini Flash-Lite et Flash, avec les clés gratuites du Worker, puis
// Gemma 4 sur Workers Free (`ai-engines.mjs`, décision §98). `/ai/status` montre modèles et quotas.
// Vérification : ouvrir `/token` dans un navigateur (`{"ok":true,…}`).
//
// Google exige le secret d'un client OAuth « Application Web » pour échanger le
// code de connexion et pour renouveler la session (`client_secret is missing`
// sinon, mesuré le 2026-09-23). La PWA est un site public : elle ne peut pas le
// détenir. Ce relais l'ajoute, et rien d'autre : deux échanges autorisés, la
// seule PWA comme origine et comme retour, rien de stocké ni de journalisé.
// Déploiement et vérification : docs/08-GOOGLE-DOCS.md « Relais de jetons ».
// Exports : `default`, et la classe du compteur partagé (objet durable déclaré dans `wrangler.toml`).

import { askEngine, CHAIN_BUDGET_MS, engineChain, GEMMA_MODEL, nextReset, PROVIDERS, refreshCatalog, statusView, usageStore } from './ai-engines.mjs';

export { AiUsage } from './ai-engines.mjs';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PAGES = 'https://timotheegrollier.github.io/work-logs';
/**
 * Origines autorisées : la PWA GitHub Pages, le serveur Vite en dev, et l'ancienne PWA
 * servie par ce Worker. shortcut: gardée pour une PWA déjà installée depuis Cloudflare,
 * qui tourne encore sur son cache ; la retirer, avec sa redirection, quand il n'y en a plus.
 */
const ORIGINS = [
  'https://worklogs-google.cocodexcocoder.workers.dev',
  'https://timotheegrollier.github.io',
  'http://localhost:8411',
];
/** URI de retour enregistrées dans Google Cloud pour le client Web. */
const REDIRECTS = [
  'https://worklogs-google.cocodexcocoder.workers.dev/',
  'https://timotheegrollier.github.io/work-logs/',
  'http://localhost:8411/',
];
const CLIENT_ID = /^[\w.-]+\.apps\.googleusercontent\.com$/;
const MAX_BODY = 8192;
// Routes IA : aussi la fenêtre desktop (`worklogs://app`, `desktop/main.mjs`) et les
// serveurs locaux de dev, à tout port. La limite par IP reste la vraie garde du quota.
const DESKTOP_ORIGIN = 'worklogs://app';
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;
const aiOrigin = (origin) => ORIGINS.includes(origin) || origin === DESKTOP_ORIGIN || LOOPBACK_ORIGIN.test(origin);
const MIB = 1024 * 1024;
const MAX_PDF_BYTES = 10 * MIB;
const MAX_PDF_TEXT = 16_000;
const MAX_CHAT_BYTES = 14 * MIB;
const MAX_CHAT_TEXT = 128_000;
const MAX_CHAT_TOKENS = 8000;
const MAX_CHAT_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * MIB;
const MAX_CHAT_IMAGE_BYTES = 10 * MIB;
const IMAGE_DATA_PREFIX = /^data:image\/(?:jpeg|png|webp);base64,/;
const CHAT_ROLES = new Set(['system', 'user', 'assistant']);
const CHAT_FINISH_REASONS = new Set(['stop', 'length', 'content_filter']);
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);
const BODY_TOO_LARGE = new RangeError('Corps trop volumineux');

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function reply(body, status, origin = '', headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(origin ? cors(origin) : {}), ...headers },
  });
}

function boundedBody(request, maxBytes) {
  let size = 0;
  return request.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) throw BODY_TOO_LARGE;
      controller.enqueue(chunk);
    },
  }));
}

function limitKey(request) {
  // Cette adresse est fournie par Cloudflare à l’arrivée de la requête.
  return { key: request.headers.get('CF-Connecting-IP') || 'sans-ip' };
}

async function pdfText(request, env, origin) {
  if (!aiOrigin(origin)) return reply({ error: 'Origine non autorisée.' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== 'POST') return reply({ error: 'Méthode non autorisée.' }, 405, origin, { Allow: 'POST, OPTIONS' });
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/pdf') return reply({ error: 'Seuls les fichiers PDF peuvent être lus ici.' }, 415, origin);
  const tooLarge = () => reply({ error: 'Le PDF dépasse la limite de 10 Mio.' }, 413, origin);
  if (Number(request.headers.get('Content-Length')) > MAX_PDF_BYTES) return tooLarge();
  if (!request.body) return reply({ error: 'Le PDF est vide.' }, 400, origin);

  const unavailable = () => reply({ error: 'La lecture des PDF est indisponible. Réessaie plus tard.' }, 503, origin);
  if (!env.AI?.toMarkdown || !env.PDF_LIMITER?.limit) return unavailable();
  let allowed;
  try {
    ({ success: allowed } = await env.PDF_LIMITER.limit(limitKey(request)));
  } catch {
    return unavailable();
  }
  if (!allowed) return reply({ error: 'Trop de PDF à lire. Réessaie dans une minute.' }, 429, origin, { 'Retry-After': '60' });

  let blob;
  try {
    blob = await new Response(boundedBody(request, MAX_PDF_BYTES), { headers: { 'Content-Type': 'application/pdf' } }).blob();
  } catch (error) {
    return error === BODY_TOO_LARGE ? tooLarge() : reply({ error: 'Le PDF est illisible.' }, 400, origin);
  }
  if (await blob.slice(0, 5).text() !== '%PDF-') return reply({ error: 'Le fichier reçu n’est pas un PDF.' }, 400, origin);

  // Le mode PDF extrait le texte déjà présent sans faire appel à un modèle
  // de vision. Le nom d’origine et les métadonnées ne sont pas nécessaires.
  let converted;
  try {
    converted = await env.AI.toMarkdown({ name: 'document.pdf', blob }, {
      conversionOptions: { pdf: { metadata: false }, output: { format: 'text' } },
    });
  } catch {
    return unavailable();
  }
  const text = converted?.format === 'text' && typeof converted.data === 'string' ? converted.data.trim() : '';
  if (!text) return reply({ error: 'Aucun texte lisible dans ce PDF.' }, 422, origin);
  return reply({ text: text.slice(0, MAX_PDF_TEXT), truncated: text.length > MAX_PDF_TEXT }, 200, origin);
}

function imageDataSize(url) {
  const prefix = typeof url === 'string' && url.match(IMAGE_DATA_PREFIX)?.[0];
  if (!prefix) return 0;
  const length = url.length - prefix.length;
  if (!length || length % 4) return 0;
  const padding = url.endsWith('==') ? 2 : Number(url.endsWith('='));
  if (/[^A-Za-z0-9+/]/.test(url.slice(prefix.length, url.length - padding))) return 0;
  return length / 4 * 3 - padding;
}

function chatParams(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length || body.messages.length > 24) return null;
  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 1024;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) return null;
  const format = body.response_format?.type;
  if (body.response_format !== undefined && format !== 'json_object' && format !== 'text') return null;

  const messages = [];
  let textLength = 0;
  let imageCount = 0;
  let imageBytes = 0;
  for (const message of body.messages) {
    const { role, content } = message ?? {};
    if (!CHAT_ROLES.has(role)) return null;
    if (typeof content === 'string') {
      textLength += content.length;
      messages.push({ role, content });
      continue;
    }
    if (role !== 'user' || !Array.isArray(content) || !content.length || content.length > MAX_CHAT_IMAGES + 1) return null;
    const parts = [];
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        textLength += part.text.length;
        parts.push({ type: 'text', text: part.text });
      } else if (part?.type === 'image_url') {
        const url = part.image_url?.url;
        const size = imageDataSize(url);
        if (!size) return null;
        imageCount += 1;
        imageBytes += size;
        if (size > MAX_IMAGE_BYTES || imageCount > MAX_CHAT_IMAGES || imageBytes > MAX_CHAT_IMAGE_BYTES) throw BODY_TOO_LARGE;
        parts.push({ type: 'image_url', image_url: { url } });
      } else {
        return null;
      }
    }
    messages.push({ role, content: parts });
  }
  if (textLength > MAX_CHAT_TEXT) throw BODY_TOO_LARGE;
  if (!messages.some(({ role }) => role === 'user')) return null;
  return {
    messages,
    temperature: typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2 ? body.temperature : 0.4,
    max_completion_tokens: Math.min(maxTokens, MAX_CHAT_TOKENS),
    chat_template_kwargs: { enable_thinking: false },
    // Réflexion de Gemini et de GPT-OSS ; jamais transmise aux autres modèles (`askEngine`) ni à Gemma.
    ...(REASONING_EFFORTS.has(body.reasoning_effort) && { reasoning_effort: body.reasoning_effort }),
    ...(format === 'json_object' && { response_format: { type: 'json_object' } }),
  };
}

function chatError(message, status, origin, headers = {}) {
  return reply({ error: { message } }, status, origin, headers);
}

function chatUpstreamError(status, code, retryAfter, origin) {
  const day = 86_400;
  const resetIn = code === 3036 ? String(day - Math.floor(Date.now() / 1000) % day) : '';
  const retry = retryAfter || resetIn;
  const headers = retry ? { 'Retry-After': retry, 'Access-Control-Expose-Headers': 'Retry-After' } : {};
  if (status === 429 && code !== 3040) {
    return chatError(code === 3036
      ? 'Quota gratuit de WorkLogs atteint pour aujourd’hui. Il revient à minuit UTC.'
      : 'Limite du service IA atteinte. Réessaie plus tard.', 429, origin, headers);
  }
  return chatError('Le service IA est temporairement indisponible. Réessaie plus tard.', 503, origin, headers);
}

/** Réponse OpenAI rendue au client, avec le modèle qui a répondu ; `null` si elle est inutilisable. */
function chatAnswer(result, model) {
  const choice = Array.isArray(result?.choices) ? result.choices[0] : null;
  const content = choice?.message?.content;
  const finish = choice?.finish_reason;
  if (!CHAT_FINISH_REASONS.has(finish) || (typeof content !== 'string' && finish !== 'content_filter')) return null;
  const usage = result.usage;
  return {
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: content ?? null }, finish_reason: finish }],
    ...(Number.isSafeInteger(usage?.total_tokens) && {
      usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens },
    }),
  };
}

const tokensOf = (answer) => ({ input_tokens: answer.usage?.prompt_tokens ?? 0, output_tokens: answer.usage?.completion_tokens ?? 0 });

async function aiStatus(request, env, origin) {
  if (!aiOrigin(origin)) return chatError('Origine non autorisée.', 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(origin), 'Access-Control-Allow-Methods': 'GET' } });
  if (request.method !== 'GET') return chatError('Méthode non autorisée.', 405, origin, { Allow: 'GET, OPTIONS' });
  const store = usageStore(env);
  const now = Date.now();
  const state = await refreshCatalog(env, await store.state(), store, now);
  return reply(statusView(env, state, now), 200, origin);
}

async function chatCompletion(request, env, origin) {
  if (!aiOrigin(origin)) return chatError('Origine non autorisée.', 403);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors(origin), 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'POST') return chatError('Méthode non autorisée.', 405, origin, { Allow: 'POST, OPTIONS' });
  const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') return chatError('La demande IA doit être au format JSON.', 415, origin);
  const invalid = () => chatError('La demande IA est invalide. Vérifie le texte et les images joints.', 400, origin);
  const tooLarge = () => chatError('La demande IA dépasse la taille autorisée. Raccourcis le texte ou retire des images.', 413, origin);
  if (Number(request.headers.get('Content-Length')) > MAX_CHAT_BYTES) return tooLarge();
  if (!request.body) return invalid();

  const unavailable = () => chatUpstreamError(503, undefined, '', origin);
  if (!env.AI?.run || !env.CHAT_LIMITER?.limit) return unavailable();
  let allowed;
  try {
    ({ success: allowed } = await env.CHAT_LIMITER.limit(limitKey(request)));
  } catch {
    return unavailable();
  }
  if (!allowed) {
    return chatError('Trop de demandes IA. Réessaie dans une minute.', 429, origin, {
      'Retry-After': '60', 'Access-Control-Expose-Headers': 'Retry-After',
    });
  }

  let params;
  try {
    params = chatParams(await new Response(boundedBody(request, MAX_CHAT_BYTES)).json());
  } catch (error) {
    return error === BODY_TOO_LARGE ? tooLarge() : invalid();
  }
  if (!params) return invalid();

  const store = usageStore(env);
  const state = await store.state();
  const blockedUntil = (id) => state?.models?.[id]?.blocked_until ?? 0;
  // Mistral, Groq puis Gemini, dans un budget borné : Gemma garde de quoi répondre avant l'app.
  const deadline = Date.now() + CHAIN_BUDGET_MS;
  for (const engine of engineChain(env, state)) {
    const { id: model, provider } = engine;
    if (blockedUntil(model) > Date.now()) continue;
    const left = deadline - Date.now();
    if (left < 2_000) break;
    const attempt = await askEngine(engine, params, env[PROVIDERS[provider].secret], Date.now(), left);
    const answer = attempt.result && chatAnswer(attempt.result, typeof attempt.result.model === 'string' ? attempt.result.model : model);
    if (answer) {
      await store.record({ type: 'success', model, provider, resolved: answer.model, ...tokensOf(answer) });
      return reply(answer, 200, origin);
    }
    await store.record(attempt.block
      ? { type: 'blocked', model, provider, ...attempt.block }
      : { type: 'error', model, provider, reason: attempt.skip ?? 'réponse vide ou illisible' });
  }

  const now = Date.now();
  if (blockedUntil(GEMMA_MODEL) > now) {
    const soonest = Math.min(...Object.values(state.models).map(({ blocked_until: until }) => until ?? 0).filter((until) => until > now));
    const time = new Date(soonest).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
    return chatError(`Quotas gratuits atteints. L’IA revient vers ${time}.`, 429, origin, {
      'Retry-After': String(Math.ceil((soonest - now) / 1000)), 'Access-Control-Expose-Headers': 'Retry-After',
    });
  }
  try {
    const { reasoning_effort: _effort, ...gemma } = params;
    const upstream = await env.AI.run(GEMMA_MODEL, gemma, { returnRawResponse: true });
    const result = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const code = Number(result?.internalCode ?? result?.errors?.[0]?.code);
      if (code === 3036) {
        await store.record({ type: 'blocked', model: GEMMA_MODEL, provider: 'cloudflare', until: nextReset('cloudflare', now), reason: 'quota du jour atteint' });
      }
      return chatUpstreamError(upstream.status, code, upstream.headers.get('Retry-After'), origin);
    }
    const answer = chatAnswer(result, GEMMA_MODEL);
    if (!answer) return unavailable();
    await store.record({ type: 'success', model: GEMMA_MODEL, provider: 'cloudflare', ...tokensOf(answer) });
    return reply(answer, 200, origin);
  } catch {
    return unavailable();
  }
}

/**
 * Paramètres transmis à Google, ou `null` si la demande sort du cadre : l'échange
 * du code (preuve PKCE et retour de la PWA exigés) ou le renouvellement. Tout
 * autre champ reçu est ignoré, un `client_secret` envoyé par l'appelant compris.
 */
function tokenParams(form) {
  const clientId = form.get('client_id') ?? '';
  if (!CLIENT_ID.test(clientId)) return null;
  if (form.get('grant_type') === 'authorization_code') {
    const code = form.get('code');
    const verifier = form.get('code_verifier');
    const redirect = form.get('redirect_uri') ?? '';
    if (!code || !verifier || !REDIRECTS.includes(redirect)) return null;
    return { client_id: clientId, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect };
  }
  if (form.get('grant_type') === 'refresh_token') {
    const token = form.get('refresh_token');
    return token ? { client_id: clientId, grant_type: 'refresh_token', refresh_token: token } : null;
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';
    if (url.pathname === '/ai/pdf') return pdfText(request, env, origin);
    if (url.pathname === '/ai/chat/completions') return chatCompletion(request, env, origin);
    if (url.pathname === '/ai/status') return aiStatus(request, env, origin);
    // Vérification à la main : ouvrir `/token` dans un navigateur.
    if (request.method === 'GET' && url.pathname === '/token') {
      return reply({ ok: true, configured: Boolean(env.GOOGLE_CLIENT_SECRET) }, 200);
    }
    // Ancienne PWA, favoris, politique liée depuis le desktop 0.88.0 : même page sur Pages.
    if (request.method === 'GET' || request.method === 'HEAD') return Response.redirect(PAGES + url.pathname + url.search, 301);
    if (!ORIGINS.includes(origin)) return reply({ error: 'forbidden_origin' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST' || url.pathname !== '/token') return reply({ error: 'not_found' }, 404, origin);
    if (!env.GOOGLE_CLIENT_SECRET) return reply({ error: 'relay_not_configured' }, 500, origin);
    const text = await request.text();
    const params = text.length <= MAX_BODY ? tokenParams(new URLSearchParams(text)) : null;
    if (!params) return reply({ error: 'invalid_request' }, 400, origin);
    let google;
    try {
      google = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, client_secret: env.GOOGLE_CLIENT_SECRET }),
      });
    } catch {
      return reply({ error: 'google_unreachable' }, 502, origin);
    }
    return reply(await google.json().catch(() => ({ error: 'invalid_google_response' })), google.status, origin);
  },
};
