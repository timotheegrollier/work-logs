import { ApiError, type GoogleBackup } from '../lib';
// @ts-expect-error — backup-format.js est du JavaScript pur partagé avec l'API.
import { BACKUP_NAME, BACKUP_VERSION, MAX_BACKUP_BYTES, OUTBOX_VERSION } from '../../../api/src/backup-format.js';

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
// Identité en plus de Drive : afficher le compte connecté, rien d'autre.
const LOGIN_SCOPE = [SCOPE, 'openid', 'email', 'profile'].join(' ');
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CLIENT_ID = /^[\w.-]+\.apps\.googleusercontent\.com$/;
const CLIENT_KEY = 'worklogs-google-web-client';
const CLIENT_SECRET_KEY = 'worklogs-google-web-secret';
const TOKENS_KEY = 'worklogs-google-web-tokens';
const PENDING_KEY = 'worklogs-google-web-pending';

export interface GoogleAccount {
  email: string;
  name: string;
  /** Photo du compte (`…googleusercontent.com`), vide sinon. */
  picture?: string;
}

interface WebTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  account?: GoogleAccount | null;
}

interface PendingLogin {
  state: string;
  /** Absent : flux « jeton » sans secret (client intégré). */
  verifier?: string;
  redirectUri: string;
}

let memory: WebTokens | null = null;
let refreshing: Promise<string> | null = null;

const fail = (message: string, code?: string, helpUrl?: string): never => {
  throw new ApiError(message, code, helpUrl);
};

/** Client « Web » personnel collé en Paramètres (prioritaire sur l'intégré). */
export function getWebClientId(): string {
  try {
    return localStorage.getItem(CLIENT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Client « Web » intégré au build (`VITE_GOOGLE_CLIENT_ID`) : un ID client est public. */
export function builtinWebClientId(): string {
  const value = String(import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
  return CLIENT_ID.test(value) ? value : '';
}

export function activeWebClientId(): string {
  return getWebClientId() || builtinWebClientId();
}

/** Oublie le client personnel : retour au client intégré, session effacée. */
export function clearWebClient(): void {
  try {
    localStorage.removeItem(CLIENT_KEY);
    localStorage.removeItem(CLIENT_SECRET_KEY);
  } catch {
    // Stockage indisponible : rien à oublier.
  }
  writeTokens(null);
}

/** L'identifiant public du client « Web » (`…apps.googleusercontent.com`). */
export function setWebClientId(clientId: string): string {
  const cleaned = clientId.trim();
  if (!CLIENT_ID.test(cleaned)) {
    fail('Identifiant client Google invalide (…apps.googleusercontent.com attendu).');
  }
  try {
    localStorage.setItem(CLIENT_KEY, cleaned);
  } catch {
    fail('Stockage local indisponible : impossible de conserver la configuration Google.');
  }
  return cleaned;
}

/**
 * Le secret du client « Web » (console Google Cloud → fiche du client). Google
 * l'exige à l'échange du code pour un client confidentiel, contrairement au
 * client desktop. Stocké localement comme les jetons, jamais affiché ni envoyé
 * ailleurs qu'à Google.
 */
export function getWebClientSecret(): string {
  try {
    return localStorage.getItem(CLIENT_SECRET_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setWebClientSecret(secret: string): string {
  const cleaned = secret.trim();
  if (cleaned && cleaned.length > 500) fail('Secret client Google invalide.');
  try {
    if (cleaned) localStorage.setItem(CLIENT_SECRET_KEY, cleaned);
    else localStorage.removeItem(CLIENT_SECRET_KEY);
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
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: LOGIN_SCOPE,
    access_type: 'offline', prompt: 'select_account consent', state,
    code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  return url.href;
}

/**
 * Flux « jeton » sans secret : le seul possible dans un site public. Le jeton
 * dure une heure ; `login_hint` rend la reprise immédiate (pas de consentement
 * redemandé une fois accordé).
 */
export function tokenLoginUrl(clientId: string, redirectUri: string, state: string, hint = '', selectAccount = false): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'token', scope: LOGIN_SCOPE,
    include_granted_scopes: 'true', state,
    // Changer de compte : le sélecteur Google, sans suggérer l'ancien compte.
    ...(selectAccount ? { prompt: 'select_account' } : hint ? { login_hint: hint } : {}),
  }).toString();
  return url.href;
}

function rememberPending(login: PendingLogin): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(login));
  } catch {
    fail('Stockage de session indisponible : impossible de démarrer la connexion Google.');
  }
}

/**
 * Démarre la connexion puis quitte vers Google. Sans argument : client intégré
 * (ou personnel déjà enregistré). Avec un secret personnel : code + PKCE,
 * session longue ; sinon flux « jeton » d'une heure.
 */
export async function beginWebLogin(clientId = '', options: { selectAccount?: boolean } = {}): Promise<void> {
  const cleaned = clientId ? setWebClientId(clientId) : activeWebClientId() || fail('Aucun client Google configuré.');
  const state = randomString(32);
  if (!getWebClientSecret()) {
    rememberPending({ state, redirectUri: webRedirectUri() });
    location.assign(tokenLoginUrl(cleaned, webRedirectUri(), state, readTokens()?.account?.email ?? '', options.selectAccount));
    return;
  }
  const verifier = randomString(64);
  rememberPending({ state, verifier, redirectUri: webRedirectUri() });
  location.assign(loginUrl(cleaned, webRedirectUri(), state, await pkceChallenge(verifier)));
}

/** Nom et e-mail du compte, pour l'affichage seulement ; un échec n'empêche pas Drive. */
async function fetchAccount(accessToken: string): Promise<GoogleAccount | null> {
  try {
    const response = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return null;
    const info = (await response.json()) as { email?: unknown; name?: unknown; picture?: unknown };
    if (typeof info.email !== 'string' || !info.email) return null;
    const picture = typeof info.picture === 'string' && /^https:\/\/[\w.-]+\.googleusercontent\.com\//.test(info.picture) ? info.picture.slice(0, 2000) : '';
    return { email: info.email.slice(0, 320), name: typeof info.name === 'string' ? info.name.slice(0, 200) : '', picture };
  } catch {
    return null;
  }
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
  const clientId = activeWebClientId();
  if (!clientId) fail('Configure d’abord l’identifiant client Google.');
  const secret = getWebClientSecret();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...(secret ? { client_secret: secret } : {}), ...params }),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (result['error'] === 'invalid_grant') writeTokens(null);
    // Détail technique en console uniquement : l'interface reste en français
    // sans exposer le message brut (comme `desktop/google.mjs`).
    console.warn('[worklogs] Google a refusé les jetons :', result['error'], result['error_description']);
    fail(
      result['error'] === 'invalid_grant'
        ? 'Autorisation Google expirée ou révoquée. Reconnecte Google Drive.'
        : 'Google a refusé la connexion. Vérifie l’identifiant client, le secret et les URI de redirection.'
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

/** Y a-t-il un retour de Google à traiter dans l'URL (requête ou fragment) ? */
export function hasRedirectCallback(search = location.search, hash = location.hash): boolean {
  const query = new URLSearchParams(search.startsWith('?') ? search : '');
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : '');
  return query.has('code') || query.has('error') || fragment.has('access_token') || (fragment.has('error') && fragment.has('state'));
}

/**
 * Traite le retour de Google au chargement : `?code=…` (client avec secret) ou
 * `#access_token=…` (flux « jeton »). À appeler une fois, puis à nettoyer
 * l'URL (`history.replaceState`). Renvoie `false` s'il n'y a rien à traiter.
 */
export async function handleRedirectCallback(search = location.search, hash = location.hash): Promise<boolean> {
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : '');
  const tokenFlow = fragment.has('access_token') || (fragment.has('error') && fragment.has('state'));
  const params = tokenFlow ? fragment : new URLSearchParams(search.startsWith('?') ? search : '');
  if (!tokenFlow && !params.has('code') && !params.has('error')) return false;
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
  if (tokenFlow) {
    const scope = params.get('scope') ?? '';
    if (scope && !scope.split(' ').includes(SCOPE)) fail('L’accès aux documents sélectionnés n’a pas été accordé.');
    const access = params.get('access_token') ?? fail('Réponse de connexion Google invalide.');
    const previous = readTokens()?.account ?? null;
    writeTokens({
      access_token: access,
      expires_at: Date.now() + Number(params.get('expires_in') || 3600) * 1000,
      ...(scope ? { scope } : {}),
      account: (await fetchAccount(access)) ?? previous,
    });
    return true;
  }
  if (!login.verifier) fail('Retour Google invalide : recommence la connexion.');
  const code = params.get('code') ?? fail('Code de connexion Google absent.');
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: login.verifier as string, redirect_uri: login.redirectUri });
  writeTokens({ ...tokens, account: await fetchAccount(tokens.access_token) });
  return true;
}

/** Session « jeton » expirée : l'UI propose de la reprendre (une redirection éclair). */
export const GOOGLE_REAUTH = 'GOOGLE_REAUTH';

export async function webAccessToken(): Promise<string> {
  const tokens = readTokens() ?? fail('Connecte Google Drive pour continuer.');
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  if (!tokens.refresh_token) {
    // On garde le compte : la reprise se fait en un clic, sans rien ressaisir.
    fail('Session Google expirée : reprends-la en un clic dans le panneau Drive.', GOOGLE_REAUTH);
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
  if (status === 401) {
    const tokens = readTokens();
    if (tokens && !tokens.refresh_token) {
      // Jeton révoqué ou expiré plus tôt que prévu : même reprise en un clic.
      writeTokens({ ...tokens, expires_at: 0 });
      fail('Session Google expirée : reprends-la en un clic dans le panneau Drive.', GOOGLE_REAUTH);
    }
    fail('Autorisation Google expirée. Reconnecte Google Drive.');
  }
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

/** Télécharge un binaire Drive (pièce jointe adossée) : Blob prêt à stocker. */
export async function downloadDriveBinary(driveFileId: string): Promise<Blob> {
  if (!/^[\w-]{1,200}$/.test(driveFileId)) fail('Identifiant de document Google invalide.');
  const token = await webAccessToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) mapGoogleError(response.status, {}, `/drive/v3/files/${driveFileId}`);
  return response.blob();
}

export function webGoogleStatus(): {
  configured: boolean; connected: boolean; builtin: boolean; account: GoogleAccount | null; expired: boolean;
} {
  const tokens = readTokens();
  return {
    configured: activeWebClientId() !== '',
    connected: tokens !== null,
    builtin: getWebClientId() === '' && builtinWebClientId() !== '',
    account: tokens?.account ?? null,
    expired: tokens !== null && !tokens.refresh_token && tokens.expires_at <= Date.now() + 60_000,
  };
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
export async function uploadDriveFile({ name, mimeType, data, appProperties, parent = null }: {
  name: string; mimeType: string; data: Blob; appProperties: Record<string, string>; parent?: string | null;
}): Promise<{ id: string; name: string }> {
  if (!name.trim() || name.length > 240) fail('Nom de fichier Google invalide.');
  const boundary = `worklogs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name, mimeType, appProperties, ...(parent ? { parents: [parent] } : {}) });
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

const FOLDER_MIME = 'application/vnd.google-apps.folder';
let folderPromise: Promise<string | null> | null = null;

/**
 * Dossier `WorkLogs/Pièces jointes` (le même que le desktop, retrouvé par étiquette),
 * créé au besoin. `null` si Google refuse : le fichier part à la racine plutôt que
 * de rester bloqué sur l'appareil.
 */
export function attachmentFolderId(): Promise<string | null> {
  folderPromise ??= (async () => {
    const find = async (type: string) => {
      const params = new URLSearchParams({
        q: `mimeType='${FOLDER_MIME}' and appProperties has { key='worklogs_type' and value='${type}' } and trashed=false`,
        fields: 'files(id)', pageSize: '1', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      });
      return ((await webGoogleRequest(`/drive/v3/files?${params}`)) as { files?: { id: string }[] }).files?.[0]?.id || null;
    };
    const create = async (name: string, type: string, parent: string | null) =>
      ((await webGoogleRequest('/drive/v3/files?supportsAllDrives=true&fields=id', {
        method: 'POST',
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, appProperties: { worklogs_type: type }, ...(parent ? { parents: [parent] } : {}) }),
      })) as { id?: string }).id || null;
    const existing = await find('attachments-folder');
    if (existing) return existing;
    const root = (await find('root-folder')) || (await create('WorkLogs', 'root-folder', null));
    return create('Pièces jointes', 'attachments-folder', root);
  })().catch(() => {
    folderPromise = null;
    return null;
  });
  return folderPromise;
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

/**
 * Envoie une sauvegarde complète (JSON v2) : comme le desktop, elle réécrit le
 * fichier canonique `WorkLogs backup.json` (PATCH) ou le crée (POST), pour que
 * le PC la retrouve dans ses sauvegardes et puisse la restaurer.
 */
export async function saveBackupJson(jsonText: string): Promise<{ id: string; name: string; modifiedTime?: string }> {
  if (new Blob([jsonText]).size > MAX_BACKUP_BYTES) fail('La sauvegarde est trop volumineuse (20 Mo max).');
  const existing = await listWebBackups();
  const canonical = existing.find((file) => file.name === BACKUP_NAME) || existing[0];
  const boundary = `worklogs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name: BACKUP_NAME, mimeType: 'application/json',
    appProperties: { worklogs_type: 'backup', worklogs_version: String(BACKUP_VERSION) } });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    jsonText,
    `\r\n--${boundary}--\r\n`,
  ]);
  const target = canonical?.id
    ? `/upload/drive/v3/files/${encodeURIComponent(canonical.id)}?uploadType=multipart&supportsAllDrives=true&fields=id,name,modifiedTime`
    : '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,modifiedTime';
  const result = (await webGoogleRequest(target, {
    method: canonical?.id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })) as { id?: string; name?: string; modifiedTime?: string };
  const id = result?.id ?? fail('Google n’a pas confirmé l’enregistrement de la sauvegarde.');
  return { id, name: result?.name || BACKUP_NAME, ...(typeof result?.modifiedTime === 'string' ? { modifiedTime: result.modifiedTime } : {}) };
}
