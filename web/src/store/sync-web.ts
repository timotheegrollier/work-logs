// @ts-expect-error — sync-merge.js / backup-format.js sont du JavaScript pur partagé avec l'API.
import { mergeSnapshots, validateTombstones } from '../../../api/src/sync-merge.js';
// @ts-expect-error — idem.
import { BACKUP_NAME, BACKUP_VERSION, validateBackup } from '../../../api/src/backup-format.js';
import {
  applySyncSnapshot, clearLocalOutbox, fetchMissingDriveAttachments, listLocalOnlyAttachments, localSyncSnapshot,
  markAttachmentUploaded, onLocalChange, type SyncSnapshot,
} from './localApi';
import {
  attachmentFolderId, consumeRedirectCallback, downloadWebBackup, hasRedirectCallback, listWebBackups, saveBackupJson,
  uploadDriveFile, webGoogleStatus,
} from './google-web';

/**
 * Synchronisation automatique PWA ⇄ Drive, jumelle de `api/src/google-sync.js` :
 * même fichier `WorkLogs backup.json`, même fusion par élément. Déclenchée après
 * chaque modification (regroupées), toutes les minutes, au retour sur l'onglet
 * et à la connexion — tant que le compte est connecté et la session valide.
 */
export interface WebSyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'off';
  error: string;
  lastSyncedAt: string | null;
  revision: number;
}

const DEBOUNCE_MS = 3000;
const INTERVAL_MS = 60_000;

let status: WebSyncStatus = { state: 'off', error: '', lastSyncedAt: null, revision: 0 };
let running: Promise<void> | null = null;
let again = false;
let debounce: ReturnType<typeof setTimeout> | null = null;
let seen: { id: string; modifiedTime: string; snapshot: SyncSnapshot | null } = { id: '', modifiedTime: '', snapshot: null };
const listeners = new Set<(next: WebSyncStatus) => void>();

function publish(next: Partial<WebSyncStatus>): void {
  status = { ...status, ...next };
  for (const listener of listeners) listener(status);
}

export function webSyncStatus(): WebSyncStatus {
  const google = webGoogleStatus();
  return google.connected && !google.expired ? status : { ...status, state: 'off' };
}

/** Abonnement : l'en-tête suit l'état, l'application recharge quand `revision` avance. */
export function subscribeWebSync(listener: (next: WebSyncStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function uploadPendingBinaries(): Promise<void> {
  const pending = await listLocalOnlyAttachments();
  const parent = pending.length ? await attachmentFolderId() : null;
  for (const row of pending) {
    if (!row.blob) continue;
    try {
      const uploaded = await uploadDriveFile({
        name: row.filename,
        mimeType: row.mime || 'application/octet-stream',
        data: row.blob,
        appProperties: { worklogs_type: 'attachment', worklogs_version: '2', worklogs_attachment_id: row.id, worklogs_entry_id: row.entry_id },
        parent,
      });
      await markAttachmentUploaded(row.stored, uploaded.id);
    } catch {
      // Best-effort : la fiche part quand même, le binaire suivra au prochain passage.
    }
  }
}

async function pass(): Promise<void> {
  const google = webGoogleStatus();
  if (!google.connected || google.expired) {
    publish({ state: 'off' });
    return;
  }
  publish({ state: 'syncing', error: '' });
  try {
    await uploadPendingBinaries();
    const files = await listWebBackups();
    const file = files.find((candidate) => candidate.name === BACKUP_NAME) || files[0] || null;
    let remote: SyncSnapshot | null = null;
    if (file && seen.snapshot && seen.id === file.id && seen.modifiedTime === file.modifiedTime) {
      remote = seen.snapshot;
    } else if (file) {
      const raw = (await downloadWebBackup(file.id)) as { deleted?: unknown };
      remote = { ...(validateBackup(raw) as Omit<SyncSnapshot, 'deleted'>), deleted: validateTombstones(raw.deleted) };
    }
    const local = await localSyncSnapshot();
    const { merged, changedLocal, changedRemote } = mergeSnapshots(local, remote) as {
      merged: SyncSnapshot; changedLocal: boolean; changedRemote: boolean;
    };
    let revision = status.revision;
    if (changedLocal) {
      const { changed, skipped } = await applySyncSnapshot(merged, local);
      if (changed) revision++;
      // Une saisie pendant la synchro : on repasse aussitôt pour l'envoyer.
      if (skipped) again = true;
    }
    let written: { id: string; modifiedTime?: string } | null = file;
    if (changedRemote) {
      written = await saveBackupJson(JSON.stringify({ version: BACKUP_VERSION, exported_at: new Date().toISOString(), device: 'pwa', ...merged }));
    }
    seen = { id: written?.id || '', modifiedTime: written?.modifiedTime || '', snapshot: merged };
    // Tout est sur Drive : l'ancienne « boîte mobile » n'a plus rien à envoyer.
    clearLocalOutbox();
    publish({ state: 'idle', error: '', lastSyncedAt: new Date().toISOString(), revision });
    if (changedLocal) {
      // Les photos arrivent après les fiches, sans bloquer la synchro.
      void fetchMissingDriveAttachments().then(({ fetched }) => { if (fetched) publish({ revision: status.revision + 1 }); }).catch(() => {});
    }
  } catch (e) {
    publish({ state: 'error', error: (e as Error).message || 'Synchronisation impossible.' });
  }
}

export function syncWebNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    // Trois passages au plus : une saisie continue ne doit pas faire tourner la synchro en boucle.
    let passes = 0;
    do {
      again = false;
      await pass();
    } while (again && ++passes < 3);
  })().finally(() => {
    running = null;
  });
  return running;
}

export function scheduleWebSync(): void {
  if (!webGoogleStatus().connected) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void syncWebNow(), DEBOUNCE_MS);
}

/** Déconnexion ou changement de compte : on oublie le fichier vu. */
export function resetWebSync(): void {
  seen = { id: '', modifiedTime: '', snapshot: null };
  publish({ state: 'off', error: '', lastSyncedAt: null });
}

/**
 * Démarre la synchro (une fois, à l'ouverture de la PWA). Traite d'abord un
 * retour de connexion Google dans l'URL : la connexion depuis le menu du compte
 * aboutit ici, sans passer par le panneau Drive. Renvoie la fonction d'arrêt.
 * Un retour en échec est remonté à `onLoginError` : l'état publié repasse
 * aussitôt à « off » (compte non connecté), il ne suffit pas à l'afficher.
 */
export function startWebSync(onGoogleChanged: () => void, onLoginError: (message: string) => void = () => {}): () => void {
  let stopped = false;
  onLocalChange(scheduleWebSync);
  const kick = () => { if (!stopped) void syncWebNow(); };
  const interval = setInterval(kick, INTERVAL_MS);
  const onVisible = () => { if (document.visibilityState === 'visible') kick(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', kick);
  void (async () => {
    if (hasRedirectCallback()) {
      try {
        await consumeRedirectCallback();
        resetWebSync();
      } catch (e) {
        publish({ state: 'error', error: (e as Error).message });
        onLoginError((e as Error).message);
      } finally {
        history.replaceState(null, '', location.pathname);
        onGoogleChanged();
      }
    }
    kick();
  })();
  return () => {
    stopped = true;
    onLocalChange(null);
    clearInterval(interval);
    if (debounce) clearTimeout(debounce);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', kick);
  };
}
