import type { JSONContent } from '@tiptap/core';
import { localApi } from './store/localApi';
export type Status = 'todo' | 'doing' | 'done';
export type Priority = 'low' | 'normal' | 'high';
export const PRIORITIES: { id: Priority; label: string }[] = [
  { id: 'low', label: 'Basse' },
  { id: 'normal', label: 'Normale' },
  { id: 'high', label: 'Haute' },
];
export const priorityLabel = (priority: Priority): string =>
  PRIORITIES.find((p) => p.id === priority)?.label ?? 'Normale';
export type RichDocument = JSONContent;
export const emptyDocument = (): RichDocument => ({ type: 'doc', content: [{ type: 'paragraph' }] });

export interface Project {
  id: string;
  name: string;
  color: string;
  created_at: string;
  entries: number;
  open_tasks: number;
}
/** Ligne de la liste de gauche : sans le corps, avec un extrait. */
export interface EntrySummary {
  id: string;
  title: string;
  entry_date: string;
  project_id: string | null;
  /** 1 = rangée dans les archives (masquée du journal, sans rien détruire). */
  archived: 0 | 1;
  /** `procedure` = mode d'emploi du projet, rassemblé dans le panneau Procédures. */
  kind: 'note' | 'procedure';
  updated_at: string;
  excerpt: string;
  attachments: number;
  /** Renseignés pour les onglets d'un document Google, sinon nuls. */
  google_document_id?: string | null;
  google_tab_id?: string | null;
  google_document_title?: string | null;
  google_tab_title?: string | null;
  google_tab_order?: number | null;
  google_tab_depth?: number | null;
  google_dirty?: number | boolean | null;
  google_sync_blocked?: string | null;
}

/** Une ligne du journal : une entrée simple, ou un document Google et ses onglets. */
export interface JournalItem {
  entry: EntrySummary;
  title: string;
  tabs: EntrySummary[];
}

/**
 * Regroupe les onglets d'un même document Google sous une seule ligne, pour ne
 * pas multiplier les documents dans le journal. L'ordre d'origine est conservé.
 */
export function groupTabs(entries: EntrySummary[]): JournalItem[] {
  const items: JournalItem[] = [];
  const byDocument = new Map<string, JournalItem>();
  for (const entry of entries) {
    const documentId = entry.google_document_id;
    if (!documentId) {
      items.push({ entry, title: entry.title, tabs: [] });
      continue;
    }
    const known = byDocument.get(documentId);
    if (known) {
      known.tabs.push(entry);
      continue;
    }
    const item: JournalItem = {
      entry,
      title: entry.google_document_title || entry.title,
      tabs: [entry],
    };
    byDocument.set(documentId, item);
    items.push(item);
  }
  for (const item of byDocument.values()) {
    item.tabs.sort((a, b) => (a.google_tab_order ?? 0) - (b.google_tab_order ?? 0));
    item.entry = item.tabs[0];
  }
  return items;
}
export interface Entry {
  id: string;
  title: string;
  content_md: string;
  content_json?: RichDocument | null;
  google_sync?: GoogleSync | null;
  entry_date: string;
  project_id: string | null;
  archived: 0 | 1;
  kind: 'note' | 'procedure';
  created_at: string;
  updated_at: string;
  attachments: Attachment[];
}
export interface GoogleSync {
  document_id: string; tab_id?: string; synced_at: string | null; dirty: boolean;
  document_title?: string; tab_title?: string; tab_order?: number; tab_depth?: number; sync_blocked?: string;
  preserved_elements?: number; tabs?: EntrySummary[];
}
export interface GoogleStatus {
  available: boolean; configured: boolean; connected: boolean; pending: boolean; error: string;
  selectedIds: string[]; secureStorage?: boolean;
  /** Client OAuth intégré au paquet en service / disponible (sinon client personnel importé). */
  builtin?: boolean; builtinAvailable?: boolean;
  /** Compte connecté, pour l'affichage (absent avec une ancienne autorisation). */
  account?: { email: string; name: string; picture?: string } | null;
  /** PWA : session « jeton » expirée, à reprendre en un clic. */
  expired?: boolean;
}
export interface GoogleSyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'off';
  error: string;
  lastSyncedAt: string | null;
  revision: number;
}
export interface GoogleFile {
  id: string; name: string; modifiedTime: string;
  /** Copie locale existante (ouverte au moins une fois) et son projet. */
  linked?: boolean; project_id?: string | null;
}
export interface GoogleBackup { id: string; name: string; modifiedTime: string; size: number | null }
export interface GoogleTab { id: string; title: string; depth: number; editable?: boolean; reason?: string }
export interface Task {
  id: string;
  title: string;
  status: Status;
  due_date: string | null;
  pinned: 0 | 1;
  position: number;
  /** Toujours renseignée par l'API (`'normal'` par défaut et après migration). */
  priority: Priority;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  documents: EntrySummary[];
}
export interface Attachment {
  id: string;
  filename: string;
  stored: string;
  mime: string;
  size: number;
  entry_id: string;
  created_at: string;
  /** Renseigné quand le binaire est adossé à Drive : survit à une restauration. */
  driveFileId?: string | null;
}
export interface Stats {
  entries: number;
  entriesThisWeek: number;
  tasks: Record<Status, number>;
  overdue: number;
}
export interface AppState {
  projects: Project[];
  entries: EntrySummary[];
  tasks: Task[];
  /** Pièces jointes des procédures du filtre courant, pour le panneau Procédures. */
  procedure_attachments: (Attachment & { entry_title: string })[];
  stats: Stats;
}

// ---------------------------------------------------------------- dossier partagé
/** Le partage répond-il ? `unmounted` : le dossier est là mais ce n'est plus le partage. */
export type SharedReach = 'ok' | 'offline' | 'unmounted' | 'blocked' | 'unconfigured';
export interface SharedStatus {
  available: boolean;
  /** Desktop : le chemin se choisit par le dialogue natif. Ailleurs, il est fixé par la configuration. */
  configurable?: boolean;
  root?: string | null;
  /** Adresse du partage quand WorkLogs l'a monté lui-même : permet « Se reconnecter ». */
  address?: string | null;
  /** Compte Windows indiqué à la connexion (`SRVMURGAT\TonNom`), repris par « Se reconnecter ». */
  account?: string | null;
  /** PWA : le relais ne répond pas (message), la section le montre au lieu de disparaître. */
  relayError?: string;
  label?: string;
  mount?: string | null;
  reach?: SharedReach;
  since?: string | null;
  displayName?: string;
  /** Projet → sous-dossier du partage. */
  projects?: Record<string, string>;
  pending?: number;
  conflicts?: number;
}
export interface SharedLock {
  app: 'word' | 'excel' | 'powerpoint' | 'office' | 'libreoffice' | 'worklogs';
  by: string;
  since: string | null;
  /** Posé depuis cet ordinateur. */
  self: boolean;
  /** Probablement abandonné. */
  stale: boolean;
}
/** `draft` : brouillon local ; `pending` : envoi demandé, en attente ; `conflict` : à régler. */
export type SharedLocalState = '' | 'draft' | 'pending' | 'offline' | 'conflict' | 'interrupted';
export interface SharedEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number | null;
  mtime: string | null;
  ext: string;
  lock: SharedLock | null;
  local: { state: SharedLocalState; draft: boolean; modified: boolean } | null;
  cached?: boolean;
  /** Hors ligne : vu sur le partage, mais pas gardé sur cet ordinateur. */
  unavailable?: boolean;
}
export interface SharedListing {
  dir: string;
  reach: SharedReach;
  entries: SharedEntry[];
  truncated: boolean;
  /** Partage injoignable : la dernière liste vue, et ce qui est gardé sur cet ordinateur. */
  offline?: boolean;
  /** Hors ligne : quand cette liste a été vue sur le partage. */
  listed_at?: string | null;
  error?: string;
}
export interface SharedFile {
  path: string;
  name: string;
  ext: string;
  /** Empreinte du fichier tel que vu sur le partage (ou en cache). */
  hash: string | null;
  size: number | null;
  mtime: string | null;
  /** Version que le brouillon remplacera. */
  base_hash: string | null;
  draft: { model: unknown; template_hash: string | null; updated_at: string | null } | null;
  state: SharedLocalState;
  note: string;
  theirs: { hash: string | null; deleted: boolean; size: number | null; mtime: string | null; author: string | null } | null;
  send: { hash: string | null; requested: boolean };
  /** Cette installation tient la main (notre verrou est posé). */
  held?: boolean;
  lock: SharedLock | null;
  source: 'share' | 'cache';
  deleted?: boolean;
  reach?: SharedReach;
}
export interface SharedSearchResult {
  name: string;
  path: string;
  type: 'dir' | 'file';
  dir: string;
  ext: string;
}
export interface SharedSearch {
  query: string;
  dir: string;
  results: SharedSearchResult[];
  /** Arrêtée avant la fin (temps, nombre de dossiers) : affiner les mots. */
  partial: boolean;
  /** Hors ligne : cherché dans les dernières listes vues. */
  offline: boolean;
  /** Dossiers fermés au compte du montage, passés. */
  denied: number;
}
/** Avant de supprimer un dossier : ce qui partirait, et l'empreinte de ce contenu à rendre. */
export interface SharedDirSummary {
  path: string;
  name: string;
  /** Fichiers et sous-dossiers, à toutes profondeurs (fichiers techniques non comptés). */
  files: number;
  dirs: number;
  size: number;
  token: string;
}
export interface SharedSendResult {
  state: 'written' | 'pending' | 'offline' | 'interrupted' | 'conflict' | 'theirs' | 'copied' | SharedLocalState;
  hash?: string;
  mtime?: string;
  note?: string;
  lock?: SharedLock | null;
  theirs?: SharedFile['theirs'];
  deleted?: boolean;
  copyPath?: string | null;
  file: SharedFile | null;
}
export type SharedLockResult =
  | { ok: true; file: SharedFile }
  | { ok: false; code: string; error: string; lock: SharedLock | null };
export interface SharedVersion {
  id: string;
  hash: string;
  size: number;
  origin: 'base' | 'mine' | 'theirs' | 'restored' | 'merged';
  state: string;
  author: string;
  created_at: string;
}

export const COLUMNS: { id: Status; label: string }[] = [
  { id: 'todo', label: 'À faire' },
  { id: 'doing', label: 'En cours' },
  { id: 'done', label: 'Terminé' },
];

export class ApiError extends Error {
  constructor(message: string, public code?: string, public helpUrl?: string) { super(message); }
}

export function googleHelpUrl(error: unknown): string {
  const url = error instanceof ApiError ? error.helpUrl : undefined;
  return url && /^https:\/\/console\.cloud\.google\.com\/apis\/library\/(drive|docs)\.googleapis\.com(?:\?project=\d+)?$/.test(url) ? url : '';
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new ApiError(payload?.error || `Erreur ${res.status}`, payload?.code, payload?.help_url);
  }
  return res.json() as Promise<T>;
}
const send = <T>(method: string, url: string, body?: unknown) =>
  req<T>(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const enc = encodeURIComponent;
/**
 * Envoi d'octets au dossier partagé. 202 (en attente) et 409 (conflit) ne sont pas
 * des erreurs : ce sont des issues normales, que l'éditeur affiche.
 */

/**
 * Client du dossier partagé. `base` vide : le serveur de cet ordinateur (desktop,
 * dev). Sur la PWA : le **relais** de l'équipe (`api/src/relay.js`, joint par
 * Tailscale), avec son code d'accès dans `auth`. Mêmes routes, mêmes réponses.
 */
export function sharedClient(base: string, auth: () => Record<string, string> = () => ({})) {
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { ...auth(), ...((init.headers as Record<string, string> | undefined) ?? {}) } });
  const failure = (res: Response, payload: { error?: string; code?: string } | null) =>
    new ApiError(payload?.error || `Erreur ${res.status}`, payload?.code);
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await call(path, init);
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw failure(res, payload);
    return payload as T;
  };
  const sendJson = <T>(method: string, path: string, body?: unknown) =>
    json<T>(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  // Les octets eux-mêmes, pas un Blob : partout lisibles tels quels (navigateur, Electron, tests).
  const octets = (bytes?: Uint8Array): RequestInit => ({
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes ? new Uint8Array(bytes) : undefined,
  });
  /** Envoi : un conflit (409) est une réponse, pas une erreur. */
  const send = async (path: string, bytes?: Uint8Array): Promise<SharedSendResult> => {
    const res = await call(path, octets(bytes));
    const payload = await res.json().catch(() => null);
    if (res.ok || res.status === 409 && payload?.code === 'SHARED_CONFLICT') return payload as SharedSendResult;
    throw failure(res, payload);
  };
  return {
    sharedStatus: () => json<SharedStatus>('/api/shared/status'),
    /** Partage injoignable : la liste des fichiers gardés sur cet ordinateur, sans erreur. */
    async sharedList(dir = '') {
      const res = await call('/api/shared/list' + (dir ? '?dir=' + enc(dir) : ''));
      const payload = await res.json().catch(() => null);
      if (res.ok) return payload as SharedListing;
      if (res.status === 503 && payload?.entries) return { ...payload, offline: true } as SharedListing;
      throw failure(res, payload);
    },
    sharedFile: (path: string) => json<SharedFile>('/api/shared/file?path=' + enc(path)),
    async sharedContent(hash: string) {
      const res = await call('/api/shared/content?hash=' + enc(hash));
      if (!res.ok) throw new ApiError((await res.json().catch(() => null))?.error || 'version introuvable');
      return new Uint8Array(await res.arrayBuffer());
    },
    saveSharedDraft: (path: string, body: { model: unknown; template_hash: string; base_hash: string | null }) =>
      sendJson<SharedFile>('PUT', '/api/shared/draft?path=' + enc(path), body),
    discardSharedDraft: (path: string, bytes?: Uint8Array) => json<SharedFile>('/api/shared/draft/discard?path=' + enc(path), octets(bytes)),
    /** « Fusionner » un conflit : les octets réunis partent avec leur version pour base. */
    mergeShared: (path: string, theirs: string | null, bytes: Uint8Array) =>
      send(`/api/shared/merge?path=${enc(path)}${theirs ? `&theirs=${enc(theirs)}` : ''}`, bytes),
    /** Fichier neuf (octets du modèle) : créé sans jamais écraser un fichier du même nom. */
    createShared: (path: string, bytes: Uint8Array) => json<SharedFile>('/api/shared/create?path=' + enc(path), octets(bytes)),
    searchShared: (query: string, dir = '') =>
      json<SharedSearch>(`/api/shared/search?q=${enc(query)}${dir ? `&dir=${enc(dir)}` : ''}`),
    pushShared: (path: string, base: string | null, bytes: Uint8Array) =>
      send('/api/shared/push?path=' + enc(path) + (base ? '&base=' + enc(base) : ''), bytes),
    async resolveShared(path: string, choice: 'mine' | 'theirs' | 'both', theirs: string | null) {
      const res = await call('/api/shared/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, choice, theirs }),
      });
      const payload = await res.json().catch(() => null);
      if (res.ok || res.status === 409 && payload?.code === 'SHARED_CONFLICT') return payload as SharedSendResult;
      throw failure(res, payload);
    },
    sharedVersions: (path: string) => json<{ path: string; versions: SharedVersion[] }>('/api/shared/versions?path=' + enc(path)),
    restoreSharedVersion: (path: string, id: string) =>
      sendJson<SharedFile>('POST', `/api/shared/versions/${enc(id)}/restore?path=${enc(path)}`),
    /** Prendre (ou renouveler) la main. Refusée : qui la tient, sans lever d'erreur. */
    async lockShared(path: string, takeOver = false): Promise<SharedLockResult> {
      const res = await call('/api/shared/lock?path=' + enc(path), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ take_over: takeOver }),
      });
      const payload = await res.json().catch(() => null);
      if (res.ok) return { ok: true, file: payload as SharedFile };
      if (res.status === 409) return { ok: false, code: payload?.code ?? '', error: payload?.error ?? '', lock: payload?.lock ?? null };
      throw failure(res, payload);
    },
    unlockShared: (path: string) => sendJson<SharedFile>('DELETE', '/api/shared/lock?path=' + enc(path)),
    /** Supprime un fichier du partage, sans jamais écraser une version non vue. */
    deleteShared: (path: string) =>
      sendJson<{ state: string; deleted: boolean; file: null }>('DELETE', '/api/shared/file?path=' + enc(path)),
    /** Dossier neuf : jamais par-dessus un dossier ou un fichier du même nom. */
    createSharedDir: (path: string) => sendJson<{ path: string; name: string }>('POST', '/api/shared/dir?path=' + enc(path)),
    /** Renomme un dossier au même endroit ; refusé si un fichier dedans est ouvert ou en route. */
    renameSharedDir: (path: string, name: string) =>
      sendJson<{ path: string; name: string }>('POST', '/api/shared/dir/rename?path=' + enc(path), { name }),
    /** Ce que supprimerait un dossier (ou pourquoi c'est refusé), avant de demander confirmation. */
    sharedDirSummary: (path: string) => json<SharedDirSummary>('/api/shared/dir?path=' + enc(path)),
    /** Supprime un dossier et son contenu, seulement s'il est encore tel que le bilan l'a décrit. */
    deleteSharedDir: (path: string, token: string) =>
      sendJson<{ deleted: boolean; path: string; files: number; dirs: number }>('DELETE', `/api/shared/dir?path=${enc(path)}&expect=${enc(token)}`),
    linkSharedFolder: (projectId: string, dir: string) =>
      sendJson<SharedStatus>('PUT', `/api/shared/projects/${enc(projectId)}/folder`, { dir }),
    unlinkSharedFolder: (projectId: string) => sendJson<SharedStatus>('DELETE', `/api/shared/projects/${enc(projectId)}/folder`),
    setSharedDisplayName: (displayName: string) => sendJson<SharedStatus>('PUT', '/api/shared/settings', { display_name: displayName }),
  };
}
export type SharedClient = ReturnType<typeof sharedClient>;

export const remoteApi = {
  googleStatus: () => req<GoogleStatus>('/api/google/status'),
  configureGoogle: (configuration: unknown) => send<GoogleStatus>('POST', '/api/google/configure', configuration),
  useBuiltinGoogle: () => send<GoogleStatus>('POST', '/api/google/use-builtin'),
  connectGoogle: (pick = false) => send<GoogleStatus>('POST', '/api/google/connect', { pick }),
  disconnectGoogle: () => send<GoogleStatus>('POST', '/api/google/disconnect'),
  /** État de la synchro automatique Drive (révision : le front recharge quand elle avance). */
  googleSync: () => req<GoogleSyncStatus>('/api/google/sync'),
  syncGoogleNow: () => send<GoogleSyncStatus>('POST', '/api/google/sync'),
  /** Déconnecte puis relance la connexion : Google propose le choix du compte. */
  switchGoogleAccount: async () => {
    await send<GoogleStatus>('POST', '/api/google/disconnect');
    return send<GoogleStatus>('POST', '/api/google/connect');
  },
  setGoogleDocumentProject: (documentId: string, projectId: string | null) =>
    send<{ ok: true; entries: number; linked: boolean; project_id: string | null }>('POST', `/api/google/documents/${encodeURIComponent(documentId)}/project`, { project_id: projectId }),
  trashGoogleDocument: (documentId: string) =>
    send<{ ok: true; removed: number }>('POST', `/api/google/documents/${encodeURIComponent(documentId)}/trash`),
  googleDocuments: (pageToken = '') => req<{ files: GoogleFile[]; nextPageToken?: string; warnings?: string[] }>('/api/google/documents' + (pageToken ? '?page_token=' + encodeURIComponent(pageToken) : '')),
  googleBackups: () => req<{ files: GoogleBackup[] }>('/api/google/backup/list'),
  exportGoogleBackup: () => send<GoogleBackup & { binaries?: number }>('POST', '/api/google/backup/export'),
  importGoogleBackup: (id: string) => send<{ ok: true; projects: number; entries: number; tasks: number; binaries?: number; missingFiles?: number }>('POST', `/api/google/backup/${encodeURIComponent(id)}/import`),
  driveAttachmentStatus: () => req<{ total: number; onDrive: number; missingLocal: number; connected: boolean }>('/api/google/attachments/status'),
  fetchDriveAttachment: (id: string) => send<Attachment & { fetched?: boolean }>('POST', `/api/google/attachments/${encodeURIComponent(id)}/fetch`),
  listOutbox: () => req<{ files: GoogleBackup[] }>('/api/google/outbox/list'),
  importOutbox: (id: string) => send<{ ok: true; projects: number; entries: number; tasks: number; links: number; attachments: number; binaries: number; updated: number; conflicts: number }>('POST', `/api/google/outbox/${encodeURIComponent(id)}/import`),
  createGoogleDocument: (title: string) => send<Entry>('POST', '/api/google/documents', { title }),
  googleDocumentTabs: (id: string) => req<{ tabs: GoogleTab[] }>(`/api/google/documents/${encodeURIComponent(id)}/tabs`),
  openGoogleDocument: (document_id: string, tab_id?: string) => send<Entry>('POST', '/api/google/documents/open', { document_id, ...(tab_id ? { tab_id } : {}) }),
  pushGoogleDocument: (id: string) => send<Entry>('POST', `/api/entries/${id}/google/push`),
  pullGoogleDocument: (id: string, expected_content_json: RichDocument) => send<Entry>('POST', `/api/entries/${id}/google/pull`, { expected_content_json }),
  state: (q = '', projectId = '') => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (projectId) params.set('project_id', projectId);
    const query = params.toString();
    return req<AppState>('/api/state' + (query ? '?' + query : ''));
  },
  entry: (id: string) => req<Entry>(`/api/entries/${id}`),
  createEntry: (body: Partial<Entry>) => send<Entry>('POST', '/api/entries', body),
  updateEntry: (id: string, body: Partial<Entry>) => send<Entry>('PUT', `/api/entries/${id}`, body),
  deleteEntry: (id: string) => send<{ ok: true }>('DELETE', `/api/entries/${id}`),
  copyEntry: (id: string) => send<Entry>('POST', `/api/entries/${id}/copy`),
  createTaskFromEntry: (entryId: string, body?: { title?: string; due_date?: string | null }) =>
    send<Task>('POST', `/api/entries/${entryId}/task`, body),
  createEntryFromTask: (taskId: string, body?: { title?: string; content_md?: string }) =>
    send<Entry>('POST', `/api/tasks/${taskId}/entry`, body),

  createTask: (body: Partial<Task>) => send<Task>('POST', '/api/tasks', body),
  updateTask: (id: string, body: Partial<Task>) => send<Task>('PUT', `/api/tasks/${id}`, body),
  moveTask: (id: string, status: Status, position: number) =>
    send<Task>('PATCH', `/api/tasks/${id}/move`, { status, position }),
  deleteTask: (id: string) => send<{ ok: true }>('DELETE', `/api/tasks/${id}`),
  linkTaskDocument: (taskId: string, entryId: string) =>
    send<{ task_id: string; entry_id: string }>('POST', `/api/tasks/${taskId}/documents/${entryId}`),
  unlinkTaskDocument: (taskId: string, entryId: string) =>
    send<{ ok: true }>('DELETE', `/api/tasks/${taskId}/documents/${entryId}`),

  createProject: (body: { name: string; color?: string }) =>
    send<Project>('POST', '/api/projects', body),
  updateProject: (id: string, body: { name?: string; color?: string }) =>
    send<Project>('PUT', `/api/projects/${id}`, body),
  deleteProject: (id: string) => send<{ ok: true }>('DELETE', `/api/projects/${id}`),

  ...sharedClient(''),

  deleteAttachment: (id: string) => send<{ ok: true; driveTrashed?: boolean }>('DELETE', `/api/attachments/${id}`),
  fileUrl: (stored: string) => `/api/files/${stored}`,
  /** Même fichier, servi `inline` : sert l'aperçu intégré, jamais le téléchargement. */
  previewUrl: (stored: string) => `/api/files/${stored}/preview`,
  async exportBackup() {
    const res = await fetch('/api/export');
    if (!res.ok) throw new ApiError((await res.json().catch(() => null))?.error || 'export impossible');
    return { filename: 'worklogs.json', blob: await res.blob() };
  },
  async upload(file: File, entryId: string) {
    const form = new FormData();
    form.append('file', file);
    form.append('entry_id', entryId);
    const res = await fetch('/api/uploads', { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'envoi impossible');
    return res.json() as Promise<Attachment>;
  },
};

/** Contrat partagé par le serveur Express et le backend local du navigateur. */
export type Api = typeof remoteApi;

/**
 * PWA statique (`VITE_PWA=1`, déploiement gh-pages) : backend local IndexedDB,
 * même interface, donc mêmes écrans sans divergence.
 */
export const api: Api = import.meta.env.VITE_PWA === '1' ? localApi : remoteApi;

// ---------------------------------------------------------------- helpers

export const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * Une zone de sous-tâches (une par ligne) devient une liste à puces à cases :
 * les lignes vides sautent, un `- [x]` collé garde son statut coché, un tiret
 * ou un numéro seuls deviennent une case à cocher. Vide → chaîne vide.
 */
export function subtasksMd(raw: string): string {
  const items = raw.split('\n').map((line) => {
    const match = line.trim().match(/^(?:[-*•]\s*|\d+[.)]\s*)?(?:\[([ xX])\]\s*)?(.+)$/);
    if (!match || !match[2].trim()) return null;
    return `- [${match[1] && match[1].toLowerCase() === 'x' ? 'x' : ' '}] ${match[2].trim()}`;
  }).filter((item): item is string => item !== null);
  if (items.length === 0) return '';
  return `## Sous-tâches\n${items.join('\n')}\n`;
}

/** « aujourd'hui », « hier », sinon « lun. 8 sept. » (et l'année si ce n'est pas la courante). */
export function dayLabel(date: string, now = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 864e5).toISOString().slice(0, 10);
  if (date === today) return "aujourd'hui";
  if (date === yesterday) return 'hier';
  const d = new Date(date + 'T12:00:00');
  return d.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Échéance passée sur une tâche non terminée. */
export const isOverdue = (task: Task, today = todayISO()) =>
  task.status !== 'done' && !!task.due_date && task.due_date < today;

/** Retire le balisage Markdown pour afficher un extrait lisible sur une ligne. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}[#>]+\s*/gm, '')
    .replace(/^\s*[-*+]\s+(\[[ x]\]\s*)?/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} o`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} Ko`
      : `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;

/** Regroupe les entrées par date, dans l'ordre déjà fourni par l'API. */
export function groupByDay<T extends { entry_date: string }>(entries: T[]): [string, T[]][] {
  const days = new Map<string, T[]>();
  for (const entry of entries) {
    const bucket = days.get(entry.entry_date);
    if (bucket) bucket.push(entry);
    else days.set(entry.entry_date, [entry]);
  }
  return [...days];
}
