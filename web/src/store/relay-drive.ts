import { clearRelayForgotten, normalizeRelayUrl, readRelay, relayForgottenAt, saveRelay, type RelaySettings } from '../relay-settings';
import { webGoogleRequest, webGoogleStatus, worklogsFolderId } from './google-web';

/**
 * Adresse du relais du dossier partagé gardée dans le compte Google (§55) : quand
 * le téléphone l'a perdue, elle revient toute seule à la connexion Google.
 *
 * `WorkLogs/WorkLogs relais.json` la garde **en clair** : sans code d'accès, elle
 * n'ouvre rien hors du réseau Tailscale. Il vit à part de `WorkLogs backup.json` :
 * le desktop réécrit celui-ci sans connaître le relais (le champ y serait perdu).
 */
export const RELAY_FILE_NAME = 'WorkLogs relais.json';
const RELAY_TYPE = 'relay';

/**
 * `restored` : l'adresse est revenue de Google ; `saved` / `removed` : la copie a
 * suivi ce téléphone ; `unavailable` : pas de compte Google connecté.
 */
export type RelayVaultResult = 'restored' | 'saved' | 'removed' | 'unchanged' | 'unavailable';

export function relayVaultAvailable(): boolean {
  const google = webGoogleStatus();
  return google.connected && !google.expired;
}

/** `null` si la copie est illisible : abîmée, ou l'ancienne copie chiffrée avec le code (§39). */
function parseCopy(text: string): RelaySettings | null {
  try {
    const value = JSON.parse(text) as { url?: unknown; saved_at?: unknown };
    if (typeof value.url !== 'string') return null;
    return { url: normalizeRelayUrl(value.url), saved_at: typeof value.saved_at === 'string' ? value.saved_at : '' };
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
    name: RELAY_FILE_NAME, mimeType: 'application/json', appProperties: { worklogs_type: RELAY_TYPE, worklogs_version: '2' },
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

let queue: Promise<unknown> = Promise.resolve();

/**
 * Met d'accord ce téléphone et la copie du compte : le plus récent gagne
 * (`saved_at`). Rien ici → la copie revient, sauf si ce téléphone l'a oubliée
 * depuis (elle part alors à la corbeille). Lève une erreur si Google ne répond
 * pas : à l'appelant de réessayer plus tard. Un appel à la fois : « Enregistrer »
 * pendant une synchro ne crée pas deux fichiers.
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
  const remote = id ? parseCopy((await webGoogleRequest(`/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { responseType: 'text' })) as string) : null;
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
  if (remote && remote.url === local.url) return 'unchanged';
  if (remote && (remote.saved_at || '') > (local.saved_at || '')) {
    saveRelay(remote);
    return 'restored';
  }
  await writeRelayFile(id, JSON.stringify({ url: local.url, saved_at: local.saved_at || '' }));
  return 'saved';
}
