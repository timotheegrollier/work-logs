import {
  ApiError,
  sharedClient,
  type Api,
  type AppState,
  type Category,
  type Attachment,
  type Entry,
  type EntrySummary,
  type FollowUp,
  type FollowUpKind,
  type FollowUpSnapshot,
  type GoogleStatus,
  type Project,
  type RichDocument,
  type Status,
  type Task,
  type TaskPlanningSnapshot,
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
// @ts-expect-error — résolution pure partagée avec l'API, sans dépendance Node.
import { TASK_CATEGORY_MIGRATION, inheritedTaskCategory } from '../../../api/src/task-categories.js';
// @ts-expect-error — contrat pur partagé avec SQLite, sans accès disque/réseau.
import { buildFollowUpSource, decodeFollowUpRow, followUpKey, readFollowUp, updateFollowUp } from '../../../api/src/follow-up.js';
// @ts-expect-error — même comparaison pure de planification que dans l'API SQLite.
import { assertExpectedTaskPlanning, taskPlanningUsesDocuments } from '../../../api/src/task-planning.js';
// @ts-expect-error — même comparaison pure d'entrée que dans l'API SQLite.
import { assertExpectedEntryEdit } from '../../../api/src/entry-edit.js';
// @ts-expect-error — même contrat de fusion que dans l'API SQLite.
import { assertEntryMergeReplay, assertEntryMergeSources, assertTaskMergeSources, isRewritableNote, taskMergeAttributes, taskMergeTaskId, entryMergeClassification, entryMergeTargetId, validateEntryMerge } from '../../../api/src/entry-merge.js';
// @ts-expect-error — normalisation pure partagée avec SQLite et les sauvegardes.
import { normalizeTaskNotes } from '../../../api/src/task-notes.js';
// @ts-expect-error — validation commune des statuts et de l’avancement.
import { taskCreationStamp, taskIdForNote, taskState } from '../../../api/src/task-state.js';
import { readRelay } from '../relay-settings';
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
import { createIndexedDbDatabase, createMemoryDatabase, type Database, type StoreWrite, type Table } from './storage';

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
/** Comparaison de recherche sans accents ni capitales, comme `fold` côté serveur. */
const foldSearch = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Titre + texte repliés d'une note, recalculés seulement quand elle change. */
const foldedEntries = new Map<string, { source: string; folded: string }>();
const foldedEntry = (entry: { id: string; title: string; content_md: string }): string => {
  const source = `${entry.title}\n${entry.content_md}`;
  const cached = foldedEntries.get(entry.id);
  if (cached?.source === source) return cached.folded;
  const folded = foldSearch(source);
  foldedEntries.set(entry.id, { source, folded });
  return folded;
};
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
const SHARED_DESKTOP_ONLY = 'Dossier partagé : règle le relais dans Paramètres (ou utilise l’application desktop).';

/** Le relais du dossier partagé réglé sur ce téléphone, ou `null`. */
function relayClient() {
  const settings = readRelay();
  return settings ? sharedClient(settings.url) : null;
}
const relay = () => relayClient() ?? fail(SHARED_DESKTOP_ONLY);
const fail = (message: string): never => {
  throw new ApiError(message);
};
const ext = (name: string): string => /(\.[^.]+)$/.exec(name)?.[1] ?? '';
/** Comparaison texte, comme les colonnes TEXT de SQLite (dates ISO, ids ASCII). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface EntryRow {
  id: string; title: string; content_md: string; content_json: string | null;
  entry_date: string; project_id: string | null; category_id?: string | null; archived: 0 | 1; kind: 'note' | 'procedure';
  status?: Status;
  created_at: string; updated_at: string;
  follow_up?: FollowUp | null;
}
interface TaskRow {
  entry_id: string; progress: number;
  id: string; title: string; status: Status; due_date: string | null; pinned: 0 | 1;
  position: number; priority: 'low' | 'normal' | 'high'; project_id: string | null; category_id?: string | null;
  created_at: string; updated_at: string;
  follow_up?: FollowUp | null;
}
interface CategoryRow { id: string; name: string; color: string; project_id: string; parent_id: string | null; created_at: string; updated_at: string }
interface ProjectRow { id: string; name: string; color: string; created_at: string; updated_at?: string; shared_dir?: string | null }
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

// Serialize relational mutations and sync application on this browser. A graph
// edit cannot slip between two IndexedDB awaits of another graph operation.
let localWrites: Promise<unknown> = Promise.resolve();
function localWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = localWrites.catch(() => {}).then(operation);
  localWrites = result;
  return result;
}

let backend: Database | null = null;
let initialization: Promise<void> | null = null;

type TaskCategoryTables = { database: Database; tasks: Table<TaskRow>; entries: Table<EntryRow>; links: Table<LinkRow> };

async function inheritLocalTaskCategories(tables: TaskCategoryTables, time: string, scope: { taskId?: string; entryId?: string; excludeTaskId?: string } = {}): Promise<void> {
  const allTasks = await tables.tasks.all();
  const allLinks = await tables.links.all();
  const entries = new Map((await tables.entries.all()).map((entry) => [entry.id, entry]));
  for (const task of allTasks) {
    if (task.category_id || task.id === scope.excludeTaskId || (scope.taskId && task.id !== scope.taskId)) continue;
    const links = allLinks.filter((link) => link.task_id === task.id);
    if (scope.entryId && !links.some((link) => link.entry_id === scope.entryId)) continue;
    const documents = links.filter((link) => link.entry_id !== task.entry_id).flatMap((link) => entries.get(link.entry_id) ? [entries.get(link.entry_id)!] : []);
    const categoryId = inheritedTaskCategory(task, documents) as string | null;
    if (!categoryId) continue;
    const note = entries.get(task.entry_id);
    if (note) {
      await tables.database.writeAll([
        { table: 'entries', value: { ...note, category_id: categoryId, updated_at: time } },
        { table: 'tasks', value: { ...task, category_id: categoryId } },
      ]);
      track('entries', note.id, false);
    } else {
      await tables.tasks.put({ ...task, category_id: categoryId, updated_at: time });
    }
    track('tasks', task.id, false);
  }
}

async function initializeDatabase(database: Database): Promise<void> {
  const seeded = await seed(database);
  let migrate = true;
  try { migrate = localStorage.getItem(TASK_CATEGORY_MIGRATION) !== '1'; } catch { /* Stockage des préférences indisponible. */ }
  const tasks = database.table<TaskRow>('tasks');
  const entries = database.table<EntryRow>('entries');
  const links = database.table<LinkRow>('task_entries');
  if (migrate) {
    await inheritLocalTaskCategories({ database, tasks, entries, links }, nowISO());
    try { localStorage.setItem(TASK_CATEGORY_MIGRATION, '1'); } catch { /* Les données restent conservées dans le backend. */ }
  }
  const current = {
    entries: await entries.all(), tasks: await tasks.all(), task_entries: await links.all(),
    google_documents: await database.table<GoogleRow>('google_documents').all(),
  };
  const normalized = normalizeTaskNotes(current) as typeof current;
  const writes: StoreWrite[] = [];
  const added: { kind: 'entries' | 'tasks' | 'links'; id: string }[] = [];
  const schedule = (table: string, kind: typeof added[number]['kind'], before: { id: string }[], after: { id: string }[]) => {
    const old = new Map(before.map((row) => [row.id, row]));
    for (const row of after) {
      if (JSON.stringify(old.get(row.id)) === JSON.stringify(row)) continue;
      writes.push({ table, value: row });
      added.push({ kind, id: row.id });
    }
  };
  schedule('entries', 'entries', current.entries, normalized.entries);
  schedule('tasks', 'tasks', current.tasks, normalized.tasks);
  schedule('task_entries', 'links', current.task_entries, normalized.task_entries.map((row) => ({ ...row, id: linkId(row.task_id, row.entry_id) })));
  await database.writeAll(writes);
  if (!seeded) for (const { kind, id } of added) track(kind, id, false);
}

async function tables() {
  const database = backend ??= typeof indexedDB === 'undefined' ? createMemoryDatabase() : createIndexedDbDatabase();
  const ready = initialization ??= initializeDatabase(database);
  try { await ready; } catch (error) { if (initialization === ready) initialization = null; throw error; }
  return {
    database,
    projects: database.table<ProjectRow>('projects'),
    categories: database.table<CategoryRow>('categories'),
    entries: database.table<EntryRow>('entries'),
    tasks: database.table<TaskRow>('tasks'),
    links: database.table<LinkRow>('task_entries'),
    attachments: database.table<AttachmentRow>('attachments'),
    google: database.table<GoogleRow>('google_documents'),
  };
}

/** Même validation de classement que le serveur. */
async function categoryFor(value: unknown, projectId: string | null): Promise<string | null> {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail('catégorie invalide');
  const id = str(value);
  if (!id) return null;
  const { categories } = await tables();
  const category = (await categories.get(id)) ?? fail('catégorie introuvable');
  if (category.project_id !== projectId) fail('la catégorie doit appartenir au même projet');
  return id;
}
async function categoryForPatch(body: Record<string, unknown>, current: { project_id: string | null; category_id?: string | null }, projectId: string | null): Promise<string | null> {
  return body['category_id'] !== undefined ? categoryFor(body['category_id'], projectId)
    : projectId === current.project_id ? current.category_id ?? null : null;
}
async function categoryValues(body: Record<string, unknown>, current?: CategoryRow): Promise<Omit<CategoryRow, 'id' | 'created_at' | 'updated_at'>> {
  const name = body['name'] === undefined && current ? current.name : str(body['name']);
  if (!name || name.length > 100) fail('nom de catégorie requis (100 caractères maximum)');
  const projectId = body['project_id'] === undefined && current ? current.project_id : str(body['project_id']);
  const { projects, categories } = await tables();
  if (!projectId || !(await projects.get(projectId))) fail('projet introuvable');
  if (current && projectId !== current.project_id) fail('une catégorie ne peut pas changer de projet');
  const parentId = body['parent_id'] === undefined ? current?.parent_id ?? null : await categoryFor(body['parent_id'], projectId);
  const color = body['color'] === undefined ? current?.color ?? '#64748b' : str(body['color']);
  if (!/^#[\da-f]{6}$/i.test(color)) fail('couleur de catégorie invalide (#RRGGBB attendu)');
  if (current) {
    let parent = parentId;
    const seen = new Set<string>();
    while (parent) {
      if (parent === current.id || seen.has(parent)) fail('une catégorie ne peut pas être rangée dans elle-même ou une sous-catégorie');
      seen.add(parent);
      parent = (await categories.get(parent))?.parent_id ?? null;
    }
  }
  return { name, project_id: projectId, parent_id: parentId, color };
}

/** Tests : substitue un backend frais (l'amorçage rejoue automatiquement). */
export function setLocalDatabase(next: Database | null): void {
  backend = next;
  initialization = null;
}

// ---------------------------------------------------------------- file d'envoi
// Créations et modifications locales à transmettre au PC via Drive (lot 4).
// `localStorage` uniquement : jamais de binaire, juste des identifiants.
const OUTBOX_KEY = 'worklogs-outbox';
export interface LocalOutbox {
  entries: string[]; tasks: string[]; links: string[]; attachments: string[]; projects: string[]; categories?: string[];
}
const emptyOutbox = (): LocalOutbox => ({ entries: [], tasks: [], links: [], attachments: [], projects: [], categories: [] });

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

function track(kind: keyof LocalOutbox, id: string, notify = true): void {
  const outbox = readLocalOutbox();
  if (!(outbox[kind] ?? []).includes(id)) {
    (outbox[kind] ??= []).push(id);
    writeOutbox(outbox);
  }
  if (notify) notifyLocalChange();
}

function untrack(kind: keyof LocalOutbox, id: string): void {
  const outbox = readLocalOutbox();
  outbox[kind] = (outbox[kind] ?? []).filter((current) => current !== id);
  writeOutbox(outbox);
  notifyLocalChange();
}

// ---------------------------------------------------------------- synchro Drive
// Suppressions à propager (pierres tombales, même format que le desktop) et
// signal « quelque chose a changé » pour la synchro automatique (sync-web.ts).
const DELETED_KEY = 'worklogs-sync-deleted';
export interface LocalTombstone { kind: 'project' | 'category' | 'entry' | 'task' | 'link' | 'attachment'; id: string; deleted_at: string }
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
async function seed(db: Database): Promise<boolean> {
  if ((await db.table<ProjectRow>('projects').all()).length > 0
    || (await db.table<EntryRow>('entries').all()).length > 0
    || (await db.table<TaskRow>('tasks').all()).length > 0) return false;
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
  const tasks = db.table<Omit<TaskRow, 'entry_id' | 'progress'>>('tasks');
  await tasks.put({ id: 'tk_1', title: 'Écrire ma première entrée', status: 'todo', due_date: plus(0), pinned: 1, position: 0, priority: 'normal', project_id: 'pr_perso', created_at: t, updated_at: t });
  await tasks.put({ id: 'tk_2', title: 'Créer mes projets', status: 'todo', due_date: null, pinned: 0, position: 1, priority: 'normal', project_id: 'pr_perso', created_at: t, updated_at: t });
  await tasks.put({ id: 'tk_3', title: 'Prendre en main WorkLogs', status: 'doing', due_date: null, pinned: 0, position: 0, priority: 'normal', project_id: 'pr_pro', created_at: t, updated_at: t });
  return true;
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
      id: target.id, title: target.title, entry_date: target.entry_date, project_id: target.project_id, category_id: target.category_id ?? null,
      archived: target.archived ?? 0, kind: target.kind ?? 'note', status: target.status ?? 'todo',
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

async function localFollowUpSnapshot(kind: FollowUpKind, id: string): Promise<FollowUpSnapshot> {
  if (kind !== 'entry' && kind !== 'task') fail('type de suivi invalide (entry ou task attendu)');
  const t = await tables();
  const entity = (kind === 'entry' ? await t.entries.get(id) : await t.tasks.get(id))
    ?? fail(kind === 'entry' ? 'entrée introuvable' : 'tâche introuvable');
  const linked = new Set(kind === 'task' ? (await t.links.all()).filter((link) => link.task_id === id).map((link) => link.entry_id) : []);
  const documents = kind === 'entry' ? [entity as EntryRow] : (await t.entries.all()).filter((entry) => linked.has(entry.id));
  const googleIds = new Set((await t.google.all()).map((link) => link.entry_id));
  const project = entity.project_id ? await t.projects.get(entity.project_id) : null;
  const source = buildFollowUpSource(kind, entity, documents.map((entry) => ({ ...entry, google: googleIds.has(entry.id) })), project);
  return { follow_up: readFollowUp(entity.follow_up), source_key: followUpKey(source), source };
}

async function localFollowUpMetadata<T extends EntryRow | TaskRow>(kind: FollowUpKind, row: T): Promise<T & { follow_up_key?: string }> {
  const decoded = decodeFollowUpRow(row) as T;
  return decoded.follow_up ? { ...decoded, follow_up_key: (await localFollowUpSnapshot(kind, row.id)).source_key } : decoded;
}

async function fullEntry(id: string): Promise<Entry> {
  const { entries, attachments, tasks } = await tables();
  const row = (await entries.get(id)) ?? fail('entrée introuvable');
  const files = (await attachments.all())
    .filter((a) => a.entry_id === id)
    .sort((a, b) => cmp(b.created_at, a.created_at))
    .map(stripBlob);
  const entry = { ...decodeEntry(await localFollowUpMetadata('entry', row)), attachments: files } as Entry;
  const task = (await tasks.all()).find((item) => item.entry_id === id);
  entry.task = task ? await localFollowUpMetadata('task', task) : null;
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
        project_id: entry.project_id, category_id: entry.category_id ?? null, archived: entry.archived ?? 0, kind: entry.kind ?? 'note', status: entry.status ?? 'todo', updated_at: entry.updated_at,
        excerpt: '', attachments: 0,
        google_document_id: link?.document_id ?? null, google_tab_id: link?.tab_id ?? null,
        google_document_title: link?.document_title ?? null, google_tab_title: link?.tab_title ?? null,
      };
    });
}

const nextTaskPosition = (tasks: TaskRow[], status: Status) =>
  tasks.filter((task) => task.status === status).reduce((last, task) => Math.max(last, task.position), -1) + 1;

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

/** Les notes suivies restent visibles ; seuls les documents de référence sont archivés. */
async function taskReferencesToArchive(taskId: string, time: string): Promise<EntryRow[]> {
  const { entries, links, tasks } = await tables();
  const linked = new Set((await links.all()).filter((link) => link.task_id === taskId).map((link) => link.entry_id));
  const primaries = new Set((await tasks.all()).map((task) => task.entry_id));
  return (await entries.all())
    .filter((entry) => linked.has(entry.id) && !entry.archived && !primaries.has(entry.id))
    .map((entry) => ({ ...entry, archived: 1, updated_at: time }));
}

async function archiveTaskDocuments(taskId: string): Promise<void> {
  const { database } = await tables();
  const archived = await taskReferencesToArchive(taskId, nowISO());
  await database.writeAll(archived.map((value) => ({ table: 'entries', value })));
  for (const entry of archived) track('entries', entry.id);
}

function taskStateFor(status: unknown, progress: unknown, current?: Pick<TaskRow, 'status' | 'progress'>): Pick<TaskRow, 'status' | 'progress'> {
  try {
    return taskState(status, progress, current);
  } catch (error) {
    return fail((error as Error).message);
  }
}

function taskNote(task: Pick<TaskRow, 'entry_id' | 'title' | 'status' | 'project_id' | 'category_id' | 'created_at' | 'updated_at'>, content: string): EntryRow {
  return {
    id: task.entry_id, title: task.title, content_md: content, content_json: null, entry_date: today(),
    project_id: task.project_id, category_id: task.category_id ?? null, archived: 0, kind: 'note',
    status: task.status, created_at: task.created_at, updated_at: task.updated_at,
  };
}

function taskLink(taskId: string, entryId: string, time: string): LinkRow {
  return { id: linkId(taskId, entryId), task_id: taskId, entry_id: entryId, created_at: time };
}

async function addTaskNote(task: TaskRow, note: EntryRow, source?: EntryRow, convert = false): Promise<Task> {
  const { database, tasks } = await tables();
  const primary = taskLink(task.id, note.id, task.created_at);
  const reference = source && taskLink(task.id, source.id, task.created_at);
  const archived = reference && task.status === 'done' && !source.archived
    && !(await tasks.all()).some((item) => item.entry_id === source.id);
  await database.writeAll([
    { table: 'entries', value: note, operation: convert ? 'put' : 'add' },
    { table: 'tasks', value: task, operation: 'add' },
    { table: 'task_entries', value: primary, operation: 'add' },
    ...(reference ? [{ table: 'task_entries', value: reference, operation: 'add' as const }] : []),
    ...(archived && source ? [{ table: 'entries', value: { ...source, archived: 1, updated_at: task.created_at } }] : []),
  ]);
  if (convert) writeLocalTombstones(readLocalTombstones().filter((item) => item.kind !== 'task' || item.id !== task.id));
  track('entries', note.id, false);
  track('tasks', task.id, false);
  track('links', primary.id, false);
  if (reference) track('links', reference.id, false);
  if (archived && source) track('entries', source.id, false);
  notifyLocalChange();
  return taskWithDocuments(task.id);
}

async function writeTaskUpdate(current: TaskRow, next: TaskRow): Promise<void> {
  const { database, entries } = await tables();
  const note = await entries.get(current.entry_id);
  const noteChanged = note && (note.title !== next.title || note.project_id !== next.project_id || (note.category_id ?? null) !== (next.category_id ?? null));
  const archived = current.status !== 'done' && next.status === 'done' ? await taskReferencesToArchive(current.id, next.updated_at) : [];
  const noteUpdates = [...archived];
  if (note && (noteChanged || note.status !== next.status)) {
    noteUpdates.push({
      ...note, title: next.title, project_id: next.project_id, category_id: next.category_id, status: next.status,
      updated_at: noteChanged ? nowISO() : note.updated_at,
    });
  }
  await database.writeAll([
    { table: 'tasks', value: next },
    ...noteUpdates.map((value) => ({ table: 'entries', value })),
  ]);
  for (const entry of noteUpdates) track('entries', entry.id, false);
  track('tasks', next.id);
}

/** La note fusionnée reprend les fichiers et les liens aux tâches de sa source, qui disparaît. */
async function mergeLocalNotes(
  note: EntryRow,
  absorbed: Entry[],
  mergedTask?: TaskRow,
  replacedTasks: TaskRow[] = [],
  references: Entry[] = [],
): Promise<void> {
  const { database, links, attachments } = await tables();
  const time = note.updated_at;
  const removedEntries = new Set(absorbed.map(({ id }) => id));
  const removedTasks = new Set(replacedTasks.map(({ id }) => id));
  const files = (await attachments.all()).filter((file) => removedEntries.has(file.entry_id));
  const changedLinks = (await links.all()).filter((link) => removedEntries.has(link.entry_id) || removedTasks.has(link.task_id));
  const targetLinks = new Map<string, LinkRow>();
  const addLink = (taskId: string, entryId: string) => {
    const link = taskLink(taskId, entryId, time);
    targetLinks.set(link.id, link);
  };
  for (const link of changedLinks) {
    if (!removedTasks.has(link.task_id)) addLink(link.task_id, note.id);
  }
  if (mergedTask) {
    addLink(mergedTask.id, note.id);
    for (const reference of references) addLink(mergedTask.id, reference.id);
  }
  await database.writeAll([
    { table: 'entries', value: note, operation: 'add' },
    ...changedLinks.map(({ id }) => ({ table: 'task_entries', key: id, operation: 'delete' as const })),
    ...[...targetLinks.values()].map((value) => ({ table: 'task_entries', value })),
    ...files.map((file) => ({ table: 'attachments', value: { ...file, entry_id: note.id } })),
    ...[...removedTasks].map((key) => ({ table: 'tasks', key, operation: 'delete' as const })),
    ...(mergedTask ? [{ table: 'tasks', value: mergedTask }] : []),
    ...[...removedEntries].map((key) => ({ table: 'entries', key, operation: 'delete' as const })),
  ]);
  track('entries', note.id, false);
  if (mergedTask) track('tasks', mergedTask.id, false);
  for (const file of files) track('attachments', file.id, false);
  for (const link of changedLinks) untrack('links', link.id);
  for (const link of targetLinks.values()) track('links', link.id, false);
  for (const id of removedEntries) {
    untrack('entries', id);
    tombstone('entry', id);
  }
  for (const id of removedTasks) {
    untrack('tasks', id);
    tombstone('task', id);
  }
  notifyLocalChange();
}

/** Retire le suivi et ses liens en conservant la note et son contenu. */
async function removeTask(task: TaskRow): Promise<void> {
  const { database, links, entries } = await tables();
  const associations = (await links.all()).filter((row) => row.task_id === task.id);
  const note = await entries.get(task.entry_id);
  await database.writeAll([
    { table: 'tasks', key: task.id, operation: 'delete' },
    ...associations.map(({ id }) => ({ table: 'task_entries', key: id, operation: 'delete' as const })),
    ...(note ? [{ table: 'entries', value: { ...note, updated_at: nowISO() } }] : []),
  ]);
  if (note) track('entries', note.id, false);
  for (const link of associations) {
    untrack('links', link.id);
    if (link.entry_id !== task.entry_id) tombstone('link', `${task.id}|${link.entry_id}`);
  }
  untrack('tasks', task.id);
  tombstone('task', task.id);
}

/** Lecture Docs ciblée sur l'onglet lié (miroir de `read` dans `google-routes.js`). */
async function readGoogleSource(documentId: string, tabId = '') {
  if (!/^[\w-]{1,200}$/.test(documentId)) fail('Identifiant de document Google invalide.');
  const raw = await webGoogleRequest(`/docs/v1/documents/${documentId}?includeTabsContent=true`);
  return selectDocumentTab(raw, tabId);
}

const blankGoogleSource = () => ({ body: { content: [{ paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } });

export const localApi: Api = {
  followUp: localFollowUpSnapshot,
  saveFollowUp: async (kind, id, body) => {
    const value = await localFollowUpSnapshot(kind, id);
    const stamp = nowISO();
    let next: FollowUp;
    try { next = updateFollowUp(value.follow_up, body, value.source_key, stamp) as FollowUp; }
    catch (error) {
      const failure = error as Error & { code?: string };
      throw new ApiError(failure.message, failure.code);
    }
    const t = await tables();
    if (kind === 'entry') {
      const row = (await t.entries.get(id)) ?? fail('entrée introuvable');
      await t.entries.put({ ...row, follow_up: next });
      track('entries', id);
    } else {
      const row = (await t.tasks.get(id)) ?? fail('tâche introuvable');
      await t.tasks.put({ ...row, follow_up: next });
      track('tasks', id);
    }
    return { ...value, follow_up: next };
  },
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
    const files = [...(result.files || [])];
    if (!pageToken) {
      // Un document créé ou ouvert ici peut manquer à l'index Drive un instant :
      // sa copie locale le garde visible sans attendre un « Actualiser ».
      for (const documentId of local.keys()) {
        if (files.some((file) => file.id === documentId)) continue;
        try {
          const file = (await webGoogleRequest(`/drive/v3/files/${encodeURIComponent(documentId)}?fields=id,name,modifiedTime,mimeType,trashed&supportsAllDrives=true`)) as {
            id: string; name: string; modifiedTime?: string; mimeType?: string; trashed?: boolean;
          };
          if (!file.trashed && file.mimeType === 'application/vnd.google-apps.document') {
            files.push({ id: file.id, name: file.name, modifiedTime: file.modifiedTime || '' });
          }
        } catch {
          // Un document local inaccessible ne doit pas masquer les autres.
        }
      }
    }
    files.sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
    return {
      files: files.map((file) => ({ ...file, ...(local.get(file.id) ?? { linked: false, project_id: null }) })),
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
    return localWrite(async () => {
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
    });
  },
  googleDocumentTabs: async () => fail('Google Drive est disponible dans l’application desktop.'),
  openGoogleDocument: async (documentId, tabId) => {
    if (!/^[\w-]{1,200}$/.test(documentId)) fail('Identifiant de document Google invalide.');
    if (tabId !== undefined && (typeof tabId !== 'string' || (tabId && !/^[\w.-]{1,200}$/.test(tabId)))) {
      fail('Identifiant d’onglet Google invalide.');
    }
    const source = (await webGoogleRequest(`/docs/v1/documents/${documentId}?includeTabsContent=true`)) as Record<string, unknown>;
    const allTabs = documentTabs(source);
    const list: { id: string; title: string; depth: number }[] = allTabs.length ? allTabs : [{ id: '', title: (source.title as string) || 'Document', depth: 0 }];
    if (tabId && !list.some((tab) => tab.id === tabId)) fail('Onglet Google introuvable.');
    const documentTitle = (source.title as string) || 'Document Google';
    return localWrite(async () => {
      const t = await tables();
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
    });
  },
  pushGoogleDocument: async (id) => {
    const t = await tables();
    const current = (await t.entries.get(id)) ?? fail('entrée introuvable');
    if ((await t.tasks.all()).some((task) => task.entry_id === id)) fail('Retire le suivi de la tâche avant de l’associer à Google Drive.');
    const currentJson: string = current.content_json ?? fail('Crée un document riche pour le synchroniser avec Google Drive.');
    let rich = JSON.parse(currentJson) as RichDocument;
    let link = (await t.google.get(id)) ?? null;
    if (link?.readonly_reason) {
      fail('Cet ancien import a été aplati. Garde une copie locale de tes modifications puis recharge depuis Google pour activer la nouvelle synchronisation.');
    }
    if (!link) {
      link = await localWrite(async () => {
        const latest = (await t.entries.get(id)) ?? fail('entrée introuvable');
        if ((await t.tasks.all()).some((task) => task.entry_id === id)) fail('Retire le suivi de la tâche avant de l’associer à Google Drive.');
        const existing = await t.google.get(id);
        if (existing) return existing;
        if (latest.content_json !== currentJson) fail('Le brouillon a changé. Enregistre-le avant de l’associer à Google Drive.');
        // Vérifier le format avant de créer un fichier distant.
        buildGoogleUpdate({ revisionId: 'check', body: { content: [{ paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } }, rich);
        const created = (await webGoogleRequest('/docs/v1/documents', { method: 'POST', body: JSON.stringify({ title: latest.title }) })) as Record<string, unknown>;
        const rawId: unknown = created['documentId'];
        const documentId: string = typeof rawId === 'string' && /^[\w-]{1,200}$/.test(rawId) ? rawId : fail('Identifiant de document Google invalide.');
        const fresh = await readGoogleSource(documentId);
        const createdLink: GoogleRow = {
          entry_id: id, document_id: documentId, tab_id: documentBody(fresh).tabId || '', revision_id: fresh.revisionId || '',
          synced_content_json: JSON.stringify(importGoogleDocument(fresh)),
          synced_at: null, document_title: '', tab_title: '', tab_order: 0, tab_depth: 0, readonly_reason: '',
        };
        await t.google.put(createdLink);
        return createdLink;
      });
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
    return localWrite(async () => {
      // La révision vaut pour tout le document : ne pas créer de faux conflit
      // sur les autres onglets lus à cette même révision (miroir serveur).
      for (const sibling of (await t.google.all()).filter((row) => row.document_id === (link as GoogleRow).document_id && row.revision_id === source.revisionId && row.entry_id !== id)) {
        await t.google.put({ ...sibling, revision_id: revision });
      }
      const serialized = JSON.stringify(rich);
      const latest = ((await t.entries.get(id)) ?? fail('entrée introuvable')) as EntryRow;
      const latestLink = (await t.google.get(id)) ?? fail('Ce document n’est pas encore associé à Google Drive.');
      if (latestLink.document_id !== link?.document_id || latestLink.tab_id !== link?.tab_id) fail('L’association Google a changé pendant l’envoi. Recharge le document.');
      const local = latest.content_json === current.content_json
        ? rich
        : mergeGoogleChanges(JSON.parse(current.content_json as string), JSON.parse(latest.content_json as string), rich);
      await t.entries.put({ ...latest, content_json: JSON.stringify(local), content_md: documentText(local), updated_at: latest.updated_at });
      await t.google.put({ ...latestLink, revision_id: revision, synced_content_json: serialized, synced_at: nowISO() });
      // Google porte désormais la modification : la file d'envoi vers le PC n'a plus à la transmettre.
      untrack('entries', id);
      return fullEntry(id);
    });
  },
  pullGoogleDocument: async (id, expected) => {
    const t = await tables();
    const current = (await t.entries.get(id)) ?? fail('entrée introuvable');
    const link = (await t.google.get(id)) ?? fail('Ce document n’est pas encore associé à Google Drive.');
    if (JSON.stringify(expected) !== current.content_json) fail('Le brouillon a changé. Enregistre-le avant de recharger Google.');
    const source = await readGoogleSource(link.document_id, link.tab_id);
    const rich = importGoogleDocument(source);
    return localWrite(async () => {
      const latest = (await t.entries.get(id)) ?? fail('entrée introuvable');
      if (latest.content_json !== current.content_json) fail('Tu as modifié le brouillon pendant le rechargement. Il a été conservé.');
      const latestLink = (await t.google.get(id)) ?? fail('Ce document n’est pas encore associé à Google Drive.');
      if (latestLink.document_id !== link.document_id || latestLink.tab_id !== link.tab_id) fail('L’association Google a changé pendant le rechargement. Recharge le document.');
      const serialized = JSON.stringify(rich);
      const time = nowISO();
      await t.entries.put({ ...latest, content_json: serialized, content_md: documentText(rich), updated_at: time });
      await t.google.put({ ...latestLink, revision_id: source.revisionId || '', synced_content_json: serialized, synced_at: time, readonly_reason: '' });
      track('entries', id);
      return fullEntry(id);
    });
  },

  state: async (q = '', projectId = '', categoryId = ''): Promise<AppState> => {
    const { projects, categories, entries, tasks, links, attachments, google } = await tables();
    const allCategories = await categories.all();
    const selected = new Set(categoryId ? [categoryId] : []);
    if (categoryId && categoryId !== '__none__') {
      let changed = true;
      while (changed) {
        changed = false;
        for (const category of allCategories) if (category.parent_id && selected.has(category.parent_id) && !selected.has(category.id)) { selected.add(category.id); changed = true; }
      }
    }
    const matchesCategory = (row: { category_id?: string | null }) => !categoryId || (categoryId === '__none__' ? !row.category_id : selected.has(row.category_id || ''));
    const allEntries = await entries.all();
    const allTasks = await tasks.all();
    const tasksByEntry = new Map(allTasks.map((task) => [task.entry_id, task]));
    const allLinks = await links.all();
    const allAttachments = await attachments.all();
    const googleByEntry = new Map((await google.all()).map((row) => [row.entry_id, row]));
    const allProjects = (await projects.all()).sort((a, b) => cmp(a.name, b.name));
    const metadata = <T extends EntryRow | TaskRow>(kind: FollowUpKind, row: T): T & { follow_up_key?: string } => {
      const decoded = decodeFollowUpRow(row) as T;
      if (!decoded.follow_up) return decoded;
      const linked = new Set(kind === 'task' ? allLinks.filter((link) => link.task_id === row.id).map((link) => link.entry_id) : [row.id]);
      const documents = allEntries.filter((entry) => linked.has(entry.id)).map((entry) => ({ ...entry, google: googleByEntry.has(entry.id) }));
      const source = buildFollowUpSource(kind, row, documents, allProjects.find((project) => project.id === row.project_id));
      return { ...decoded, follow_up_key: followUpKey(source) };
    };
    const needle = foldSearch(q.trim());
    const matching = allEntries
      .filter((entry) => (!projectId || entry.project_id === projectId) && matchesCategory(entry))
      // Comme le serveur (§58) : sans accents ni capitales, texte replié gardé par note.
      .filter((entry) => !needle || foldedEntry(entry).includes(needle))
      .sort((a, b) => cmp(b.entry_date, a.entry_date) || cmp(b.updated_at, a.updated_at));
    const counts = new Map<string, number>();
    for (const file of allAttachments) counts.set(file.entry_id, (counts.get(file.entry_id) ?? 0) + 1);
    const summaries = matching.map((entry) => {
      const link = googleByEntry.get(entry.id);
      const task = tasksByEntry.get(entry.id);
      return {
        id: entry.id, title: entry.title, entry_date: entry.entry_date, project_id: entry.project_id, category_id: entry.category_id ?? null,
        archived: entry.archived ?? 0, kind: entry.kind ?? 'note', status: entry.status ?? 'todo',
        updated_at: entry.updated_at, excerpt: entry.content_md.slice(0, 240),
        attachments: counts.get(entry.id) ?? 0,
        google_document_id: link?.document_id ?? null, google_tab_id: link?.tab_id ?? null,
        google_document_title: link?.document_title ?? null, google_tab_title: link?.tab_title ?? null,
        google_tab_order: link?.tab_order ?? null, google_tab_depth: link?.tab_depth ?? null,
        google_sync_blocked: link?.readonly_reason ?? null,
        google_dirty: link ? entry.content_json !== link.synced_content_json : false,
        follow_up: entry.follow_up ?? null,
        ...(task && { task: metadata('task', task) }),
        ...(entry.follow_up ? { follow_up_key: metadata('entry', entry).follow_up_key } : {}),
      };
    });
    const matchingIds = new Set(matching.map(({ id }) => id));
    const matchingTasks = allTasks
      .filter((task) => (!projectId || task.project_id === projectId) && matchesCategory(task))
      .filter((task) => !needle || matchingIds.has(task.entry_id) || (!task.entry_id && foldSearch(task.title).includes(needle)))
      .sort((a, b) => a.position - b.position || cmp(b.updated_at, a.updated_at) || cmp(a.id, b.id))
      .map((task) => ({ ...metadata('task', task), documents: taskDocuments(task.id, allEntries, allLinks, googleByEntry) }));
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
      categories: allCategories.sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id)).map((category) => ({ ...category, entries: allEntries.filter((entry) => entry.category_id === category.id).length, open_tasks: allTasks.filter((task) => task.category_id === category.id && task.status !== 'done').length })),
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
    const status = body.status === undefined ? 'todo' : body.status;
    if (!STATUSES.includes(status)) fail('statut invalide');
    const id = uid('en_');
    const t = nowISO();
    const rich = body.content_json == null ? null : validateDocument(body.content_json);
    await entries.put({
      id, title, content_md: rich ? documentText(rich) : typeof body.content_md === 'string' ? body.content_md : '',
      entry_date: date, project_id: orNull(body.project_id), category_id: await categoryFor(body.category_id, orNull(body.project_id)), archived: 0, kind, status, created_at: t, updated_at: t,
      content_json: rich ? JSON.stringify(rich) : null,
    });
    track('entries', id);
    return fullEntry(id);
  },

  updateEntry: async (id, body) => {
    const t = await tables();
    const { entries, projects } = t;
    const current = await fullEntry(id);
    const patch = (body ?? {}) as Record<string, unknown>;
    try {
      assertExpectedEntryEdit(patch.expected_entry, current, patch.content_md !== undefined || patch.content_json !== undefined);
    } catch (cause) {
      const error = cause as Error & { code?: string };
      throw new ApiError(error.message, error.code);
    }
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
    if (current.task && kind !== 'note') fail('Retire le suivi de la tâche avant de transformer la note en procédure.');
    const status = pick(patch, 'status', current.status ?? 'todo');
    if (!STATUSES.includes(status)) fail('statut invalide');
    const categoryId = await categoryForPatch(patch, current, projectId);
    const time = nowISO();
    const content = rich ? documentText(rich) : pick(patch, 'content_md', current.content_md, (v) => typeof v === 'string' ? v : current.content_md);
    const serialized = rich ? JSON.stringify(rich) : null;
    const sharedChanged = title !== row.title || projectId !== row.project_id || categoryId !== (row.category_id ?? null);
    const changed = sharedChanged || content !== row.content_md || serialized !== row.content_json || date !== row.entry_date
      || archived !== row.archived || kind !== row.kind;
    const note: EntryRow = {
      ...row, title, content_md: content, content_json: serialized, entry_date: date,
      project_id: projectId, category_id: categoryId, archived, kind, status,
      updated_at: current.task && !changed ? row.updated_at : time,
    };
    const task = current.task && (sharedChanged || current.task.status !== status) ? await t.tasks.get(current.task.id) : undefined;
    const state = task && taskStateFor(status, undefined, task);
    const archivedReferences = task && task.status !== 'done' && status === 'done'
      ? await taskReferencesToArchive(task.id, time) : [];
    if (task && state) {
      await t.database.writeAll([
        { table: 'entries', value: note },
        { table: 'tasks', value: {
          ...task, ...state, title, project_id: projectId, category_id: categoryId,
          position: task.status !== status ? nextTaskPosition(await t.tasks.all(), status) : task.position,
          updated_at: task.status !== status ? time : task.updated_at,
        } },
        ...archivedReferences.map((value) => ({ table: 'entries', value })),
      ]);
      if (task.status !== status) {
        await renumber(task.status);
        await renumber(status);
      }
      track('tasks', task.id, false);
      for (const reference of archivedReferences) track('entries', reference.id, false);
    } else await entries.put(note);
    track('entries', id, false);
    try {
      // Une tentative précédente peut avoir persisté l'entrée avant l'échec d'une tâche.
      if (patch['category_id'] !== undefined || patch['project_id'] !== undefined) await inheritLocalTaskCategories(t, time, { entryId: id, excludeTaskId: current.task?.id });
    } finally { notifyLocalChange(); }
    return fullEntry(id);
  },

  deleteEntry: async (id) => {
    const { database, entries, tasks, links, attachments } = await tables();
    if (!(await entries.get(id))) fail('entrée introuvable');
    const task = (await tasks.all()).find((row) => row.entry_id === id);
    const associations = (await links.all()).filter((row) => row.entry_id === id || row.task_id === task?.id);
    const files = (await attachments.all()).filter((row) => row.entry_id === id);
    await database.writeAll([
      { table: 'entries', key: id, operation: 'delete' },
      { table: 'google_documents', key: id, operation: 'delete' },
      ...(task ? [{ table: 'tasks', key: task.id, operation: 'delete' as const }] : []),
      ...associations.map(({ id }) => ({ table: 'task_entries', key: id, operation: 'delete' as const })),
      ...files.map(({ id }) => ({ table: 'attachments', key: id, operation: 'delete' as const })),
    ]);
    for (const link of associations) untrack('links', link.id);
    for (const file of files) untrack('attachments', file.id);
    if (task) {
      untrack('tasks', task.id);
      tombstone('task', task.id);
      await renumber(task.status);
    }
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
      project_id: original.project_id, category_id: original.category_id ?? null, archived: 0, kind: original.kind ?? 'note', created_at: time, updated_at: time,
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

  // Même contrat que POST /api/entries/merge (§70).
  mergeEntries: async (input) => {
    const body = validateEntryMerge(input);
    const id: string = await entryMergeTargetId(body);
    const { entries } = await tables();
    if (await entries.get(id)) {
      const replay = await fullEntry(id);
      assertEntryMergeReplay(body, replay);
      return replay;
    }
    const sources: (Entry | null)[] = [];
    for (const source of body.sources as { id: string }[]) sources.push((await entries.get(source.id)) ? await fullEntry(source.id) : null);
    assertEntryMergeSources(body, sources);
    const found = sources as Entry[];
    const tracked = found.flatMap((entry) => entry.task ? [entry] : []);
    if (tracked.length > 1) fail('Fusionne les tâches depuis le tableau pour réunir leurs notes.');
    const primary = tracked[0];
    const time = nowISO();
    const classification = primary
      ? { project_id: primary.project_id, category_id: primary.category_id ?? null, kind: 'note' as const }
      : entryMergeClassification(found) as Pick<EntryRow, 'project_id' | 'category_id' | 'kind'>;
    const task = primary?.task;
    await mergeLocalNotes({
      id, title: body.title, content_md: body.content_md, content_json: null, entry_date: today(),
      ...classification, archived: primary?.archived ?? 0, status: task?.status ?? 'todo', created_at: time, updated_at: time,
    }, found, task ? { ...task, entry_id: id, title: body.title, updated_at: time } : undefined);
    return fullEntry(id);
  },

  // Même contrat que POST /api/tasks/merge (§73).
  mergeTasks: async (input) => {
    const body = validateEntryMerge(input, 'tâches');
    const entryId: string = await entryMergeTargetId(body);
    const taskId: string = taskMergeTaskId(entryId);
    const { entries, tasks, links } = await tables();
    if (await tasks.get(taskId)) {
      const replay = (await entries.get(entryId)) ? await fullEntry(entryId) : ({} as Entry);
      assertEntryMergeReplay(body, replay);
      return replay;
    }
    const sources: (TaskRow | null)[] = [];
    for (const source of body.sources as { id: string }[]) sources.push((await tasks.get(source.id)) ?? null);
    const known = new Set((await entries.all()).map((entry) => entry.id));
    const documents = new Map<string, Entry[]>();
    for (const task of sources) {
      if (!task) continue;
      const linked: Entry[] = [];
      for (const link of (await links.all()).filter((row) => row.task_id === task.id && known.has(row.entry_id))) linked.push(await fullEntry(link.entry_id));
      documents.set(task.id, linked);
    }
    assertTaskMergeSources(body, sources, (id: string) => documents.get(id) ?? []);
    const found = sources as TaskRow[];
    const { status, progress, due_date, pinned, priority, project_id, category_id } = taskMergeAttributes(found);
    const time = nowISO();
    const position = nextTaskPosition(await tasks.all(), status);
    const task: TaskRow = {
      id: taskId, entry_id: entryId, title: body.title, status, progress,
      due_date, pinned, position, priority, project_id, category_id, created_at: time, updated_at: time,
    };
    const owned = new Set(found.map((item) => item.entry_id));
    const all = [...new Map([...documents.values()].flat().map((item) => [item.id, item])).values()];
    const absorbed = all.filter((entry) => isRewritableNote(entry) && owned.has(entry.id));
    const absorbedIds = new Set(absorbed.map(({ id }) => id));
    await mergeLocalNotes(taskNote(task, body.content_md), absorbed, task, found, all.filter(({ id }) => !absorbedIds.has(id)));
    for (const changed of new Set<Status>([status, ...found.map((task) => task.status)])) await renumber(changed);
    if (status === 'done') await archiveTaskDocuments(taskId);
    return fullEntry(entryId);
  },

  createTaskFromEntry: async (entryId, body) => {
    const { entries, tasks, google } = await tables();
    const source = (await entries.get(entryId)) ?? fail('entrée introuvable');
    const title = body?.title === undefined ? source.title : str(body.title);
    if (!title) fail('titre requis');
    if (body?.content_md !== undefined && typeof body.content_md !== 'string') fail('contenu Markdown invalide');
    const dueDate = orNull(body?.due_date);
    if (dueDate && !DATE_RE.test(dueDate)) fail('échéance invalide (AAAA-MM-JJ attendu)');
    const priority = priorityOf(body?.priority);
    if (!priority) fail('priorité invalide (basse, normale ou haute attendue)');
    const existingRows = await tasks.all();
    const convert = (source.kind ?? 'note') === 'note' && !(await google.get(entryId))
      && body?.content_md === undefined && title === source.title;
    const state = taskStateFor(body?.status, body?.progress, { status: convert ? source.status ?? 'todo' : 'todo', progress: 0 });
    if (convert) {
      const existing = existingRows.find((task) => task.entry_id === entryId);
      if (existing) return taskWithDocuments(existing.id);
    }
    const noteId = convert ? entryId : uid('en_');
    const id = taskIdForNote(noteId);
    const deletedAt = convert ? readLocalTombstones().find((item) => item.kind === 'task' && item.id === id)?.deleted_at : undefined;
    const time: string = taskCreationStamp(nowISO(), deletedAt);
    const task: TaskRow = {
      id, entry_id: noteId, title, ...state,
      due_date: dueDate, pinned: 0, priority: priority as TaskRow['priority'],
      project_id: source.project_id, category_id: source.category_id ?? null, created_at: time, updated_at: time,
      position: nextTaskPosition(existingRows, state.status),
    };
    return convert
      ? addTaskNote(task, { ...source, status: state.status }, undefined, true)
      : addTaskNote(task, taskNote(task, body?.content_md ?? title), source);
  },

  createEntryFromTask: async (taskId, body) => {
    const { database, tasks } = await tables();
    const source = (await tasks.get(taskId)) ?? fail('tâche introuvable');
    await assertLocalTaskPlanning(body?.expected_planning, source);
    const title = body?.title === undefined ? source.title : str(body.title);
    if (!title) fail('titre requis');
    if (source.entry_id) fail('Cette tâche a déjà une note. Modifie sa note pour compléter le contenu.');
    const time = nowISO();
    const next: TaskRow = { ...source, entry_id: uid('en_'), title, ...taskStateFor(source.status, undefined, source), updated_at: time };
    const note = taskNote(next, typeof body?.content_md === 'string' ? body.content_md : '');
    const link = taskLink(next.id, note.id, time);
    await database.writeAll([
      { table: 'entries', value: note, operation: 'add' },
      { table: 'tasks', value: next },
      { table: 'task_entries', value: link, operation: 'add' },
    ]);
    track('entries', note.id, false);
    track('tasks', next.id, false);
    track('links', link.id);
    return fullEntry(note.id);
  },

  createTask: async (body) => {
    const { tasks, projects } = await tables();
    const title = str(body.title);
    if (!title) fail('titre requis');
    if (body.content_md !== undefined && typeof body.content_md !== 'string') fail('contenu Markdown invalide');
    const state = taskStateFor(str(body.status) || undefined, body.progress);
    const priority = priorityOf(body.priority);
    if (!priority) fail('priorité invalide (basse, normale ou haute attendue)');
    const projectId = orNull(body.project_id);
    if (projectId && !(await projects.get(projectId))) fail('projet introuvable');
    const dueDate = orNull(body.due_date);
    if (dueDate && !DATE_RE.test(dueDate)) fail('échéance invalide (AAAA-MM-JJ attendu)');
    const time = nowISO();
    const entryId = uid('en_');
    const task: TaskRow = {
      id: taskIdForNote(entryId), entry_id: entryId, title, ...state, due_date: dueDate, pinned: body.pinned ? 1 : 0,
      position: nextTaskPosition(await tasks.all(), state.status),
      priority: priority as TaskRow['priority'], project_id: projectId, category_id: await categoryFor(body.category_id, projectId),
      created_at: time, updated_at: time,
    };
    return addTaskNote(task, taskNote(task, body.content_md ?? ''));
  },

  updateTask: async (id, body) => {
    const t = await tables();
    const { tasks, projects } = t;
    const current = (await tasks.get(id)) ?? fail('tâche introuvable');
    const patch = (body ?? {}) as Record<string, unknown>;
    await assertLocalTaskPlanning(body?.expected_planning, current);
    const title = pick(patch, 'title', current.title, (v) => str(v));
    if (!title) fail('titre requis');
    const state = taskStateFor(str(patch.status) || undefined, patch.progress, current);
    const priority = pick(patch, 'priority', current.priority, (v) => priorityOf(v, current.priority));
    if (!priority) fail('priorité invalide (basse, normale ou haute attendue)');
    const projectId = pick(patch, 'project_id', current.project_id, orNull);
    if (projectId && !(await projects.get(projectId))) fail('projet introuvable');
    const dueDate = pick(patch, 'due_date', current.due_date, orNull);
    if (patch.due_date !== undefined && dueDate && !DATE_RE.test(dueDate)) fail('échéance invalide (AAAA-MM-JJ attendu)');
    const pinned = pick<0 | 1>(patch, 'pinned', current.pinned, (v) => v ? 1 : 0);
    const planningChanged = state.status !== current.status || state.progress !== current.progress
      || dueDate !== current.due_date || pinned !== current.pinned || priority !== current.priority;
    const next: TaskRow = {
      ...current, title, ...state, due_date: dueDate, pinned,
      position: current.status !== state.status ? nextTaskPosition(await tasks.all(), state.status) : current.position,
      priority: priority as TaskRow['priority'], project_id: projectId, category_id: await categoryForPatch(patch, current, projectId),
      updated_at: planningChanged ? nowISO() : current.updated_at,
    };
    await writeTaskUpdate(current, next);
    if (next.entry_id && (projectId !== current.project_id || next.category_id !== current.category_id)) {
      await inheritLocalTaskCategories(t, nowISO(), { entryId: next.entry_id, excludeTaskId: id });
    }
    if (current.status !== next.status) {
      await renumber(current.status);
      await renumber(next.status);
    }
    return localFollowUpMetadata('task', (await tasks.get(id)) ?? next);
  },

  moveTask: async (id, status, position) => {
    const { tasks } = await tables();
    const current = (await tasks.get(id)) ?? fail('tâche introuvable');
    if (!STATUSES.includes(status)) fail('statut invalide');
    const state = taskStateFor(status, undefined, current);
    const target = Number.isFinite(Number(position)) ? Math.max(0, Number(position)) : 0;
    await writeTaskUpdate(current, { ...current, ...state, position: target - 0.5, updated_at: nowISO() });
    await renumber(status);
    if (current.status !== status) await renumber(current.status);
    return rowAsTask((await tasks.get(id)) as TaskRow);
  },

  deleteTask: async (id) => {
    const { tasks } = await tables();
    const current = (await tasks.get(id)) ?? fail('tâche introuvable');
    await removeTask(current);
    await renumber(current.status);
    return { ok: true };
  },

  linkTaskDocument: async (taskId, entryId) => {
    const t = await tables();
    const { tasks, entries, links } = t;
    const task = (await tasks.get(taskId)) ?? fail('tâche introuvable');
    if (!(await entries.get(entryId))) fail('entrée introuvable');
    const existing = await links.get(linkId(taskId, entryId));
    const association = existing ?? { id: linkId(taskId, entryId), task_id: taskId, entry_id: entryId, created_at: nowISO() };
    if (!existing) await links.put(association);
    track('links', association.id, false);
    try {
      // Un lien déjà persisté doit permettre de reprendre un héritage interrompu.
      await inheritLocalTaskCategories(t, nowISO(), { taskId });
      if (task.status === 'done') await archiveTaskDocuments(taskId);
    } finally { notifyLocalChange(); }
    return { task_id: taskId, entry_id: entryId };
  },

  unlinkTaskDocument: async (taskId, entryId) => {
    const { tasks, entries, links } = await tables();
    const task = (await tasks.get(taskId)) ?? fail('tâche introuvable');
    if (!(await entries.get(entryId))) fail('entrée introuvable');
    if (task.entry_id === entryId) fail('Cette note contient la tâche. Retire le suivi de tâche pour la conserver comme note.');
    if (!(await links.get(linkId(taskId, entryId)))) fail('association introuvable');
    await links.remove(linkId(taskId, entryId));
    untrack('links', linkId(taskId, entryId));
    tombstone('link', `${taskId}|${entryId}`);
    return { ok: true };
  },

  createCategory: async (body): Promise<Category> => {
    const values = await categoryValues(body);
    const { categories } = await tables();
    const time = nowISO();
    const row = { ...values, id: uid('ca_'), created_at: time, updated_at: time };
    await categories.put(row);
    track('categories', row.id);
    return row;
  },
  updateCategory: async (id, body): Promise<Category> => {
    const { categories } = await tables();
    const current = (await categories.get(id)) ?? fail('catégorie introuvable');
    const row = { ...current, ...await categoryValues(body, current), updated_at: nowISO() };
    await categories.put(row);
    track('categories', id);
    return row;
  },
  deleteCategory: async (id) => {
    const { categories, entries, tasks } = await tables();
    const current = (await categories.get(id)) ?? fail('catégorie introuvable');
    const updated_at = nowISO();
    for (const category of await categories.all()) if (category.parent_id === id) {
      await categories.put({ ...category, parent_id: current.parent_id, updated_at });
      track('categories', category.id);
    }
    for (const entry of await entries.all()) if (entry.category_id === id) {
      await entries.put({ ...entry, category_id: current.parent_id, updated_at });
      track('entries', entry.id);
    }
    for (const task of await tasks.all()) if (task.category_id === id) {
      await tasks.put({ ...task, category_id: current.parent_id, updated_at: task.entry_id ? task.updated_at : updated_at });
      track('tasks', task.id);
    }
    await categories.remove(id);
    untrack('categories', id);
    tombstone('category', id);
    return { ok: true };
  },

  createProject: async (body) => {
    const { projects } = await tables();
    const name = str(body.name);
    if (!name) fail('nom requis');
    const time = nowISO();
    const row: ProjectRow = { id: uid('pr_'), name, color: str(body.color) || '#4f7cff', created_at: time, updated_at: time, shared_dir: str((body as { shared_dir?: string }).shared_dir) || null };
    await projects.put(row);
    track('projects', row.id);
    // Comme le serveur (`SELECT *`), sans les compteurs de `/api/state`.
    return row as unknown as Project;
  },

  updateProject: async (id, body) => {
    const { projects } = await tables();
    const current = (await projects.get(id)) ?? fail('projet introuvable');
    const patch = (body ?? {}) as { name?: string; color?: string; shared_dir?: string | null };
    const name = pick(patch as Record<string, unknown>, 'name', current.name, (v) => str(v));
    if (!name) fail('nom requis');
    const next = {
      ...current,
      name,
      color: pick(patch as Record<string, unknown>, 'color', current.color, (v) => str(v) || current.color),
      // Dossier du TSE relié : son adresse, synchronisée par Drive avec le projet (§29).
      shared_dir: pick(patch as Record<string, unknown>, 'shared_dir', current.shared_dir ?? null, (v) => str(v) || null),
      updated_at: nowISO(),
    };
    await projects.put(next);
    track('projects', id);
    return next as unknown as Project;
  },

  deleteProject: async (id) => {
    const { projects, categories, entries, tasks } = await tables();
    if (!(await projects.get(id))) fail('projet introuvable');
    await projects.remove(id);
    // `ON DELETE SET NULL` : les entrées et tâches sont détachées, jamais perdues.
    for (const entry of (await entries.all()).filter((row) => row.project_id === id)) {
      await entries.put({ ...entry, project_id: null, category_id: null, updated_at: nowISO() });
      track('entries', entry.id);
    }
    for (const task of (await tasks.all()).filter((row) => row.project_id === id)) {
      await tasks.put({ ...task, project_id: null, category_id: null, updated_at: task.entry_id ? task.updated_at : nowISO() });
      track('tasks', task.id);
    }
    for (const category of (await categories.all()).filter((row) => row.project_id === id)) {
      await categories.remove(category.id); untrack('categories', category.id); tombstone('category', category.id);
    }
    untrack('projects', id);
    tombstone('project', id);
    return { ok: true };
  },

  // Dossier partagé : un navigateur n'atteint pas un partage SMB. La PWA passe par
  // le relais de l'équipe (VM du bureau, Tailscale) s'il est réglé dans Paramètres ;
  // sinon la section n'apparaît pas et tout autre appel est une erreur explicite.
  sharedStatus: async () => {
    const client = relayClient();
    if (!client) return { available: false };
    try {
      return await client.sharedStatus();
    } catch (error) {
      // Relais injoignable (Tailscale éteint, VM arrêtée) : la section le dit au lieu de disparaître.
      return {
        available: true, configurable: false, root: readRelay()?.url ?? '', label: 'Relais du dossier partagé',
        reach: 'offline' as const, relayError: (error as Error).message,
      };
    }
  },
  sharedList: async (dir) => relay().sharedList(dir),
  sharedFile: async (path) => relay().sharedFile(path),
  sharedContent: async (hash) => relay().sharedContent(hash),
  saveSharedDraft: async (path, body) => relay().saveSharedDraft(path, body),
  discardSharedDraft: async (path, bytes) => relay().discardSharedDraft(path, bytes),
  pushShared: async (path, base, bytes) => relay().pushShared(path, base, bytes),
  mergeShared: async (path, theirs, bytes) => relay().mergeShared(path, theirs, bytes),
  searchShared: async (query, dir) => relay().searchShared(query, dir),
  createShared: async (path, bytes) => relay().createShared(path, bytes),
  resolveShared: async (path, choice, theirs) => relay().resolveShared(path, choice, theirs),
  sharedVersions: async (path) => relay().sharedVersions(path),
  restoreSharedVersion: async (path, id) => relay().restoreSharedVersion(path, id),
  lockShared: async (path, takeOver) => relay().lockShared(path, takeOver),
  unlockShared: async (path) => relay().unlockShared(path),
  deleteShared: async (path) => relay().deleteShared(path),
  createSharedDir: async (path) => relay().createSharedDir(path),
  renameSharedDir: async (path, name) => relay().renameSharedDir(path, name),
  sharedDirSummary: async (path) => relay().sharedDirSummary(path),
  deleteSharedDir: async (path, token) => relay().deleteSharedDir(path, token),
  linkSharedFolder: async (projectId, dir) => relay().linkSharedFolder(projectId, dir),
  unlinkSharedFolder: async (projectId) => relay().unlinkSharedFolder(projectId),
  setSharedDisplayName: async (displayName) => relay().setSharedDisplayName(displayName),
  // Pas d'aperçu PDF par le relais (en-tête d'autorisation) : le PDF garde son téléchargement.
  sharedPreviewUrl: () => null,
  deleteAttachment: async (id) => {
    const { attachments } = await tables();
    const row = (await attachments.get(id)) ?? fail('pièce jointe introuvable');
    await attachments.remove(id);
    untrack('attachments', id);
    tombstone('attachment', id);
    // Même règle que le desktop : l'exemplaire Drive part à la corbeille, sauf s'il
    // est encore partagé par une copie ; un échec ne remet pas la pièce jointe.
    let driveTrashed = false;
    const driveId = row.driveFileId || '';
    const google = webGoogleStatus();
    if (driveId && /^[\w-]{1,200}$/.test(driveId) && google.connected && !google.expired
      && !(await attachments.all()).some((other) => other.driveFileId === driveId)) {
      try {
        await webGoogleRequest(`/drive/v3/files/${driveId}?supportsAllDrives=true&fields=id,trashed`, {
          method: 'PATCH', body: JSON.stringify({ trashed: true }),
        });
        driveTrashed = true;
      } catch {
        // Best-effort.
      }
    }
    return { ok: true, driveTrashed };
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

// These operations use internal helpers, so none recursively waits for this
// queue. Google actions that call updateEntry/deleteEntry join it per mutation.
for (const method of [
  'createCategory', 'updateCategory', 'deleteCategory', 'createProject', 'updateProject', 'deleteProject',
  'createEntry', 'updateEntry', 'deleteEntry', 'copyEntry', 'mergeEntries', 'mergeTasks', 'createTaskFromEntry', 'createEntryFromTask',
  'createTask', 'updateTask', 'moveTask', 'deleteTask', 'linkTaskDocument', 'unlinkTaskDocument', 'exportBackup',
  'saveFollowUp',
] as const) {
  const operation = localApi[method];
  Object.assign(localApi, { [method]: (...args: unknown[]) => localWrite(() => Reflect.apply(operation, localApi, args) as Promise<unknown>) });
}

async function backupObject() {
  const { projects, categories, entries, tasks, links, attachments, google } = await tables();
  return {
    version: BACKUP_VERSION,
    exported_at: nowISO(),
    projects: await projects.all(),
    categories: await categories.all(),
    entries: (await entries.all()).map((row) => decodeEntry(row)),
    tasks: (await tasks.all()).map((row) => decodeFollowUpRow(row)),
    task_entries: (await links.all()).map(({ task_id, entry_id, created_at }) => ({ task_id, entry_id, created_at })),
    google_documents: await google.all(),
    attachments: (await attachments.all()).map(stripBlob),
  };
}

/** Instantané local pour la fusion : même forme validée que le fichier Drive, suppressions comprises. */
export async function localSyncSnapshot(): Promise<SyncSnapshot> {
  return localWrite(async () => ({ ...(validateBackup(await backupObject()) as Omit<SyncSnapshot, 'deleted'>), deleted: readLocalTombstones() }));
}

export interface SyncSnapshot {
  projects: (ProjectRow & { updated_at: string })[];
  categories?: CategoryRow[];
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
export function applySyncSnapshot(merged: SyncSnapshot, base: SyncSnapshot): Promise<{ changed: number; skipped: number }> {
  return localWrite(() => applySyncSnapshotUnlocked(merged, base));
}
async function applySyncSnapshotUnlocked(merged: SyncSnapshot, base: SyncSnapshot): Promise<{ changed: number; skipped: number }> {
  const t = await tables();
  // A category move or assignment made while Drive was read changes the graph.
  // Retry the merge from that graph before applying any row: retaining just the
  // edited row could otherwise make a cycle or an orphan with incoming changes.
  const graph = (rows: { id: string; project_id?: string | null; category_id?: string | null; parent_id?: string | null }[], category = false) =>
    JSON.stringify(rows.map((row) => [row.id, row.project_id ?? null, category ? row.parent_id ?? null : row.category_id ?? null]).sort((a, b) => cmp(a[0] || '', b[0] || '')));
  const projectIds = (rows: { id: string }[]) => JSON.stringify(rows.map((row) => row.id).sort());
  const currentEntries = await t.entries.all();
  const currentTasks = await t.tasks.all();
  const primaryIds = new Set([...currentTasks, ...base.tasks, ...merged.tasks].map((task) => task.entry_id));
  const pairedTasks = (rows: TaskRow[]) => rows.filter(({ entry_id }) => primaryIds.has(entry_id))
    .sort((a, b) => cmp(a.id, b.id))
    .map((row) => [row.id, row.entry_id, row.updated_at, row.title, row.status, row.progress, row.due_date, row.priority, row.pinned, row.position, row.follow_up ?? null]);
  const pairedNotes = (rows: EntryRow[]) => rows.filter(({ id }) => primaryIds.has(id))
    .sort((a, b) => cmp(a.id, b.id))
    .map((row) => [row.id, row.updated_at, row.title, row.status ?? 'todo', row.content_md, row.content_json, row.entry_date, row.archived, row.kind, row.follow_up ?? null]);
  const pairedNotesInBase = base.entries.map((row) => ({ ...row, content_json: row.content_json ? JSON.stringify(row.content_json) : null }));
  if (JSON.stringify(pairedTasks(currentTasks)) !== JSON.stringify(pairedTasks(base.tasks))
    || JSON.stringify(pairedNotes(currentEntries)) !== JSON.stringify(pairedNotes(pairedNotesInBase))
    || projectIds(await t.projects.all()) !== projectIds(base.projects)
    || graph(await t.categories.all(), true) !== graph(base.categories || [], true)
    || graph(currentEntries) !== graph(base.entries)
    || graph(currentTasks) !== graph(base.tasks)) return { changed: 0, skipped: 1 };
  let changed = 0;
  let skipped = 0;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const stampOf = (row: { updated_at?: string; created_at?: string } | undefined) => row?.updated_at || row?.created_at || '';
  async function sync<Wanted extends object, Row extends object>(
    table: { all(): Promise<Row[]>; put(value: Row): Promise<void>; remove(key: string): Promise<void> },
    wanted: Wanted[], before: Wanted[], key: (row: Wanted | Row) => string, toRow: (row: Wanted, current?: Row) => Row,
    fields: string[], batch?: { table: string; writes: StoreWrite[] },
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
      return fields.some((field) => {
        const fallback = field === 'status' ? 'todo' : null;
        return JSON.stringify(now?.[field] ?? fallback) !== JSON.stringify(was?.[field] ?? fallback);
      });
    };
    for (const [id, row] of wantedMap) {
      if (same(row, baseMap.get(id))) continue;
      if (baseMap.has(id) ? moved(id) : current.has(id) && guarded) { skipped++; continue; }
      const value = toRow(row, current.get(id));
      if (batch) batch.writes.push({ table: batch.table, value });
      else await table.put(value);
      changed++;
    }
    for (const id of baseMap.keys()) {
      if (wantedMap.has(id) || !current.has(id)) continue;
      if (moved(id)) { skipped++; continue; }
      if (batch) batch.writes.push({ table: batch.table, key: id, operation: 'delete' });
      else await table.remove(id);
      changed++;
    }
  }
  await sync(t.projects, merged.projects, base.projects, (row) => (row as ProjectRow).id, (row) => ({ ...row }), ['name', 'color']);
  await sync(t.categories, merged.categories || [], base.categories || [], (row) => (row as CategoryRow).id, (row) => ({ ...row }), ['name', 'color', 'project_id', 'parent_id']);
  const noteWrites: StoreWrite[] = [];
  await sync(t.entries, merged.entries, base.entries, (row) => (row as EntryRow).id,
    (row) => ({ ...row, content_json: row.content_json ? JSON.stringify(row.content_json) : null }) as EntryRow,
    ['title', 'content_md', 'content_json', 'entry_date', 'project_id', 'category_id', 'archived', 'kind', 'status', 'follow_up'], { table: 'entries', writes: noteWrites });
  await sync(t.tasks, merged.tasks, base.tasks, (row) => (row as TaskRow).id, (row) => ({ ...row }),
    ['title', 'status', 'due_date', 'pinned', 'position', 'priority', 'project_id', 'category_id', 'follow_up', 'entry_id', 'progress'], { table: 'tasks', writes: noteWrites });
  await sync(t.links, merged.task_entries, base.task_entries, (row) => linkId(row.task_id, row.entry_id),
    (row) => ({ id: linkId(row.task_id, row.entry_id), ...row }), [], { table: 'task_entries', writes: noteWrites });
  await t.database.writeAll(noteWrites);
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

/** Remplace le contenu local par une sauvegarde validée, en une transaction. */
export function importLocalBackup(input: unknown): Promise<{ ok: true; projects: number; entries: number; tasks: number }> {
  return localWrite(() => importLocalBackupUnlocked(input));
}
async function importLocalBackupUnlocked(input: unknown): Promise<{ ok: true; projects: number; entries: number; tasks: number }> {
  const data = validateBackup(input) as {
    projects: ProjectRow[]; categories: CategoryRow[]; entries: SyncSnapshot['entries'];
    tasks: TaskRow[]; task_entries: { task_id: string; entry_id: string; created_at: string }[];
    google_documents: GoogleRow[]; attachments: { id: string; filename: string; stored: string; mime: string; size: number; entry_id: string; created_at: string; driveFileId?: string | null }[];
  };
  const { database } = await tables();
  const replacement = {
    projects: data.projects, categories: data.categories, tasks: data.tasks,
    google_documents: data.google_documents, attachments: data.attachments,
    entries: data.entries.map((entry) => ({ ...entry, content_json: entry.content_json ? JSON.stringify(entry.content_json) : null })),
    task_entries: data.task_entries.map((link) => ({ ...link, id: linkId(link.task_id, link.entry_id) })),
  };
  const writes: StoreWrite[] = Object.entries(replacement).flatMap(([table, rows]) => [
    { table, operation: 'clear' as const },
    ...rows.map((value) => ({ table, value })),
  ]);
  await database.writeAll(writes);
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
  categories?: CategoryRow[];
  entries: SyncSnapshot['entries'];
  tasks: TaskRow[];
  task_entries: { task_id: string; entry_id: string; created_at: string }[];
  attachments: { id: string; filename: string; stored: string; mime: string; size: number; entry_id: string; created_at: string; driveFileId: string | null }[];
}

/**
 * Construit la « boîte mobile » : créations et modifications locales depuis le
 * dernier import, avec les métadonnées des pièces jointes (binaires envoyés
 * séparément). Vide si rien n'a changé.
 */
export function exportLocalOutbox(baseExportedAt: string | null = null): Promise<OutboxPayload> {
  return localWrite(() => exportLocalOutboxUnlocked(baseExportedAt));
}
async function exportLocalOutboxUnlocked(baseExportedAt: string | null): Promise<OutboxPayload> {
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
  const entries = new Set(outbox.entries);
  const taskIds = new Set(outbox.tasks);
  const linkIds = new Set(outbox.links);
  const files = await take(t.attachments, outbox.attachments);
  for (const file of files) entries.add(file.entry_id);
  for (const link of await take(t.links, outbox.links)) {
    taskIds.add(link.task_id);
    entries.add(link.entry_id);
  }
  for (const task of await t.tasks.all()) {
    if (!task.entry_id || (!taskIds.has(task.id) && !entries.has(task.entry_id))) continue;
    taskIds.add(task.id);
    entries.add(task.entry_id);
    linkIds.add(linkId(task.id, task.entry_id));
  }
  const entryRows = await take(t.entries, [...entries]);
  const tasks = await take(t.tasks, [...taskIds]);
  const links = await take(t.links, [...linkIds]);
  // A changed item needs its category and ancestors even if those did not change.
  const categoryIds = new Set([...(outbox.categories || []), ...entryRows.map((row) => row.category_id || ''), ...tasks.map((row) => row.category_id || '')].filter(Boolean));
  const categories: CategoryRow[] = [];
  for (const id of categoryIds) {
    const row = await t.categories.get(id);
    if (!row) continue;
    categories.push(row);
    if (row.parent_id) categoryIds.add(row.parent_id);
  }
  const projectIds = new Set([...outbox.projects, ...entryRows.map((row) => row.project_id || ''), ...tasks.map((row) => row.project_id || ''), ...categories.map((row) => row.project_id)].filter(Boolean));
  return {
    version: OUTBOX_VERSION,
    exported_at: nowISO(),
    base_exported_at: baseExportedAt,
    device: 'pwa',
    projects: await take(t.projects, [...projectIds]),
    categories,
    entries: entryRows.map((row) => ({ ...row, status: row.status ?? 'todo', content_json: row.content_json ? (JSON.parse(row.content_json) as RichDocument) : null })),
    tasks,
    task_entries: links.map(({ task_id, entry_id, created_at }) => ({ task_id, entry_id, created_at })),
    attachments: files.map(({ blob: _blob, driveFileId, ...meta }) => ({ ...meta, driveFileId: driveFileId ?? null })),
  };
}

export function outboxSize(outbox: LocalOutbox = readLocalOutbox()): number {
  return outbox.entries.length + outbox.tasks.length + outbox.links.length + outbox.attachments.length + outbox.projects.length + (outbox.categories?.length || 0);
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
  return { ...await localFollowUpMetadata('task', row), documents: taskDocuments(id, await entries.all(), await links.all(), googleByEntry) };
}

/** Les mutations de tâche et la synchronisation appellent cette comparaison sous localWrite. */
async function assertLocalTaskPlanning(expected: TaskPlanningSnapshot | undefined, task: TaskRow): Promise<void> {
  if (expected === undefined) return;
  try {
    const snapshot = taskPlanningUsesDocuments(expected)
      ? await taskWithDocuments(task.id) : await localFollowUpMetadata('task', task);
    assertExpectedTaskPlanning(expected, snapshot);
  } catch (cause) {
    const error = cause as Error & { code?: string };
    throw new ApiError(error.message, error.code);
  }
}
