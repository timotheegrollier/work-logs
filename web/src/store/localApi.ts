import {
  ApiError,
  type Api,
  type AppState,
  type Attachment,
  type Entry,
  type EntrySummary,
  type GoogleStatus,
  type Project,
  type RichDocument,
  type Status,
  type Task,
} from '../lib';
// @ts-expect-error — rich-document.js est du JavaScript pur partagé avec l'API (comme test/server.ts).
import { decodeEntry, documentText, validateDocument } from '../../../api/src/rich-document.js';
// @ts-expect-error — idem : validation 100 % pure, sans `node:sqlite`.
import { OUTBOX_VERSION, validateBackup } from '../../../api/src/backup-format.js';
// @ts-expect-error — idem : conversion et patches ciblés, sans `node:sqlite`.
import { googlePreservedCount } from '../../../api/src/google-preserve.js';
// @ts-expect-error — idem : lecture et fusion Docs, sans `node:sqlite`.
import { buildGoogleUpdate, documentBody, documentTabs, selectDocumentTab } from '../../../api/src/google-document.js';
// @ts-expect-error — idem : conservation à l'envoi, sans `node:sqlite`.
import { buildPreservingUpdate, importGoogleDocument } from '../../../api/src/google-preserve.js';
// @ts-expect-error — idem : réconciliation locale/distance, sans `node:sqlite`.
import { mergeGoogleChanges } from '../../../api/src/google-merge.js';
import { beginWebLogin, builtinWebClientId, clearWebClient, disconnectWeb, downloadDriveBinary, webGoogleRequest, webGoogleStatus } from './google-web';

/** Projet et présence locale de chaque document Drive (ses onglets partagent le projet). */
async function localDocuments(): Promise<Map<string, { linked: boolean; project_id: string | null }>> {
  const { google, entries } = await tables();
  const map = new Map<string, { linked: boolean; project_id: string | null }>();
  for (const row of await google.all()) {
    const entry = await entries.get(row.entry_id);
    const current = map.get(row.document_id);
    map.set(row.document_id, { linked: true, project_id: current?.project_id || entry?.project_id || null });
  }
  return map;
}

function pwaGoogleStatus(): GoogleStatus {
  const status = webGoogleStatus();
  return {
    available: true, configured: status.configured, connected: status.connected, pending: false, error: '',
    selectedIds: [], builtin: status.builtin, builtinAvailable: builtinWebClientId() !== '',
    account: status.account, expired: status.expired,
  };
}
import { createIndexedDbDatabase, createMemoryDatabase, type Database } from './storage';

/**
 * Backend local du navigateur (PWA, `VITE_PWA=1`) : même interface `Api` que le
 * serveur, même sémantique (validations, tris, compteurs, messages français),
 * persistance IndexedDB. `import { localApi } from './store/localApi'` dans
 * `lib.ts` forme un cycle ESM bénin : ce module n'y utilise `ApiError` qu'à
 * l'intérieur des fonctions, jamais à l'évaluation.
 */

// Miroirs de `api/src/db.js` — non importable ici (`node:sqlite`).
const uid = (p = ''): string => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowISO = (): string => new Date().toISOString();
const today = (): string => new Date().toISOString().slice(0, 10);

// Miroirs de `api/src/app.js` (mêmes règles, mêmes messages).
const STATUSES: Status[] = ['todo', 'doing', 'done'];
const PRIORITIES = ['low', 'normal', 'high'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Même format que `api/src/backup.js` (`BACKUP_VERSION`), non importable ici. */
const BACKUP_VERSION = 2;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const orNull = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const pick = <T>(body: Record<string, unknown>, key: string, current: T, transform: (v: unknown) => unknown = (v) => v): T =>
  (body[key] === undefined ? current : transform(body[key])) as T;
const priorityOf = (value: unknown, fallback: string | null = 'normal'): string | null => {
  const cleaned = str(value);
  if (cleaned === '') return fallback;
  return PRIORITIES.includes(cleaned) ? cleaned : null;
};
/** `undefined`/`""` → type par défaut ; toute autre valeur inconnue est refusée. */
const kindOf = (value: unknown, fallback: 'note' | 'procedure' | null = 'note'): 'note' | 'procedure' | null => {
  const cleaned = str(value);
  if (cleaned === '') return fallback;
  return cleaned === 'note' || cleaned === 'procedure' ? cleaned : null;
};
const fail = (message: string): never => {
  throw new ApiError(message);
};
const ext = (name: string): string => /(\.[^.]+)$/.exec(name)?.[1] ?? '';
/** Comparaison texte, comme les colonnes TEXT de SQLite (dates ISO, ids ASCII). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface EntryRow {
  id: string; title: string; content_md: string; content_json: string | null;
  entry_date: string; project_id: string | null; archived: 0 | 1; kind: 'note' | 'procedure';
  created_at: string; updated_at: string;
}
interface TaskRow {
  id: string; title: string; status: Status; due_date: string | null; pinned: 0 | 1;
  position: number; priority: 'low' | 'normal' | 'high'; project_id: string | null;
  created_at: string; updated_at: string;
}
interface ProjectRow { id: string; name: string; color: string; created_at: string; updated_at?: string }
interface LinkRow { id: string; task_id: string; entry_id: string; created_at: string }
interface AttachmentRow {
  id: string; filename: string; stored: string; mime: string; size: number;
  entry_id: string; created_at: string;
  /** Absent après l'import d'une sauvegarde desktop (binaires sur le PC) : le
   * lot 4 téléchargera les photos ; le SW répond 404 en attendant. */
  blob?: Blob;
  /** Renseigné après l'envoi du binaire sur Drive (file d'envoi, lot 4). */
  driveFileId?: string | null;
}
interface GoogleRow {
  entry_id: string; document_id: string; tab_id: string; revision_id: string;
  synced_content_json: string; synced_at: string | null; document_title: string;
  tab_title: string; tab_order: number; tab_depth: number; readonly_reason: string;
}

const linkId = (taskId: string, entryId: string): string => `${taskId}\0${entryId}`;

let backend: Database | null = null;
let seeded = false;

async function tables() {
  backend ??= typeof indexedDB === 'undefined' ? createMemoryDatabase() : createIndexedDbDatabase();
  if (!seeded) {
    await seed(backend);
    seeded = true;
  }
  return {
    projects: backend.table<ProjectRow>('projects'),
    entries: backend.table<EntryRow>('entries'),
    tasks: backend.table<TaskRow>('tasks'),
    links: backend.table<LinkRow>('task_entries'),
    attachments: backend.table<AttachmentRow>('attachments'),
    google: backend.table<GoogleRow>('google_documents'),
  };
}

/** Tests : substitue un backend frais (l'amorçage rejoue automatiquement). */
export function setLocalDatabase(next: Database | null): void {
  backend = next;
  seeded = false;
}

// ---------------------------------------------------------------- file d'envoi
// Créations et modifications locales à transmettre au PC via Drive (lot 4).
// `localStorage` uniquement : jamais de binaire, juste des identifiants.
const OUTBOX_KEY = 'worklogs-outbox';
export interface LocalOutbox {
  entries: string[]; tasks: string[]; links: string[]; attachments: string[]; projects: string[];
}
const emptyOutbox = (): LocalOutbox => ({ entries: [], tasks: [], links: [], attachments: [], projects: [] });

export function readLocalOutbox(): LocalOutbox {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return emptyOutbox();
    const parsed = JSON.parse(raw) as Partial<Record<keyof LocalOutbox, unknown>>;
    const clean = emptyOutbox();
    for (const kind of Object.keys(clean) as (keyof LocalOutbox)[]) {
      if (Array.isArray(parsed[kind])) {
        clean[kind] = (parsed[kind] as unknown[]).filter((id): id is string => typeof id === 'string');
      }
    }
    return clean;
  } catch {
    return emptyOutbox();
  }
}

function writeOutbox(outbox: LocalOutbox): void {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  } catch {
    // Stockage indisponible : l'envoi sera vide, les données restent intactes.
  }
}

function track(kind: keyof LocalOutbox, id: string): void {
  const outbox = readLocalOutbox();
  if (!outbox[kind].includes(id)) {
    outbox[kind].push(id);
    writeOutbox(outbox);
  }
  notifyLocalChange();
}

function untrack(kind: keyof LocalOutbox, id: string): void {
  const outbox = readLocalOutbox();
  outbox[kind] = outbox[kind].filter((current) => current !== id);
  writeOutbox(outbox);
  notifyLocalChange();
}

// ---------------------------------------------------------------- synchro Drive
// Suppressions à propager (pierres tombales, même format que le desktop) et
// signal « quelque chose a changé » pour la synchro automatique (sync-web.ts).
const DELETED_KEY = 'worklogs-sync-deleted';
export interface LocalTombstone { kind: 'project' | 'entry' | 'task' | 'link' | 'attachment'; id: string; deleted_at: string }
let changeListener: (() => void) | null = null;

export function onLocalChange(listener: (() => void) | null): void {
  changeListener = listener;
}
function notifyLocalChange(): void {
  changeListener?.();
}
export function readLocalTombstones(): LocalTombstone[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DELETED_KEY) || '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as LocalTombstone[]) : [];
  } catch {
    return [];
  }
}
export function writeLocalTombstones(list: LocalTombstone[]): void {
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify(list));
  } catch {
    // Stockage plein : la suppression restera locale jusqu'au prochain essai.
  }
}
function tombstone(kind: LocalTombstone['kind'], id: string): void {
  writeLocalTombstones([...readLocalTombstones().filter((t) => !(t.kind === kind && t.id === id)), { kind, id, deleted_at: nowISO() }]);
  notifyLocalChange();
}

export function clearLocalOutbox(): void {
  writeOutbox(emptyOutbox());
}

/** Amorçage identique à `seed()` de `api/src/db.js` : 2 projets, le mode d'emploi, 3 tâches. */
async function seed(db: Database): Promise<void> {
  if ((await db.table<ProjectRow>('projects').all()).length > 0) return;
  const t = nowISO();
  const d = today();
  const projects = db.table<ProjectRow>('projects');
  await projects.put({ id: 'pr_perso', name: 'Perso', color: '#8b5cf6', created_at: t });
  await projects.put({ id: 'pr_pro', name: 'Pro', color: '#0ea5e9', created_at: t });
  await db.table<EntryRow>('entries').put({
    id: 'en_welcome',
    title: 'Comment ça marche',
    content_md: [
      '## Écrire',
      '',
      'Une **entrée** = un compte-rendu, une note, une décision. Le texte est en Markdown,',
      "l'aperçu se met à jour pendant que tu écris.",
      '',
      '| Tu tapes | Tu obtiens |',
      '| --- | --- |',
      '| `## Titre` | un titre de section |',
      '| `**gras**` | du **gras** |',
      '| `- item` | une liste à puces |',
      '| `- [ ] item` | une case à cocher |',
      '',
      '> Astuce : `Ctrl + S` enregistre, `Ctrl + P` imprime l\'entrée en PDF propre.',
      '',
      '## Organiser',
      '',
      'La colonne de droite tient les tâches en cours. Glisse une carte pour la faire avancer.',
      'Les deux colonnes partagent les mêmes **projets** : le filtre est dans le bandeau sous l’en-tête, tout suit.',
    ].join('\n'),
    content_json: null,
    entry_date: d,
    project_id: 'pr_perso',
    archived: 0,
    kind: 'note',
    created_at: t,
    updated_at: t,
  });
  const plus = (n: number): string => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const tasks = db.table<TaskRow>('tasks');
  await tasks.put({ id: 'tk_1', title: 'Écrire ma première entrée', status: 'todo', due_date: plus(0), pinned: 1, position: 0, priority: 'normal', project_id: 'pr_perso', created_at: t, updated_at: t });
  await tasks.put({ id: 'tk_2', title: 'Créer mes projets', status: 'todo', due_date: null, pinned: 0, position: 1, priority: 'normal', project_id: 'pr_perso', created_at: t, updated_at: t });
  await tasks.put({ id: 'tk_3', title: 'Prendre en main WorkLogs', status: 'doing', due_date: null, pinned: 0, position: 0, priority: 'normal', project_id: 'pr_pro', created_at: t, updated_at: t });
}

const stripBlob = (row: AttachmentRow): Attachment => {
  const { blob: _blob, ...meta } = row;
  return meta;
};

/**
 * La PWA peut être servie dans un sous-dossier (GitHub Pages : `/work-logs/`).
 * Une URL commençant par `/api` sortirait alors de la portée du service worker
 * et serait résolue sur `timotheegrollier.github.io/api/...`.
 */
function localFileUrl(stored: string, suffix = ''): string {
  const base = new URL(window.location.href);
  // Même sans slash final, traiter l'URL de l'application comme un dossier.
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const url = new URL(`api/files/${encodeURIComponent(stored)}${suffix}`, base);
  return `${url.pathname}${url.search}${url.hash}`;
}

async function googleSync(entryId: string, contentJson: string | null): Promise<Entry['google_sync']> {
  const { google, entries } = await tables();
  const link = await google.get(entryId);
  if (!link) return null;
  const siblings = await google.all();
  const tabs: EntrySummary[] = [];
  for (const sibling of siblings.filter((row) => row.document_id === link.document_id).sort((a, b) => a.tab_order - b.tab_order)) {
    const target = await entries.get(sibling.entry_id);
    if (!target) continue;
    tabs.push({
      id: target.id, title: target.title, entry_date: target.entry_date, project_id: target.project_id,
      archived: target.archived ?? 0, kind: target.kind ?? 'note',
      updated_at: target.updated_at, excerpt: '', attachments: 0,
      google_document_id: sibling.document_id, google_tab_id: sibling.tab_id,
      google_tab_title: sibling.tab_title, google_tab_order: sibling.tab_order,
      google_tab_depth: sibling.tab_depth, google_sync_blocked: sibling.readonly_reason,
      google_dirty: target.content_json !== sibling.synced_content_json,
    });
  }
  return {
    document_id: link.document_id, tab_id: link.tab_id, synced_at: link.synced_at,
    document_title: link.document_title, tab_title: link.tab_title, tab_order: link.tab_order,
    tab_depth: link.tab_depth, sync_blocked: link.readonly_reason,
    preserved_elements: contentJson ? googlePreservedCount(JSON.parse(contentJson)) : 0,
    tabs, dirty: contentJson !== link.synced_content_json,
  };
}

async function fullEntry(id: string): Promise<Entry> {
  const { entries, attachments } = await tables();
  const row = (await entries.get(id)) ?? fail('entrée introuvable');
  const files = (await attachments.all())
    .filter((a) => a.entry_id === id)
    .sort((a, b) => cmp(b.created_at, a.created_at))
    .map(stripBlob);
  const entry = { ...decodeEntry(row), attachments: files } as Entry;
  entry.google_sync = await googleSync(id, row.content_json);
  return entry;
}

function taskDocuments(taskId: string, entries: EntryRow[], links: LinkRow[], googleByEntry: Map<string, GoogleRow>): EntrySummary[] {
  return links
    .filter((link) => link.task_id === taskId)
    .map((link) => entries.find((entry) => entry.id === link.entry_id))
    .filter((entry): entry is EntryRow => !!entry)
    .sort((a, b) => cmp(b.entry_date, a.entry_date) || cmp(b.updated_at, a.updated_at) || cmp(a.id, b.id))
    // Même forme que `getTaskWithDocuments` côté serveur (`''`, `0`, sans
    // jointure Google) : les cartes n'affichent que titre, date et projet.
    .map((entry) => {
      const link = googleByEntry.get(entry.id);
      return {
        id: entry.id, title: entry.title, entry_date: entry.entry_date,
        project_id: entry.project_id, archived: entry.archived ?? 0, kind: entry.kind ?? 'note', updated_at: entry.updated_at,
        excerpt: '', attachments: 0,
        google_document_id: link?.document_id ?? null, google_tab_id: link?.tab_id ?? null,
        google_document_title: link?.document_title ?? null, google_tab_title: link?.tab_title ?? null,
      };
    });
}

async function renumber(status: Status): Promise<void> {
  const { tasks } = await tables();
  const rows = (await tasks.all())
    .filter((task) => task.status === status)
    .sort((a, b) => a.position - b.position || cmp(b.updated_at, a.updated_at));
  let position = 0;
  for (const row of rows) {
    if (row.position !== position) await tasks.put({ ...row, position });
    position++;
  }
}

/** Archive dans IndexedDB les entrées liées à une tâche qui vient d'être terminée. */
async function archiveTaskDocuments(taskId: string): Promise<void> {
  const { entries, links } = await tables();
  const linked = new Set((await links.all()).filter((link) => link.task_id === taskId).map((link) => link.entry_id));
  const time = nowISO();
  for (const entry of await entries.all()) {
    if (linked.has(entry.id) && !entry.archived) {
      await entries.put({ ...entry, archived: 1, updated_at: time });
      track('entries', entry.id);
    }
  }
}

/** Lecture Docs ciblée sur l'onglet lié (miroir de `read` dans `google-routes.js`). */
async function readGoogleSource(documentId: string, tabId = '') {
  if (!/^[\w-]{1,200}$/.test(documentId)) fail('Identifiant de document Google invalide.');
  const raw = await webGoogleRequest(`/docs/v1/documents/${documentId}?includeTabsContent=true`);
  return selectDocumentTab(raw, tabId);
}

const blankGoogleSource = () => ({ body: { content: [{ paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } });

export const localApi: Api = {
  // Connexion directe à Google depuis le navigateur : même forme que le desktop,
  // pour que l'en-tête (menu du compte) n'ait qu'un seul chemin.
  googleStatus: async (): Promise<GoogleStatus> => pwaGoogleStatus(),
  configureGoogle: async () => fail('Google Drive est disponible dans l’application desktop.'),
  useBuiltinGoogle: async () => {
    clearWebClient();
    return pwaGoogleStatus();
  },
  connectGoogle: async () => {
    await beginWebLogin();
    return pwaGoogleStatus();
  },
  disconnectGoogle: async () => {
    disconnectWeb();
    (await import('./sync-web')).resetWebSync();
    return pwaGoogleStatus();
  },
  // Import dynamique : sync-web dépend de ce module, pas l'inverse.
  googleSync: async () => (await import('./sync-web')).webSyncStatus(),
  syncGoogleNow: async () => {
    const sync = await import('./sync-web');
    await sync.syncWebNow();
    return sync.webSyncStatus();
  },
  switchGoogleAccount: async () => {
    (await import('./sync-web')).resetWebSync();
    disconnectWeb();
    await beginWebLogin('', { selectAccount: true });
    return pwaGoogleStatus();
  },
  googleDocuments: async (pageToken = '') => {
    const params = new URLSearchParams({
      q: "mimeType='application/vnd.google-apps.document' and trashed=false",
      fields: 'files(id,name,modifiedTime),nextPageToken', orderBy: 'modifiedTime desc', pageSize: '100',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    });
    if (pageToken && pageToken.length < 5000) params.set('pageToken', pageToken);
    const result = (await webGoogleRequest(`/drive/v3/files?${params}`)) as { files?: { id: string; name: string; modifiedTime: string }[]; nextPageToken?: string };
    const local = await localDocuments();
    return {
      files: (result.files || []).map((file) => ({ ...file, ...(local.get(file.id) ?? { linked: false, project_id: null }) })),
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    };
  },
  setGoogleDocumentProject: async (documentId, projectId) => {
    const { google, projects } = await tables();
    if (projectId && !(await projects.get(projectId))) fail('projet introuvable');
    const ids = (await google.all()).filter((row) => row.document_id === documentId).map((row) => row.entry_id);
    if (!ids.length) fail('Ouvre d’abord ce document dans WorkLogs pour le ranger dans un projet.');
    for (const id of ids) await localApi.updateEntry(id, { project_id: projectId || null });
    return { ok: true, entries: ids.length, ...((await localDocuments()).get(documentId) ?? { linked: false, project_id: null }) };
  },
  trashGoogleDocument: async (documentId) => {
    if (!/^[\w-]{1,200}$/.test(documentId)) fail('Identifiant de document Google invalide.');
    await webGoogleRequest(`/drive/v3/files/${documentId}?supportsAllDrives=true&fields=id,trashed`, {
      method: 'PATCH', body: JSON.stringify({ trashed: true }),
    });
    const { google } = await tables();
    const ids = (await google.all()).filter((row) => row.document_id === documentId).map((row) => row.entry_id);
    for (const id of ids) await localApi.deleteEntry(id);
    return { ok: true, removed: ids.length };
  },
  googleBackups: async () => fail('Google Drive est disponible dans l’application desktop.'),
  exportGoogleBackup: async () => fail('Google Drive est disponible dans l’application desktop.'),
  importGoogleBackup: async () => fail('Google Drive est disponible dans l’application desktop.'),
  driveAttachmentStatus: async () => {
    const { attachments } = await tables();
    const rows = await attachments.all();
    return {
      total: rows.length,
      onDrive: rows.filter((row) => row.driveFileId).length,
      missingLocal: rows.filter((row) => !row.blob).length,
      connected: webGoogleStatus().connected,
    };
  },
  fetchDriveAttachment: async (id: string) => {
    const { attachments } = await tables();
    const row = (await attachments.get(id)) ?? fail('pièce jointe introuvable');
    if (row.blob) return { ...stripBlob(row), fetched: false };
    const driveId = row.driveFileId || '';
    if (!driveId) fail('Ce fichier n’est pas encore sur Google Drive. Envoyez-le depuis un appareil connecté.');
    const blob = await downloadDriveBinary(driveId);
    await attachments.put({ ...row, blob, size: blob.size || row.size, mime: blob.type || row.mime });
    return { ...stripBlob({ ...row, size: blob.size || row.size, mime: blob.type || row.mime }), fetched: true };
  },
  listOutbox: async () => fail('Google Drive est disponible dans l’application desktop.'),
  importOutbox: async () => fail('Google Drive est disponible dans l’application desktop.'),
  createGoogleDocument: async (title) => {
    const clean = str(title);
    if (!clean || clean.length > 240) fail('Le titre doit contenir entre 1 et 240 caractères.');
    const created = (await webGoogleRequest('/docs/v1/documents', { method: 'POST', body: JSON.stringify({ title: clean }) })) as Record<string, unknown>;
    const rawId: unknown = created['documentId'];
    const documentId: string = typeof rawId === 'string' && /^[\w-]{1,200}$/.test(rawId) ? rawId : fail('Identifiant de document Google invalide.');
    const hasBody = (created['body'] as { content?: unknown } | undefined)?.content || (created['tabs'] as unknown[] | undefined)?.length;
    const rich = importGoogleDocument(hasBody ? selectDocumentTab(created) : blankGoogleSource());
    const serialized = JSON.stringify(rich);
    const id = uid('en_');
    const time = nowISO();
    const t = await tables();
    await t.entries.put({
      id, title: clean, content_md: '', content_json: serialized, entry_date: today(),
      project_id: null, archived: 0, kind: 'note', created_at: time, updated_at: time,
    });
    const tabs = documentTabs(created);
    const createdRevision = typeof created['revisionId'] === 'string' ? created['revisionId'] : '';
    await t.google.put({
      entry_id: id, document_id: documentId, tab_id: tabs[0]?.id || '', revision_id: createdRevision,
      synced_content_json: serialized, synced_at: time,
      document_title: '', tab_title: '', tab_order: 0, tab_depth: 0, readonly_reason: '',
    });
    track('entries', id);
    return fullEntry(id);
  },
  googleDocumentTabs: async () => fail('Google Drive est disponible dans l’application desktop.'),
  openGoogleDocument: async (documentId, tabId) => {
    if (!/^[\w-]{1,200}$/.test(documentId)) fail('Identifiant de document Google invalide.');
    if (tabId !== undefined && (typeof tabId !== 'string' || (tabId && !/^[\w.-]{1,200}$/.test(tabId)))) {
      fail('Identifiant d’onglet Google invalide.');
    }
    const t = await tables();
    const source = (await webGoogleRequest(`/docs/v1/documents/${documentId}?includeTabsContent=true`)) as Record<string, unknown>;
    const allTabs = documentTabs(source);
    const list: { id: string; title: string; depth: number }[] = allTabs.length ? allTabs : [{ id: '', title: (source.title as string) || 'Document', depth: 0 }];
    if (tabId && !list.some((tab) => tab.id === tabId)) fail('Onglet Google introuvable.');
    const documentTitle = (source.title as string) || 'Document Google';
    const time = nowISO();
    let first: string | null = null;
    let asked: string | null = null;
    for (const [order, tab] of list.entries()) {
      const existing = ((await t.google.all()).find((row) => row.document_id === documentId && row.tab_id === tab.id)
        ?? (tab.id && order === 0 ? (await t.google.all()).find((row) => row.document_id === documentId && row.tab_id === '') : undefined));
      if (existing) {
        await t.google.put({ ...existing, document_title: documentTitle, tab_title: tab.title, tab_order: order, tab_depth: tab.depth, tab_id: tab.id });
        const entryRow = (await t.entries.get(existing.entry_id)) as EntryRow | undefined;
        if (entryRow && entryRow.content_json === existing.synced_content_json) {
          const rich = importGoogleDocument(selectDocumentTab(source, tab.id));
          const serialized = JSON.stringify(rich);
          await t.entries.put({ ...entryRow, content_json: serialized, content_md: documentText(rich) });
          await t.google.put({ ...existing, document_title: documentTitle, tab_title: tab.title, tab_order: order, tab_depth: tab.depth, tab_id: tab.id, synced_content_json: serialized, revision_id: (source.revisionId as string) || '', synced_at: time, readonly_reason: '' });
        }
        first ??= existing.entry_id;
        if (tab.id === tabId) asked = existing.entry_id;
        continue;
      }
      const rich = importGoogleDocument(selectDocumentTab(source, tab.id));
      const id = uid('en_');
      await t.entries.put({
        id, title: list.length > 1 ? `${documentTitle} — ${tab.title}` : documentTitle,
        content_md: documentText(rich), content_json: JSON.stringify(rich),
        entry_date: today(), project_id: null, archived: 0, kind: 'note', created_at: time, updated_at: time,
      });
      await t.google.put({
        entry_id: id, document_id: documentId, tab_id: tab.id, revision_id: (source.revisionId as string) || '',
        synced_content_json: JSON.stringify(rich), synced_at: time,
        document_title: documentTitle, tab_title: tab.title, tab_order: order, tab_depth: tab.depth, readonly_reason: '',
      });
      track('entries', id);
      first ??= id;
      if (tab.id === tabId) asked = id;
    }
    return fullEntry((asked ?? first) as string);
  },
  pushGoogleDocument: async (id) => {
    const t = await tables();
    const current = (await t.entries.get(id)) ?? fail('entrée introuvable');
    const currentJson: string = current.content_json ?? fail('Crée un document riche pour le synchroniser avec Google Drive.');
    let rich = JSON.parse(currentJson) as RichDocument;
    let link = (await t.google.get(id)) ?? null;
    if (link?.readonly_reason) {
      fail('Cet ancien import a été aplati. Garde une copie locale de tes modifications puis recharge depuis Google pour activer la nouvelle synchronisation.');
    }
    if (!link) {
      // Vérifier le format AVANT de créer un fichier distant (miroir serveur).
      buildGoogleUpdate({ revisionId: 'check', body: { content: [{ paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } }, rich);
      const created = (await webGoogleRequest('/docs/v1/documents', { method: 'POST', body: JSON.stringify({ title: current.title }) })) as Record<string, unknown>;
      const rawId: unknown = created['documentId'];
      const documentId: string = typeof rawId === 'string' && /^[\w-]{1,200}$/.test(rawId) ? rawId : fail('Identifiant de document Google invalide.');
      const fresh = await readGoogleSource(documentId);
      if (!(await t.entries.get(id))) fail('entrée introuvable');
      await t.google.put({
        entry_id: id, document_id: documentId, tab_id: documentBody(fresh).tabId || '', revision_id: fresh.revisionId || '',
        synced_content_json: JSON.stringify(importGoogleDocument(fresh)),
        synced_at: null, document_title: '', tab_title: '', tab_order: 0, tab_depth: 0, readonly_reason: '',
      });
      link = ((await t.google.get(id)) ?? fail('Ce document n’est pas encore associé à Google Drive.')) as GoogleRow;
    }
    const source = await readGoogleSource(link.document_id, link.tab_id);
    const unchangedNewDocument = !link.revision_id && JSON.stringify(importGoogleDocument(source)) === link.synced_content_json;
    if (!unchangedNewDocument && source.revisionId !== link.revision_id) {
      if (!link.revision_id) fail('Le document a changé sur Google Drive. Ton brouillon local est conservé.');
      rich = mergeGoogleChanges(JSON.parse(link.synced_content_json), rich, importGoogleDocument(source));
    }
    const update = buildPreservingUpdate(source, rich);
    const result = update.requests.length
      ? ((await webGoogleRequest(`/docs/v1/documents/${link.document_id}:batchUpdate`, { method: 'POST', body: JSON.stringify(update) })) as { writeControl?: { requiredRevisionId?: string } })
      : { writeControl: { requiredRevisionId: source.revisionId } };
    const revision = result.writeControl?.requiredRevisionId;
    if (!revision) fail('Google a reçu la mise à jour sans renvoyer sa révision. Recharge la version Google pour vérifier l’enregistrement.');
    // La révision vaut pour tout le document : ne pas créer de faux conflit
    // sur les autres onglets lus à cette même révision (miroir serveur).
    for (const sibling of (await t.google.all()).filter((row) => row.document_id === (link as GoogleRow).document_id && row.revision_id === source.revisionId && row.entry_id !== id)) {
      await t.google.put({ ...sibling, revision_id: revision });
    }
    const serialized = JSON.stringify(rich);
    const latest = ((await t.entries.get(id)) ?? fail('entrée introuvable')) as EntryRow;
    const local = latest.content_json === current.content_json
      ? rich
      : mergeGoogleChanges(JSON.parse(current.content_json as string), JSON.parse(latest.content_json as string), rich);
    await t.entries.put({ ...latest, content_json: JSON.stringify(local), content_md: documentText(local), updated_at: latest.updated_at });
    await t.google.put({ ...(link as GoogleRow), revision_id: revision, synced_content_json: serialized, synced_at: nowISO() });
    // Google porte désormais la modification : la file d'envoi vers le PC n'a plus à la transmettre.
    untrack('entries', id);
    return fullEntry(id);
  },
  pullGoogleDocument: async (id, expected) => {
    const t = await tables();
    const current = (await t.entries.get(id)) ?? fail('entrée introuvable');
    const link = (await t.google.get(id)) ?? fail('Ce document n’est pas encore associé à Google Drive.');
    if (JSON.stringify(expected) !== current.content_json) fail('Le brouillon a changé. Enregistre-le avant de recharger Google.');
    const source = await readGoogleSource(link.document_id, link.tab_id);
    const rich = importGoogleDocument(source);
    if (((await t.entries.get(id)) as EntryRow | undefined)?.content_json !== current.content_json) {
      fail('Tu as modifié le brouillon pendant le rechargement. Il a été conservé.');
    }
    const serialized = JSON.stringify(rich);
    const time = nowISO();
    await t.entries.put({ ...current, content_json: serialized, content_md: documentText(rich), updated_at: time });
    await t.google.put({ ...link, revision_id: source.revisionId || '', synced_content_json: serialized, synced_at: time, readonly_reason: '' });
    track('entries', id);
    return fullEntry(id);
  },

  state: async (q = '', projectId = ''): Promise<AppState> => {
    const { projects, entries, tasks, links, attachments, google } = await tables();
    const allEntries = await entries.all();
    const allTasks = await tasks.all();
    const allLinks = await links.all();
    const allAttachments = await attachments.all();
    const googleByEntry = new Map((await google.all()).map((row) => [row.entry_id, row]));
    const needle = q.trim().toLowerCase();
    const matching = allEntries
      .filter((entry) => (!projectId || entry.project_id === projectId))
      // SQLite `LIKE` est insensible à la casse (ASCII) : on compare en minuscules.
      .filter((entry) => !needle || entry.title.toLowerCase().includes(needle) || entry.content_md.toLowerCase().includes(needle))
      .sort((a, b) => cmp(b.entry_date, a.entry_date) || cmp(b.updated_at, a.updated_at));
    const counts = new Map<string, number>();
    for (const file of allAttachments) counts.set(file.entry_id, (counts.get(file.entry_id) ?? 0) + 1);
    const summaries = matching.map((entry) => {
      const link = googleByEntry.get(entry.id);
      return {
        id: entry.id, title: entry.title, entry_date: entry.entry_date, project_id: entry.project_id,
        archived: entry.archived ?? 0, kind: entry.kind ?? 'note',
        updated_at: entry.updated_at, excerpt: entry.content_md.slice(0, 240),
        attachments: counts.get(entry.id) ?? 0,
        google_document_id: link?.document_id ?? null, google_tab_id: link?.tab_id ?? null,
        google_document_title: link?.document_title ?? null, google_tab_title: link?.tab_title ?? null,
        google_tab_order: link?.tab_order ?? null, google_tab_depth: link?.tab_depth ?? null,
        google_sync_blocked: link?.readonly_reason ?? null,
        google_dirty: link ? entry.content_json !== link.synced_content_json : false,
      };
    });
    const matchingTasks = allTasks
      .filter((task) => (!projectId || task.project_id === projectId))
      .filter((task) => !needle || task.title.toLowerCase().includes(needle))
      .sort((a, b) => a.position - b.position || cmp(b.updated_at, a.updated_at) || cmp(a.id, b.id))
      .map((task) => ({ ...task, documents: taskDocuments(task.id, allEntries, allLinks, googleByEntry) }));
    const allProjects = (await projects.all()).sort((a, b) => cmp(a.name, b.name));
    const byStatus: Record<Status, number> = { todo: 0, doing: 0, done: 0 };
    for (const task of allTasks) byStatus[task.status]++;
    const day = today();
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    // Pièces jointes rassemblées pour le panneau Procédures : celles des
    // procédures du filtre courant, métadonnées seules, plus récentes d'abord.
    const procedureIds = new Set(matching.filter((entry) => (entry.kind ?? 'note') === 'procedure').map((entry) => entry.id));
    const procedureEntries = new Map(allEntries.map((entry) => [entry.id, entry]));
    const procedureAttachments = allAttachments
      .filter((file) => procedureIds.has(file.entry_id))
      .sort((a, b) => cmp(b.created_at, a.created_at))
      .map((file) => {
        const parent = procedureEntries.get(file.entry_id);
        const { blob: _blob, driveFileId: _drive, ...meta } = file;
        return { ...meta, driveFileId: file.driveFileId ?? null, entry_title: parent?.title ?? '' };
      });
    return {
      projects: allProjects.map((project) => ({
        ...project,
        entries: allEntries.filter((entry) => entry.project_id === project.id).length,
        open_tasks: allTasks.filter((task) => task.project_id === project.id && task.status !== 'done').length,
      })),
      entries: summaries,
      tasks: matchingTasks,
      procedure_attachments: procedureAttachments,
      stats: {
        entries: allEntries.length,
        entriesThisWeek: allEntries.filter((entry) => entry.entry_date >= weekAgo).length,
        tasks: byStatus,
        overdue: allTasks.filter((task) => task.status !== 'done' && task.due_date !== null && task.due_date < day).length,
      },
    };
  },

  entry: (id: string) => fullEntry(id),

  createEntry: async (body) => {
    const { entries, projects } = await tables();
    const title = str(body.title);
    if (!title) fail('titre requis');
    const date = str(body.entry_date) || today();
    if (!DATE_RE.test(date)) fail('date invalide (AAAA-MM-JJ attendu)');
    if (orNull(body.project_id) && !(await projects.get(str(body.project_id)))) fail('projet introuvable');
    const kind: 'note' | 'procedure' = kindOf(body.kind) ?? fail('type de document invalide (note ou procédure attendu)');
    const id = uid('en_');
    const t = nowISO();
    const rich = body.content_json == null ? null : validateDocument(body.content_json);
    await entries.put({
      id, title, content_md: rich ? documentText(rich) : typeof body.content_md === 'string' ? body.content_md : '',
      entry_date: date, project_id: orNull(body.project_id), archived: 0, kind, created_at: t, updated_at: t,
      content_json: rich ? JSON.stringify(rich) : null,
    });
    track('entries', id);
    return fullEntry(id);
  },

  updateEntry: async (id, body) => {
    const { entries, projects } = await tables();
    const current = await fullEntry(id);
    const patch = (body ?? {}) as Record<string, unknown>;
    const title = pick(patch, 'title', current.title, (v) => str(v));
    if (!title) fail('titre requis');
    const date = pick(patch, 'entry_date', current.entry_date, (v) => str(v) || current.entry_date);
    if (!DATE_RE.test(date)) fail('date invalide (AAAA-MM-JJ attendu)');
    const projectId = pick(patch, 'project_id', current.project_id, orNull);
    if (projectId && !(await projects.get(projectId))) fail('projet introuvable');
    const rich = patch['content_json'] === undefined ? current.content_json : (patch['content_json'] as RichDocument | null);
    if (rich !== null) validateDocument(rich);
    if (current.content_json && rich === null) fail('la conversion d’un document riche en Markdown n’est pas prise en charge');
    const row = (await entries.get(id)) as EntryRow;
    const archived = pick(patch, 'archived', row.archived ?? 0, (v) => (v ? 1 : 0));
    const kind: 'note' | 'procedure' = pick(patch, 'kind', row.kind ?? 'note', (v) => kindOf(v, row.kind ?? 'note'))
      ?? fail('type de document invalide (note ou procédure attendu)');
    await entries.put({
      ...row, title,
      content_md: rich ? documentText(rich) : pick(patch, 'content_md', current.content_md, (v) => (typeof v === 'string' ? v : current.content_md)),
      entry_date: date, project_id: projectId, archived, kind, updated_at: nowISO(),
      content_json: rich ? JSON.stringify(rich) : null,
    });
    track('entries', id);
    return fullEntry(id);
  },

  deleteEntry: async (id) => {
    const { entries, links, attachments, google } = await tables();
    if (!(await entries.get(id))) fail('entrée introuvable');
    await entries.remove(id);
    for (const link of (await links.all()).filter((row) => row.entry_id === id)) {
      await links.remove(link.id);
      untrack('links', link.id);
    }
    for (const file of (await attachments.all()).filter((row) => row.entry_id === id)) {
      await attachments.remove(file.id);
      untrack('attachments', file.id);
    }
    await google.remove(id);
    untrack('entries', id);
    tombstone('entry', id);
    return { ok: true };
  },

  copyEntry: async (id) => {
    const { entries, attachments } = await tables();
    const original = await fullEntry(id);
    const copyId = uid('en_');
    const time = nowISO();
    const rich = original.content_json ? (structuredClone(original.content_json) as RichDocument) : null;
    let markdown = original.content_md;
    const replaceImage = (node: RichDocument, from: string, to: string): void => {
      if ((node.attrs as Record<string, unknown> | undefined)?.['src'] === from) {
        (node.attrs as Record<string, unknown>)['src'] = to;
      }
      for (const child of node.content ?? []) replaceImage(child, from, to);
    };
    await entries.put({
      id: copyId, title: `${original.title} — copie locale`, content_md: markdown,
      content_json: rich ? JSON.stringify(rich) : null, entry_date: original.entry_date,
      project_id: original.project_id, archived: 0, kind: original.kind ?? 'note', created_at: time, updated_at: time,
    });
    for (const file of (await attachments.all()).filter((row) => row.entry_id === id)) {
      const stored = uid('copy_') + ext(file.stored);
      await attachments.put({
        id: uid('at_'), filename: file.filename, stored, mime: file.mime, size: file.size,
        entry_id: copyId, created_at: time, blob: file.blob,
      });
      markdown = markdown.split(`/api/files/${file.stored}`).join(`/api/files/${stored}`);
      if (rich) replaceImage(rich, `/api/files/${file.stored}`, `/api/files/${stored}`);
    }
    const row = (await entries.get(copyId)) as EntryRow;
    await entries.put({ ...row, content_md: rich ? documentText(rich) : markdown, content_json: rich ? JSON.stringify(rich) : null });
    track('entries', copyId);
    for (const file of (await attachments.all()).filter((row) => row.entry_id === copyId)) {
      track('attachments', file.id);
    }
    return fullEntry(copyId);
  },

  createTaskFromEntry: async (entryId, body) => {
    const { entries, tasks, links } = await tables();
    const source = (await entries.get(entryId)) ?? fail('entrée introuvable');
    const title = body?.title === undefined ? source.title : str(body.title);
    if (!title) fail('titre requis');
    const dueDate = body?.due_date === undefined ? null : orNull(body.due_date);
    if (dueDate && !DATE_RE.test(dueDate)) fail('échéance invalide (AAAA-MM-JJ attendu)');
    const id = uid('tk_');
    const time = nowISO();
    const position = Math.max(-1, ...(await tasks.all()).filter((task) => task.status === 'todo').map((task) => task.position)) + 1;
    await tasks.put({
      id, title, status: 'todo', due_date: dueDate, pinned: 0, position,
      priority: 'normal', project_id: source.project_id, created_at: time, updated_at: time,
    });
    await links.put({ id: linkId(id, source.id), task_id: id, entry_id: source.id, created_at: time });
    track('tasks', id);
    track('links', linkId(id, source.id));
    return taskWithDocuments(id);
  },

  createEntryFromTask: async (taskId, body) => {
    const { entries, tasks, links } = await tables();
    const source = (await tasks.get(taskId)) ?? fail('tâche introuvable');
    const title = body?.title === undefined ? source.title : str(body.title);
    if (!title) fail('titre requis');
    const content = typeof body?.content_md === 'string' ? body.content_md : '';
    const id = uid('en_');
    const time = nowISO();
    await entries.put({
      id, title, content_md: content, entry_date: today(), project_id: source.project_id,
      archived: 0, kind: 'note', created_at: time, updated_at: time, content_json: null,
    });
    await links.put({ id: linkId(source.id, id), task_id: source.id, entry_id: id, created_at: time });
    if (source.status === 'done') await archiveTaskDocuments(source.id);
    track('entries', id);
    track('links', linkId(source.id, id));
    return fullEntry(id);
  },

  createTask: async (body) => {
    const { tasks, projects } = await tables();
    const title = str(body.title);
    if (!title) fail('titre requis');
    const status = (str(body.status) || 'todo') as Status;
    if (!STATUSES.includes(status)) fail('statut invalide');
    const priority = priorityOf(body.priority);
    if (!priority) fail('priorité invalide (basse, normale ou haute attendue)');
    if (orNull(body.project_id) && !(await projects.get(str(body.project_id)))) fail('projet introuvable');
    const id = uid('tk_');
    const t = nowISO();
    const position = Math.max(-1, ...(await tasks.all()).filter((task) => task.status === status).map((task) => task.position)) + 1;
    const row: TaskRow = {
      id, title, status, due_date: orNull(body.due_date), pinned: body.pinned ? 1 : 0, position,
      priority: priority as TaskRow['priority'], project_id: orNull(body.project_id), created_at: t, updated_at: t,
    };
    await tasks.put(row);
    track('tasks', id);
    return rowAsTask(row);
  },

  updateTask: async (id, body) => {
    const { tasks, projects } = await tables();
    const current = (await tasks.get(id)) ?? fail('tâche introuvable');
    const patch = (body ?? {}) as Record<string, unknown>;
    const title = pick(patch, 'title', current.title, (v) => str(v));
    if (!title) fail('titre requis');
    const status = pick(patch, 'status', current.status, (v) => (str(v) || current.status) as Status);
    if (!STATUSES.includes(status)) fail('statut invalide');
    const priority = pick(patch, 'priority', current.priority, (v) => priorityOf(v, current.priority));
    if (!priority) fail('priorité invalide (basse, normale ou haute attendue)');
    const projectId = pick(patch, 'project_id', current.project_id, orNull);
    if (projectId && !(await projects.get(projectId))) fail('projet introuvable');
    const next: TaskRow = {
      ...current, title, status,
      due_date: pick(patch, 'due_date', current.due_date, orNull),
      pinned: pick(patch, 'pinned', current.pinned, (v) => (v ? 1 : 0)),
      priority: priority as TaskRow['priority'], project_id: projectId, updated_at: nowISO(),
    };
    await tasks.put(next);
    if (current.status !== 'done' && status === 'done') await archiveTaskDocuments(id);
    track('tasks', id);
    return rowAsTask(next);
  },

  moveTask: async (id, status, position) => {
    const { tasks } = await tables();
    const current = (await tasks.get(id)) ?? fail('tâche introuvable');
    if (!STATUSES.includes(status)) fail('statut invalide');
    const target = Number.isFinite(Number(position)) ? Math.max(0, Number(position)) : 0;
    await tasks.put({ ...current, status, position: target - 0.5, updated_at: nowISO() });
    await renumber(status);
    if (current.status !== status) await renumber(current.status);
    if (current.status !== 'done' && status === 'done') await archiveTaskDocuments(id);
    track('tasks', id);
    return rowAsTask((await tasks.get(id)) as TaskRow);
  },

  deleteTask: async (id) => {
    const { tasks, links } = await tables();
    const current = (await tasks.get(id)) ?? fail('tâche introuvable');
    await tasks.remove(id);
    for (const link of (await links.all()).filter((row) => row.task_id === id)) {
      await links.remove(link.id);
      untrack('links', link.id);
    }
    await renumber(current.status);
    untrack('tasks', id);
    tombstone('task', id);
    return { ok: true };
  },

  linkTaskDocument: async (taskId, entryId) => {
    const { tasks, entries, links } = await tables();
    const task = (await tasks.get(taskId)) ?? fail('tâche introuvable');
    if (!(await entries.get(entryId))) fail('entrée introuvable');
    const existing = await links.get(linkId(taskId, entryId));
    if (existing) return { task_id: existing.task_id, entry_id: existing.entry_id };
    const association = { id: linkId(taskId, entryId), task_id: taskId, entry_id: entryId, created_at: nowISO() };
    await links.put(association);
    if (task.status === 'done') await archiveTaskDocuments(taskId);
    track('links', association.id);
    return { task_id: taskId, entry_id: entryId };
  },

  unlinkTaskDocument: async (taskId, entryId) => {
    const { tasks, entries, links } = await tables();
    if (!(await tasks.get(taskId))) fail('tâche introuvable');
    if (!(await entries.get(entryId))) fail('entrée introuvable');
    if (!(await links.get(linkId(taskId, entryId)))) fail('association introuvable');
    await links.remove(linkId(taskId, entryId));
    untrack('links', linkId(taskId, entryId));
    tombstone('link', `${taskId}|${entryId}`);
    return { ok: true };
  },

  createProject: async (body) => {
    const { projects } = await tables();
    const name = str(body.name);
    if (!name) fail('nom requis');
    const time = nowISO();
    const row: ProjectRow = { id: uid('pr_'), name, color: str(body.color) || '#4f7cff', created_at: time, updated_at: time };
    await projects.put(row);
    track('projects', row.id);
    // Comme le serveur (`SELECT *`), sans les compteurs de `/api/state`.
    return row as unknown as Project;
  },

  updateProject: async (id, body) => {
    const { projects } = await tables();
    const current = (await projects.get(id)) ?? fail('projet introuvable');
    const patch = (body ?? {}) as { name?: string; color?: string };
    const name = pick(patch as Record<string, unknown>, 'name', current.name, (v) => str(v));
    if (!name) fail('nom requis');
    const next = { ...current, name, color: pick(patch as Record<string, unknown>, 'color', current.color, (v) => str(v) || current.color), updated_at: nowISO() };
    await projects.put(next);
    track('projects', id);
    return next as unknown as Project;
  },

  deleteProject: async (id) => {
    const { projects, entries, tasks } = await tables();
    if (!(await projects.get(id))) fail('projet introuvable');
    await projects.remove(id);
    // `ON DELETE SET NULL` : les entrées et tâches sont détachées, jamais perdues.
    for (const entry of (await entries.all()).filter((row) => row.project_id === id)) {
      await entries.put({ ...entry, project_id: null });
    }
    for (const task of (await tasks.all()).filter((row) => row.project_id === id)) {
      await tasks.put({ ...task, project_id: null });
    }
    untrack('projects', id);
    tombstone('project', id);
    return { ok: true };
  },

  deleteAttachment: async (id) => {
    const { attachments } = await tables();
    if (!(await attachments.get(id))) fail('pièce jointe introuvable');
    await attachments.remove(id);
    untrack('attachments', id);
    tombstone('attachment', id);
    return { ok: true };
  },

  fileUrl: (stored: string) => localFileUrl(stored),
  /** Même chemin PWA : le service worker sert le binaire IndexedDB `inline`. */
  previewUrl: (stored: string) => localFileUrl(stored, '/preview'),

  upload: async (file: File, entryId: string) => {
    const { entries, attachments } = await tables();
    if (!(await entries.get(entryId))) fail('entry_id requis et valide');
    if (file.size > MAX_UPLOAD_BYTES) fail('fichier trop volumineux (100 Mo max)');
    const stored = `${Date.now().toString(36)}_${file.name.replace(/[^\w.\-]+/g, '_')}`;
    const row: AttachmentRow = {
      id: uid('at_'), filename: file.name, stored, mime: file.type || '',
      size: file.size, entry_id: entryId, created_at: nowISO(), blob: file,
    };
    await attachments.put(row);
    track('attachments', row.id);
    return stripBlob(row);
  },

  exportBackup: async () => {
    const backup = await backupObject();
    return { filename: 'worklogs.json', blob: new Blob([JSON.stringify(backup)], { type: 'application/json' }) };
  },
};

async function backupObject() {
  const { projects, entries, tasks, links, attachments, google } = await tables();
  return {
    version: BACKUP_VERSION,
    exported_at: nowISO(),
    projects: await projects.all(),
    entries: (await entries.all()).map((row) => decodeEntry(row)),
    tasks: await tasks.all(),
    task_entries: (await links.all()).map(({ task_id, entry_id, created_at }) => ({ task_id, entry_id, created_at })),
    google_documents: await google.all(),
    attachments: (await attachments.all()).map(stripBlob),
  };
}

/** Instantané local pour la fusion : même forme validée que le fichier Drive, suppressions comprises. */
export async function localSyncSnapshot(): Promise<SyncSnapshot> {
  return { ...(validateBackup(await backupObject()) as Omit<SyncSnapshot, 'deleted'>), deleted: readLocalTombstones() };
}

export interface SyncSnapshot {
  projects: (ProjectRow & { updated_at: string })[];
  entries: (Omit<EntryRow, 'content_json'> & { content_json: RichDocument | null })[];
  tasks: TaskRow[];
  task_entries: { task_id: string; entry_id: string; created_at: string }[];
  google_documents: GoogleRow[];
  attachments: (Omit<AttachmentRow, 'blob'>)[];
  deleted: LocalTombstone[];
}

/**
 * Applique le résultat d'une fusion en ne touchant que ce qui a changé depuis
 * `base` (l'instantané local d'avant fusion). Une ligne modifiée ici entre-temps
 * (saisie pendant la synchro) n'est jamais écrasée : elle est comptée dans
 * `skipped` et repartira au passage suivant. Les binaires présents sont conservés.
 */
export async function applySyncSnapshot(merged: SyncSnapshot, base: SyncSnapshot): Promise<{ changed: number; skipped: number }> {
  const t = await tables();
  let changed = 0;
  let skipped = 0;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const stampOf = (row: { updated_at?: string; created_at?: string } | undefined) => row?.updated_at || row?.created_at || '';
  async function sync<Wanted extends object, Row extends object>(
    table: { all(): Promise<Row[]>; put(value: Row): Promise<void>; remove(key: string): Promise<void> },
    wanted: Wanted[], before: Wanted[], key: (row: Wanted | Row) => string, toRow: (row: Wanted, current?: Row) => Row,
    fields: string[],
  ) {
    const guarded = fields.length > 0;
    const baseMap = new Map(before.map((row) => [key(row), row]));
    const wantedMap = new Map(wanted.map((row) => [key(row), row]));
    const current = new Map((await table.all()).map((row) => [key(row), row]));
    // Modifiée depuis l'instantané ? Horodatage OU contenu : deux saisies peuvent
    // tomber dans la même milliseconde.
    const moved = (id: string) => {
      if (!guarded) return false;
      const now = current.get(id) as Record<string, unknown> | undefined;
      const was = baseMap.get(id) ? (toRow(baseMap.get(id) as Wanted) as Record<string, unknown>) : undefined;
      if (stampOf(now as never) !== stampOf(was as never)) return true;
      return fields.some((field) => JSON.stringify(now?.[field] ?? null) !== JSON.stringify(was?.[field] ?? null));
    };
    for (const [id, row] of wantedMap) {
      if (same(row, baseMap.get(id))) continue;
      if (baseMap.has(id) ? moved(id) : current.has(id) && guarded) { skipped++; continue; }
      await table.put(toRow(row, current.get(id)));
      changed++;
    }
    for (const id of baseMap.keys()) {
      if (wantedMap.has(id) || !current.has(id)) continue;
      if (moved(id)) { skipped++; continue; }
      await table.remove(id);
      changed++;
    }
  }
  await sync(t.projects, merged.projects, base.projects, (row) => (row as ProjectRow).id, (row) => ({ ...row }), ['name', 'color']);
  await sync(t.entries, merged.entries, base.entries, (row) => (row as EntryRow).id,
    (row) => ({ ...row, content_json: row.content_json ? JSON.stringify(row.content_json) : null }) as EntryRow,
    ['title', 'content_md', 'content_json', 'entry_date', 'project_id', 'archived', 'kind']);
  await sync(t.tasks, merged.tasks, base.tasks, (row) => (row as TaskRow).id, (row) => ({ ...row }),
    ['title', 'status', 'due_date', 'pinned', 'position', 'priority', 'project_id']);
  await sync(t.links, merged.task_entries, base.task_entries, (row) => linkId(row.task_id, row.entry_id),
    (row) => ({ id: linkId(row.task_id, row.entry_id), ...row }), []);
  await sync(t.google, merged.google_documents, base.google_documents, (row) => (row as GoogleRow).entry_id, (row) => ({ ...row }), []);
  await sync(t.attachments, merged.attachments, base.attachments, (row) => (row as AttachmentRow).id,
    (row, current) => ({ ...row, ...(current?.blob ? { blob: current.blob } : {}) }) as AttachmentRow, []);
  // Une suppression faite pendant la synchro n'est pas dans `base` : on la garde.
  const known = new Set(base.deleted.map((item) => `${item.kind}:${item.id}`));
  const fresh = readLocalTombstones().filter((item) => !known.has(`${item.kind}:${item.id}`));
  if (fresh.length) skipped++;
  writeLocalTombstones([...merged.deleted.filter((item) => !fresh.some((f) => f.kind === item.kind && f.id === item.id)), ...fresh]);
  return { changed, skipped };
}

/**
 * Remplace le contenu local par une sauvegarde validée — miroir de
 * `restoreBackup` (`api/src/backup.js`), sans transaction (un seul
 * utilisateur) mais avec validation préalable : rien n'est écrit si elle échoue.
 */
export async function importLocalBackup(input: unknown): Promise<{ ok: true; projects: number; entries: number; tasks: number }> {
  const data = validateBackup(input) as {
    projects: ProjectRow[]; entries: { id: string; title: string; content_md: string; content_json: RichDocument | null; entry_date: string; project_id: string | null; archived: 0 | 1; kind: 'note' | 'procedure'; created_at: string; updated_at: string }[];
    tasks: TaskRow[]; task_entries: { task_id: string; entry_id: string; created_at: string }[];
    google_documents: GoogleRow[]; attachments: { id: string; filename: string; stored: string; mime: string; size: number; entry_id: string; created_at: string; driveFileId?: string | null }[];
  };
  const t = await tables();
  const byName = { projects: t.projects, entries: t.entries, tasks: t.tasks, task_entries: t.links, google_documents: t.google, attachments: t.attachments };
  for (const name of ['task_entries', 'google_documents', 'attachments', 'tasks', 'entries', 'projects'] as const) {
    await byName[name].clear();
  }
  for (const project of data.projects) await t.projects.put(project);
  for (const entry of data.entries) {
    await t.entries.put({ ...entry, content_json: entry.content_json ? JSON.stringify(entry.content_json) : null });
  }
  for (const task of data.tasks) await t.tasks.put(task);
  for (const document of data.google_documents) await t.google.put(document);
  for (const file of data.attachments) await t.attachments.put(file);
  for (const link of data.task_entries) {
    await t.links.put({ id: linkId(link.task_id, link.entry_id), ...link });
  }
  // Nouvelle base de référence : la file d'envoi repart de zéro.
  clearLocalOutbox();
  return { ok: true, projects: data.projects.length, entries: data.entries.length, tasks: data.tasks.length };
}

export interface OutboxPayload {
  version: number;
  exported_at: string;
  base_exported_at: string | null;
  device: 'pwa';
  projects: ProjectRow[];
  entries: { id: string; title: string; content_md: string; content_json: RichDocument | null; entry_date: string; project_id: string | null; archived: 0 | 1; kind: 'note' | 'procedure'; created_at: string; updated_at: string }[];
  tasks: TaskRow[];
  task_entries: { task_id: string; entry_id: string; created_at: string }[];
  attachments: { id: string; filename: string; stored: string; mime: string; size: number; entry_id: string; created_at: string; driveFileId: string | null }[];
}

/**
 * Construit la « boîte mobile » : créations et modifications locales depuis le
 * dernier import, avec les métadonnées des pièces jointes (binaires envoyés
 * séparément). Vide si rien n'a changé.
 */
export async function exportLocalOutbox(baseExportedAt: string | null = null): Promise<OutboxPayload> {
  const t = await tables();
  const outbox = readLocalOutbox();
  const take = async <T extends { id: string }>(table: { get(key: string): Promise<T | undefined> }, ids: string[]): Promise<T[]> => {
    const rows: T[] = [];
    for (const id of ids) {
      const row = await table.get(id);
      if (row) rows.push(row);
    }
    return rows;
  };
  const entries = await take(t.entries, outbox.entries);
  const tasks = await take(t.tasks, outbox.tasks);
  const links = await take(t.links, outbox.links);
  const files = await take(t.attachments, outbox.attachments);
  return {
    version: OUTBOX_VERSION,
    exported_at: nowISO(),
    base_exported_at: baseExportedAt,
    device: 'pwa',
    projects: await take(t.projects, outbox.projects),
    entries: entries.map((row) => ({ ...row, content_json: row.content_json ? (JSON.parse(row.content_json) as RichDocument) : null })),
    tasks,
    task_entries: links.map(({ task_id, entry_id, created_at }) => ({ task_id, entry_id, created_at })),
    attachments: files.map(({ blob: _blob, driveFileId, ...meta }) => ({ ...meta, driveFileId: driveFileId ?? null })),
  };
}

export function outboxSize(outbox: LocalOutbox = readLocalOutbox()): number {
  return outbox.entries.length + outbox.tasks.length + outbox.links.length + outbox.attachments.length + outbox.projects.length;
}

/** Pièces jointes avec binaire local en attente d'envoi sur Drive. */
/** Synchro : tout binaire présent ici mais pas encore sur Drive (envoi raté, fichier d'avant la synchro…). */
export async function listLocalOnlyAttachments(): Promise<AttachmentRow[]> {
  const { attachments } = await tables();
  return (await attachments.all()).filter((row) => row.blob && !row.driveFileId);
}

export async function listPendingUploads(): Promise<AttachmentRow[]> {
  const { attachments } = await tables();
  const tracked = new Set(readLocalOutbox().attachments);
  return (await attachments.all()).filter((row) => tracked.has(row.id) && row.blob && !row.driveFileId);
}

/** Mémorise le fichier Drive d'un binaire envoyé (reprise après coupure). */
export async function markAttachmentUploaded(stored: string, driveFileId: string): Promise<void> {
  const { attachments } = await tables();
  const found = (await attachments.all()).find((row) => row.stored === stored);
  if (found) await attachments.put({ ...found, driveFileId });
}

/** Retélécharge les binaires Drive manquants en local (après un chargement). */
export async function fetchMissingDriveAttachments(): Promise<{ fetched: number; missing: number }> {
  const { attachments } = await tables();
  let fetched = 0;
  let missing = 0;
  for (const row of await attachments.all()) {
    if (row.blob || !row.driveFileId) continue;
    try {
      const blob = await downloadDriveBinary(row.driveFileId);
      await attachments.put({ ...row, blob, size: blob.size || row.size, mime: blob.type || row.mime });
      fetched++;
    } catch {
      missing++;
    }
  }
  return { fetched, missing };
}

function rowAsTask(row: TaskRow): Task {
  return { ...row, documents: [] };
}

async function taskWithDocuments(id: string): Promise<Task> {
  const { tasks, entries, links, google } = await tables();
  const row = (await tasks.get(id)) ?? fail('tâche introuvable');
  const googleByEntry = new Map((await google.all()).map((link) => [link.entry_id, link]));
  return { ...row, documents: taskDocuments(id, await entries.all(), await links.all(), googleByEntry) };
}
