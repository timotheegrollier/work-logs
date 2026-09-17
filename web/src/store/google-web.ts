import { ApiError, type GoogleBackup } from '../lib';
// @ts-expect-error — backup-format.js est du JavaScript pur partagé avec l'API.
import { OUTBOX_VERSION } from '../../../api/src/backup-format.js';

/**
 * Connexion directe à Google depuis le navigateur (PWA, sans serveur) : OAuth
 * autorisé par code + PKCE en `fetch`, sans SDK. Le client « Application Web »
 * DOIT vivre dans le même projet Google Cloud que le client desktop : le
 * périmètre `drive.file` est partagé par projet, donc les sauvegardes créées
 * sur le PC sont visibles ici (et inversement). Connexion facultative :
 * sans elle, les données restent simplement sur l'appareil.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const CLIENT_KEY = 'worklogs-google-web-client';
const TOKENS_KEY = 'worklogs-google-web-tokens';
const PENDING_KEY = 'worklogs-google-web-pending';

interface WebTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

interface PendingLogin {
  state: string;
  verifier: string;
  redirectUri: string;
}

let memory: WebTokens | null = null;
let refreshing: Promise<string> | null = null;

const fail = (message: string, code?: string, helpUrl?: string): never => {
  throw new ApiError(message, code, helpUrl);
};

export function getWebClientId(): string {
  try {
    return localStorage.getItem(CLIENT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** L'identifiant public du client « Web » (`…apps.googleusercontent.com`). */
export function setWebClientId(clientId: string): string {
  const cleaned = clientId.trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(cleaned)) {
    fail('Identifiant client Google invalide (…apps.googleusercontent.com attendu).');
  }
  try {
    localStorage.setItem(CLIENT_KEY, cleaned);
  } catch {
    fail('Stockage local indisponible : impossible de conserver la configuration Google.');
  }
  return cleaned;
}

export function webRedirectUri(): string {
  return `${location.origin}${location.pathname}`;
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(length = 48): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function pkceChallenge(verifier: string, subtle: Pick<SubtleCrypto, 'digest'> | undefined = globalThis.crypto?.subtle): Promise<string> {
  if (!subtle) fail('Contexte non sécurisé : la connexion Google exige HTTPS ou localhost.');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** URL d'autorisation Google (pure : `beginWebLogin` y envoie le navigateur). */
export function loginUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state,
    code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  return url.href;
}

/** Démarre la connexion : mémorise l'état anti-rejeu puis quitte vers Google. */
export async function beginWebLogin(clientId: string): Promise<void> {
  const cleaned = setWebClientId(clientId);
  const state = randomString(32);
  const verifier = randomString(64);
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, verifier, redirectUri: webRedirectUri() }));
  } catch {
    fail('Stockage de session indisponible : impossible de démarrer la connexion Google.');
  }
  location.assign(loginUrl(cleaned, webRedirectUri(), state, await pkceChallenge(verifier)));
}

function readTokens(): WebTokens | null {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WebTokens;
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) return null;
    memory = parsed;
    return memory;
  } catch {
    return null;
  }
}

function writeTokens(tokens: WebTokens | null): void {
  memory = tokens;
  try {
    if (tokens) localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    else localStorage.removeItem(TOKENS_KEY);
  } catch {
    // Stockage plein ou privé : la session en mémoire reste utilisable.
  }
}

async function tokenRequest(params: Record<string, string>): Promise<WebTokens> {
  const clientId = getWebClientId();
  if (!clientId) fail('Configure d’abord l’identifiant client Google.');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...params }),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (result['error'] === 'invalid_grant') writeTokens(null);
    fail(
      result['error'] === 'invalid_grant'
        ? 'Autorisation Google expirée ou révoquée. Reconnecte Google Drive.'
        : 'Google a refusé la connexion. Vérifie l’identifiant client et les URI de redirection.'
    );
  }
  if (typeof result['access_token'] !== 'string' || !result['access_token']) fail('Réponse de connexion Google invalide.');
  if (typeof result['scope'] === 'string' && !result['scope'].split(' ').includes(SCOPE)) {
    fail('L’accès aux documents sélectionnés n’a pas été accordé.');
  }
  return {
    access_token: result['access_token'] as string,
    ...(typeof result['refresh_token'] === 'string' ? { refresh_token: result['refresh_token'] } : {}),
    ...(typeof result['scope'] === 'string' ? { scope: result['scope'] } : {}),
    expires_at: Date.now() + Number(result['expires_in'] || 3600) * 1000,
  };
}

/**
 * Traite le retour de Google (`?code=…&state=…`) au chargement. À appeler une
 * fois, puis à nettoyer l'URL (`history.replaceState`). Renvoie `false` s'il
 * n'y a aucun retour à traiter.
 */
export async function handleRedirectCallback(search = location.search): Promise<boolean> {
  const params = new URLSearchParams(search.startsWith('?') ? search : '');
  if (!params.has('code') && !params.has('error')) return false;
  let pending: PendingLogin | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? '') as PendingLogin;
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    pending = null;
  }
  const login: PendingLogin =
    !pending || params.get('state') !== pending.state ? fail('Retour Google invalide : recommence la connexion.') : pending;
  if (params.has('error')) fail('Connexion Google annulée.');
  const code = params.get('code') ?? fail('Code de connexion Google absent.');
  writeTokens(await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: login.verifier, redirect_uri: login.redirectUri }));
  return true;
}

export async function webAccessToken(): Promise<string> {
  const tokens = readTokens() ?? fail('Connecte Google Drive pour continuer.');
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  if (!tokens.refresh_token) {
    writeTokens(null);
    fail('Reconnecte Google Drive pour renouveler l’autorisation.');
  }
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token as string })
    .then((next) => {
      writeTokens({ ...tokens, ...next });
      return (memory as WebTokens).access_token;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Erreurs Google → messages français, mêmes codes que `desktop/google.mjs`. */
export function mapGoogleError(status: number, body: { error?: { errors?: { reason?: string }[]; details?: { reason?: string; metadata?: { service?: string; consumer?: string } }[] } }, apiPath: string): never {
  const details = body.error?.details || [];
  const reasons = [...(body.error?.errors || []).map((e) => e.reason), ...details.map((e) => e.reason)];
  if (reasons.some((reason) => ['SERVICE_DISABLED', 'accessNotConfigured'].includes(reason ?? ''))) {
    const service = apiPath.startsWith('/docs/') ? 'docs.googleapis.com' : 'drive.googleapis.com';
    const consumer = details.find((d) => d.metadata?.service === service)?.metadata?.consumer;
    const project = /^projects\/(\d+)$/.exec(consumer || '')?.[1] || /^(\d+)-/.exec(getWebClientId())?.[1];
    const help = new URL(`https://console.cloud.google.com/apis/library/${service}`);
    if (project) help.searchParams.set('project', project);
    fail(`L’API Google ${service.startsWith('docs') ? 'Docs' : 'Drive'} est désactivée dans ton projet Google Cloud. Active-la, attends quelques instants, puis réessaie.`, 'GOOGLE_API_DISABLED', help.href);
  }
  if (reasons.some((reason) => ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'RESOURCE_EXHAUSTED'].includes(reason ?? '')) || status === 429) {
    fail('La limite de requêtes Google est atteinte. Réessaie dans quelques instants.', 'GOOGLE_RATE_LIMIT');
  }
  if (reasons.some((reason) => ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions'].includes(reason ?? ''))) {
    fail('L’autorisation Google est incomplète. Reconnecte Google Drive.', 'GOOGLE_SCOPE_REQUIRED');
  }
  if (status === 401) fail('Autorisation Google expirée. Reconnecte Google Drive.');
  if (status === 403) fail('Accès Google refusé : vérifie que le client Web est dans le même projet que le desktop.');
  if (status === 404) fail('Fichier Google introuvable ou non autorisé.');
  throw new ApiError('Google a refusé la requête. Réessaie dans quelques instants.');
}

export async function webGoogleRequest(
  apiPath: string,
  options: { method?: string; body?: BodyInit; headers?: Record<string, string>; responseType?: 'json' | 'text' } = {}
): Promise<unknown> {
  if (!/^\/(?:upload\/)?(?:drive\/v3\/|docs\/v1\/)/.test(apiPath)) fail('Adresse Google non autorisée.');
  const url = apiPath.startsWith('/docs/')
    ? `https://docs.googleapis.com${apiPath.slice(5)}`
    : `https://www.googleapis.com${apiPath}`;
  const token = await webAccessToken();
  const response = await fetch(url, {
    method: options.method,
    body: options.body,
    headers: { Authorization: `Bearer ${token}`, ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  if (options.responseType === 'text') {
    const text = await response.text();
    if (!response.ok) {
      try {
        mapGoogleError(response.status, JSON.parse(text), apiPath);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        mapGoogleError(response.status, {}, apiPath);
      }
    }
    return text;
  }
  const body = (await response.json().catch(() => ({}))) as Parameters<typeof mapGoogleError>[1];
  if (!response.ok) mapGoogleError(response.status, body, apiPath);
  return body;
}

export function webGoogleStatus(): { configured: boolean; connected: boolean } {
  return { configured: getWebClientId() !== '', connected: readTokens() !== null };
}

export function disconnectWeb(): void {
  writeTokens(null);
}

/** Sauvegardes WorkLogs visibles par ce projet (les mêmes que sur le PC). */
export async function listWebBackups(): Promise<GoogleBackup[]> {
  const params = new URLSearchParams({
    q: "appProperties has { key='worklogs_type' and value='backup' } and trashed=false",
    fields: 'files(id,name,modifiedTime,size,mimeType),nextPageToken',
    orderBy: 'modifiedTime desc',
    pageSize: '100',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const result = (await webGoogleRequest(`/drive/v3/files?${params}`)) as {
    files?: { id: string; name: string; modifiedTime?: string; size?: string | number; mimeType?: string }[];
  };
  return (result.files || [])
    .filter((file) => file.mimeType === 'application/json' || !file.mimeType)
    .map((file) => ({ id: file.id, name: file.name, modifiedTime: file.modifiedTime || '', size: file.size === undefined ? null : Number(file.size) }));
}

/** Télécharge et parse une sauvegarde (la validation a lieu à l'import). */
export async function downloadWebBackup(id: string): Promise<unknown> {
  if (typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id)) fail('Identifiant de document Google invalide.');
  const text = (await webGoogleRequest(`/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { responseType: 'text' })) as string;
  if (new Blob([text]).size > MAX_BACKUP_BYTES) fail('La sauvegarde Google est trop volumineuse (20 Mo max).');
  try {
    return JSON.parse(text);
  } catch {
    fail('Le contenu de cette sauvegarde Google est invalide.');
  }
}

/**
 * Envoie un binaire sur Drive (multipart `related`, vrais CRLF comme
 * `multipartBackup` côté serveur). Les photos de la PWA partent ainsi, une
 * par une, avant le JSON qui les référence.
 */
export async function uploadDriveFile({ name, mimeType, data, appProperties }: {
  name: string; mimeType: string; data: Blob; appProperties: Record<string, string>;
}): Promise<{ id: string; name: string }> {
  if (!name.trim() || name.length > 240) fail('Nom de fichier Google invalide.');
  const boundary = `worklogs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name, mimeType, appProperties });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    data,
    `\r\n--${boundary}--\r\n`,
  ]);
  const result = (await webGoogleRequest(
    '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name',
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
  )) as { id?: string; name?: string };
  const id = result?.id ?? fail('Google n’a pas confirmé l’envoi du fichier.');
  return { id, name: result?.name || name };
}

/** Envoie la boîte mobile (JSON v1) : le PC la fusionnera sans rien écraser. */
export async function uploadOutbox(payload: { version: number }): Promise<{ id: string; name: string }> {
  const name = `WorkLogs outbox ${new Date().toISOString().replace(/[T:.]/g, '-').replace(/Z$/, '')}.json`;
  return uploadDriveFile({
    name,
    mimeType: 'application/json',
    data: new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    appProperties: { worklogs_type: 'outbox', worklogs_version: String(OUTBOX_VERSION) },
  });
}
