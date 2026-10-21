import { ApiError } from '../lib';
import { clearRelayForgotten, normalizeRelayUrl, readRelay, relayForgottenAt, saveRelay, type RelaySettings } from '../relay-settings';
import { base64url, relayKeyUrl, webAccessToken, webGoogleRequest, webGoogleStatus, worklogsFolderId } from './google-web';

/**
 * Accès au relais du dossier partagé gardé dans le compte Google (§29) : quand le
 * téléphone l'a perdu, il revient tout seul à la connexion Google.
 *
 * Le fichier `WorkLogs/WorkLogs relais.json` ne contient que du chiffré (AES-GCM).
 * La clé n'est stockée nulle part : le Worker (`/relay-key`) la recalcule pour le
 * seul compte connecté avec le client intégré. Lire le fichier Drive ne suffit donc
 * pas à lire le code. Il vit à part de `WorkLogs backup.json` : le desktop réécrit
 * celui-ci sans connaître le relais, et l'export téléchargé ne doit pas l'emporter.
 */
export const RELAY_FILE_NAME = 'WorkLogs relais.json';
const RELAY_TYPE = 'relay';
/** Lie le chiffré à son usage : une autre copie chiffrée avec la même clé ne passe pas pour celle-ci. */
const AAD = new TextEncoder().encode('worklogs-relais-v1');

/**
 * `restored` : l'accès est revenu de Google ; `saved` / `removed` : la copie a suivi
 * ce téléphone ; `unavailable` : pas de compte connecté avec le client intégré.
 */
export type RelayVaultResult = 'restored' | 'saved' | 'removed' | 'unchanged' | 'unavailable';

export function relayVaultAvailable(): boolean {
  const google = webGoogleStatus();
  return google.connected && !google.expired && relayKeyUrl() !== '';
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function accountKey(): Promise<CryptoKey> {
  const token = await webAccessToken();
  let body: { key?: unknown } = {};
  let ok = false;
  try {
    const response = await fetch(relayKeyUrl(), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    ok = response.ok;
    body = (await response.json().catch(() => ({}))) as { key?: unknown };
  } catch {
    // Réseau coupé : même message que le refus.
  }
  if (!ok || typeof body.key !== 'string') throw new ApiError('Clé du compte Google indisponible : l’accès au relais reste sur ce téléphone.');
  const raw = fromBase64url(body.key);
  if (raw.length !== 32) throw new ApiError('Clé du compte Google invalide.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(key: CryptoKey, settings: RelaySettings): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ url: settings.url, token: settings.token, saved_at: settings.saved_at || '' }));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plain));
  return JSON.stringify({ version: 1, iv: base64url(iv), data: base64url(data) });
}

/** `null` si la copie est illisible : abîmée, ou chiffrée avec une autre clé (secret du Worker changé). */
async function unseal(key: CryptoKey, text: string): Promise<RelaySettings | null> {
  try {
    const envelope = JSON.parse(text) as { version?: unknown; iv?: unknown; data?: unknown };
    if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(envelope.iv), additionalData: AAD }, key, fromBase64url(envelope.data)
    );
    const value = JSON.parse(new TextDecoder().decode(plain)) as { url?: unknown; token?: unknown; saved_at?: unknown };
    if (typeof value.url !== 'string' || typeof value.token !== 'string' || value.token.length < 32) return null;
    return { url: normalizeRelayUrl(value.url), token: value.token, saved_at: typeof value.saved_at === 'string' ? value.saved_at : '' };
  } catch {
    return null;
  }
}

async function findRelayFile(): Promise<string | null> {
  const params = new URLSearchParams({
    q: `appProperties has { key='worklogs_type' and value='${RELAY_TYPE}' } and trashed=false`,
    fields: 'files(id)', orderBy: 'modifiedTime desc', pageSize: '1', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
  });
  return ((await webGoogleRequest(`/drive/v3/files?${params}`)) as { files?: { id: string }[] }).files?.[0]?.id || null;
}

async function writeRelayFile(id: string | null, text: string): Promise<void> {
  const parent = id ? null : await worklogsFolderId();
  const boundary = `worklogs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({
    name: RELAY_FILE_NAME, mimeType: 'application/json', appProperties: { worklogs_type: RELAY_TYPE, worklogs_version: '1' },
    ...(parent ? { parents: [parent] } : {}),
  });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    text,
    `\r\n--${boundary}--\r\n`,
  ]);
  await webGoogleRequest(
    id
      ? `/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=multipart&supportsAllDrives=true&fields=id`
      : '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',
    { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
  );
}

async function trashRelayFile(id: string): Promise<void> {
  await webGoogleRequest(`/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`, {
    method: 'PATCH', body: JSON.stringify({ trashed: true }),
  });
}

const same = (a: RelaySettings, b: RelaySettings) => a.url === b.url && a.token === b.token;

let queue: Promise<unknown> = Promise.resolve();

/**
 * Met d'accord ce téléphone et la copie du compte : le plus récent gagne
 * (`saved_at`). Rien ici → la copie revient, sauf si ce téléphone l'a oubliée
 * depuis (elle part alors à la corbeille). Lève une erreur si Google ou le Worker
 * ne répondent pas : à l'appelant de réessayer plus tard. Un appel à la fois :
 * « Enregistrer » pendant une synchro ne crée pas deux fichiers.
 */
export function syncRelayVault(): Promise<RelayVaultResult> {
  const next = queue.then(reconcile, reconcile);
  queue = next.catch(() => {});
  return next;
}

async function reconcile(): Promise<RelayVaultResult> {
  if (!relayVaultAvailable()) return 'unavailable';
  const local = readRelay();
  const forgotten = relayForgottenAt();
  const id = await findRelayFile();
  if (!local && !id) {
    clearRelayForgotten();
    return 'unchanged';
  }
  const key = await accountKey();
  const remote = id ? await unseal(key, (await webGoogleRequest(`/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { responseType: 'text' })) as string) : null;
  if (!local) {
    if (remote && (!forgotten || (remote.saved_at || '') > forgotten)) {
      saveRelay(remote);
      return 'restored';
    }
    // Oublié ici après la copie, ou copie illisible : elle ne sert plus à rien.
    if (id) await trashRelayFile(id);
    clearRelayForgotten();
    return id ? 'removed' : 'unchanged';
  }
  if (remote && same(remote, local)) return 'unchanged';
  if (remote && (remote.saved_at || '') > (local.saved_at || '')) {
    saveRelay(remote);
    return 'restored';
  }
  await writeRelayFile(id, await seal(key, local));
  return 'saved';
}
