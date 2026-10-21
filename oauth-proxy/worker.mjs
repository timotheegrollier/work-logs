// Relais de jetons Google de la PWA WorkLogs — Cloudflare Worker, sans dépendance.
// Depuis l'option B, ce même Worker sert aussi le front statique (`web/dist/`,
// voir `[assets]` dans `wrangler.toml`) : la PWA est à `/`, le relais à `/token`.
// Vérification : ouvrir `/token` dans un navigateur (`{"ok":true,…}`).
//
// Google exige le secret d'un client OAuth « Application Web » pour échanger le
// code de connexion et pour renouveler la session (`client_secret is missing`
// sinon, mesuré le 2026-09-23). La PWA est un site public : elle ne peut pas le
// détenir. Ce relais l'ajoute, et rien d'autre : deux échanges autorisés, la
// seule PWA comme origine et comme retour, rien de stocké ni de journalisé.
// Déploiement et vérification : docs/08-GOOGLE-DOCS.md « Relais de jetons ».
//
// `POST /relay-key` (§29) : la clé qui chiffre, dans le Drive du compte, l'accès au
// relais du dossier partagé. Elle n'est stockée nulle part : HMAC du secret et de
// l'identifiant Google du compte, rendue à la seule PWA connectée à ce compte avec
// le client intégré. Le fichier Drive seul ne suffit donc pas à lire le code.
// Seul `default` est exporté : workerd prend tout autre export pour un point d'entrée.

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
/** Séparation de domaine : cette clé ne sert qu'à l'accès au relais, version 1. */
const RELAY_KEY_INFO = 'worklogs-relais-v1:';
/**
 * Origines autorisées : la PWA servie par ce Worker (option B, même URL que le
 * relais), l'ancienne PWA GitHub Pages (transition) et le serveur Vite en dev.
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

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function reply(body, status, origin = '') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(origin ? cors(origin) : {}) },
  });
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

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Clé du compte : le jeton d'accès présenté est vérifié par Google (`tokeninfo`) —
 * émis pour le client intégré (`GOOGLE_CLIENT_ID`), encore valide. La clé dépend du
 * compte (`sub`) : un autre compte, même connecté à la PWA, obtient une autre clé.
 */
async function relayKey(request, env, origin) {
  if (!env.GOOGLE_CLIENT_SECRET || !CLIENT_ID.test(env.GOOGLE_CLIENT_ID ?? '')) return reply({ error: 'relay_not_configured' }, 500, origin);
  const token = /^Bearer ([\w.~+/-]{10,4096}=*)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) return reply({ error: 'unauthorized' }, 401, origin);
  let info;
  try {
    const google = await fetch(`${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(token)}`);
    if (!google.ok) return reply({ error: 'unauthorized' }, 401, origin);
    info = await google.json();
  } catch {
    return reply({ error: 'google_unreachable' }, 502, origin);
  }
  if (info?.aud !== env.GOOGLE_CLIENT_ID || typeof info.sub !== 'string' || !info.sub || !(Number(info.expires_in) > 0)) {
    return reply({ error: 'unauthorized' }, 401, origin);
  }
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey('raw', encoder.encode(env.GOOGLE_CLIENT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const key = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, encoder.encode(RELAY_KEY_INFO + info.sub)));
  return reply({ key: base64url(key) }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Vérification à la main : ouvrir `/token` dans un navigateur. En production
    // `/` sert la PWA (assets, sans passer par ce code), donc la sonde vit sur
    // `/token` ; `/` n'est gardé que pour `wrangler dev` sans assets.
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/token')) {
      return reply({ ok: true, configured: Boolean(env.GOOGLE_CLIENT_SECRET) }, 200);
    }
    const origin = request.headers.get('Origin') ?? '';
    if (!ORIGINS.includes(origin)) return reply({ error: 'forbidden_origin' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method === 'POST' && url.pathname === '/relay-key') return relayKey(request, env, origin);
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
