import type { SharedEntry, SharedFile } from '../lib';
import { createIndexedDbDatabase, createMemoryDatabase, type Database } from './storage';

/**
 * Copies hors ligne des fichiers du dossier partagé, gardées sur la PWA : ce qu'on a
 * vu de chaque fichier (métadonnées) et ses octets, par empreinte. Le bureau garde
 * déjà les siens (`api/src/shared-service.js`) ; le téléphone n'avait rien.
 *
 * Base **séparée** de `worklogs` : le service worker ouvre celle-ci à une version
 * figée (`sw-template.js`), la monter ici le ferait échouer les pièces jointes hors ligne.
 */
export const SHARED_COPIES_SCHEMA = { name: 'worklogs-shared', version: 1, stores: { files: 'path', blobs: 'hash' } };

/** Fichiers gardés : les plus anciennement vus partent en premier. */
const MAX_FILES = 200;

type SharedMeta = SharedFile;
interface FileRow { path: string; file: SharedMeta; kept_at: string }
interface BlobRow { hash: string; bytes: Uint8Array }

let backend: Database | null = null;
/** Remplace la base (tests). `null` : retour à la base par défaut. */
export function setSharedCopiesDatabase(next: Database | null): void {
  backend = next;
}
function database(): Database {
  // Sans IndexedDB (tests, navigateur ancien) : copie volatile, même comportement.
  return (backend ??= typeof indexedDB === 'undefined'
    ? createMemoryDatabase(SHARED_COPIES_SCHEMA.stores)
    : createIndexedDbDatabase(SHARED_COPIES_SCHEMA));
}
const files = () => database().table<FileRow>('files');
const blobs = () => database().table<BlobRow>('blobs');

/** Empreintes qu'un fichier fait vivre : sa version, celle qu'il remplacerait, le brouillon. */
function refs(file: SharedMeta): string[] {
  return [file.hash, file.base_hash, file.draft?.template_hash, file.theirs?.hash]
    .filter((hash): hash is string => Boolean(hash));
}

/** Garde la fiche telle que le partage l'a montrée. */
export async function keepSharedFile(file: SharedMeta): Promise<void> {
  const previous = await files().get(file.path);
  await files().put({ path: file.path, file, kept_at: new Date().toISOString() });
  await settle(previous ? refs(previous.file) : []);
}

/** La fiche gardée de ce chemin, s'il y en a une. */
export async function sharedFileCopy(path: string): Promise<SharedMeta | undefined> {
  return (await files().get(path))?.file;
}

/**
 * La dernière liste vue d'un dossier, reconstruite depuis les fiches gardées :
 * les fichiers ouverts une fois, et les dossiers qui les contiennent. Sert au
 * relais injoignable, pour continuer à parcourir ce qui est déjà sur l'appareil.
 */
export async function sharedListingCopy(dir: string): Promise<{ entries: SharedEntry[]; listed_at: string | null }> {
  const prefix = dir ? dir.replace(/\/+$/, '') + '/' : '';
  const rows = await files().all();
  const kept = new Set((await blobs().all()).map((row) => row.hash));
  const entries = new Map<string, SharedEntry>();
  let listed_at: string | null = null;
  for (const row of rows) {
    if (!row.path.startsWith(prefix)) continue;
    const rest = row.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash !== -1) {
      const name = rest.slice(0, slash);
      const path = prefix + name;
      if (!entries.has(path)) {
        entries.set(path, { name, path, type: 'dir', size: null, mtime: null, ext: '', lock: null, local: null });
      }
      continue;
    }
    const file = row.file;
    entries.set(row.path, {
      name: file.name, path: row.path, type: 'file', size: file.size, mtime: file.mtime, ext: file.ext,
      lock: null, local: null, cached: true,
      unavailable: !file.hash || !kept.has(file.hash),
    });
    if (!listed_at || row.kept_at > listed_at) listed_at = row.kept_at;
  }
  const list = [...entries.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'fr') : a.type === 'dir' ? -1 : 1));
  return { entries: list, listed_at };
}

/** Garde les octets d'une version (une seule fois par empreinte). */
export async function keepSharedBytes(hash: string, bytes: Uint8Array): Promise<void> {
  if (await blobs().get(hash)) return;
  await blobs().put({ hash, bytes: new Uint8Array(bytes) });
}

/** Les octets gardés d'une version, s'ils le sont. */
export async function sharedBytesCopy(hash: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const bytes = (await blobs().get(hash))?.bytes;
  if (!bytes) return undefined;
  // Copie fraîche : le tampon d'IndexedDB n'est pas garanti `ArrayBuffer`.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/**
 * Libère ce qui n'est plus référencé : fiches au-delà de `MAX_FILES` (les plus
 * anciennes), puis octets des empreintes `candidates` qu'aucune fiche gardée ne cite.
 */
async function settle(candidates: string[]): Promise<void> {
  const rows = await files().all();
  if (rows.length > MAX_FILES) {
    const oldest = [...rows].sort((a, b) => a.kept_at.localeCompare(b.kept_at)).slice(0, rows.length - MAX_FILES);
    for (const row of oldest) {
      await files().remove(row.path);
      candidates.push(...refs(row.file));
    }
  }
  if (!candidates.length) return;
  const alive = new Set((await files().all()).flatMap((row) => refs(row.file)));
  for (const hash of new Set(candidates)) {
    if (!alive.has(hash)) await blobs().remove(hash);
  }
}
