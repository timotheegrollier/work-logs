// Relais de jetons Google de la PWA WorkLogs — Cloudflare Worker, sans dépendance.
//
// Google exige le secret d'un client OAuth « Application Web » pour échanger le
// code de connexion et pour renouveler la session (`client_secret is missing`
// sinon, mesuré le 2026-09-23). La PWA est un site public : elle ne peut pas le
// détenir. Ce relais l'ajoute, et rien d'autre : deux échanges autorisés, la
// seule PWA comme origine et comme retour, rien de stocké ni de journalisé.
// Déploiement et vérification : docs/08-GOOGLE-DOCS.md « Relais de jetons ».
// Seul `default` est exporté : workerd prend tout autre export pour un point d'entrée.

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Origines autorisées : la PWA publiée, et le serveur Vite en dev. */
const ORIGINS = ['https://timotheegrollier.github.io', 'http://localhost:8411'];
/** URI de retour enregistrées dans Google Cloud pour le client Web. */
const REDIRECTS = ['https://timotheegrollier.github.io/work-logs/', 'http://localhost:8411/'];
const CLIENT_ID = /^[\w.-]+\.apps\.googleusercontent\.com$/;
const MAX_BODY = 8192;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Vérification à la main : ouvrir l'adresse du relais dans un navigateur.
    if (request.method === 'GET' && url.pathname === '/') {
      return reply({ ok: true, configured: Boolean(env.GOOGLE_CLIENT_SECRET) }, 200);
    }
    const origin = request.headers.get('Origin') ?? '';
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
