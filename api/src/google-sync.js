import fs from 'node:fs';
import path from 'node:path';
import { nowISO } from './db.js';
import { buildBackup, restoreBackup, BACKUP_NAME, BACKUP_VERSION, MAX_BACKUP_BYTES, validateBackup } from './backup.js';
import { mergeSnapshots, validateTombstones } from './sync-merge.js';

/**
 * Synchronisation automatique desktop ⇄ Drive tant que Google est connecté :
 * après chaque modification (regroupées), toutes les minutes et à la demande.
 * Un seul passage à la fois ; une demande pendant un passage en relance un.
 * Le fichier distant est le même `WorkLogs backup.json` que la sauvegarde
 * manuelle, enrichi des suppressions (`deleted`) — docs/05-DECISIONS.md §20.
 */
export function createSyncEngine({ db, uploadDir, drive, debounceMs = 4000, intervalMs = 60_000 }) {
  let state = 'off';
  let error = '';
  let lastSyncedAt = null;
  let revision = 0;
  let running = null;
  let again = false;
  let debounce = null;
  let interval = null;
  let seen = { id: '', modifiedTime: '', snapshot: null };

  const localSnapshot = () => ({
    ...validateBackup(buildBackup(db)),
    deleted: db.prepare('SELECT kind, id, deleted_at FROM sync_tombstones ORDER BY kind, id').all(),
  });

  /** Remplace la base par l'instantané fusionné, pierres tombales comprises, puis range les binaires orphelins. */
  function applyLocal(merged) {
    const before = db.prepare('SELECT id, stored FROM attachments').all();
    restoreBackup(db, { version: BACKUP_VERSION, ...merged }, { tombstones: merged.deleted });
    const kept = new Set(merged.attachments.map((row) => row.id));
    for (const row of before) if (!kept.has(row.id)) fs.rmSync(path.join(uploadDir, path.basename(row.stored)), { force: true });
  }

  async function pass() {
    if (!drive.connected()) {
      state = 'off';
      return;
    }
    state = 'syncing';
    error = '';
    try {
      await drive.uploadMissingAttachments();
      const files = await drive.listBackups();
      const file = files.find((candidate) => candidate.name === BACKUP_NAME) || files[0] || null;
      let remote = null;
      if (file && seen.snapshot && seen.id === file.id && seen.modifiedTime === file.modifiedTime) {
        remote = seen.snapshot; // inchangé depuis notre dernier passage : inutile de le retélécharger
      } else if (file) {
        const raw = JSON.parse(await drive.downloadText(file.id));
        remote = { ...validateBackup(raw), deleted: validateTombstones(raw.deleted) };
      }
      // Aucune attente entre la lecture locale et l'écriture : une saisie ne peut pas s'intercaler.
      const { merged, changedLocal, changedRemote } = mergeSnapshots(localSnapshot(), remote);
      if (changedLocal) {
        applyLocal(merged);
        revision++;
      }
      let written = file;
      if (changedRemote) {
        const payload = JSON.stringify({ version: BACKUP_VERSION, exported_at: nowISO(), device: 'desktop', ...merged });
        if (Buffer.byteLength(payload, 'utf8') > MAX_BACKUP_BYTES) throw new Error('La sauvegarde dépasse 20 Mo : synchronisation suspendue.');
        written = await drive.writeCanonical(payload, file);
      }
      seen = { id: written?.id || '', modifiedTime: written?.modifiedTime || '', snapshot: merged };
      if (changedLocal) await drive.downloadMissingAttachments(merged.attachments);
      state = 'idle';
      lastSyncedAt = nowISO();
    } catch (e) {
      state = 'error';
      error = e?.message || 'Synchronisation impossible.';
    }
  }

  function syncNow() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await pass();
      } while (again);
    })().finally(() => { running = null; });
    return running;
  }

  return {
    status: () => ({ state: drive.connected() ? state : 'off', error, lastSyncedAt, revision }),
    syncNow,
    /** Après une modification locale : regroupe les rafales de frappe. */
    schedule() {
      if (!drive.connected()) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void syncNow(), debounceMs);
      debounce.unref?.();
    },
    start() {
      interval ??= setInterval(() => void syncNow(), intervalMs);
      interval.unref?.();
      void syncNow();
    },
    stop() {
      clearTimeout(debounce);
      clearInterval(interval);
      interval = null;
    },
    /** Déconnexion : on oublie le fichier vu, le prochain compte repart de zéro. */
    reset() {
      seen = { id: '', modifiedTime: '', snapshot: null };
      state = 'off';
      error = '';
      lastSyncedAt = null;
    },
  };
}
