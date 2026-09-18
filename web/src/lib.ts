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
}
export interface GoogleFile { id: string; name: string; modifiedTime: string }
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
  stats: Stats;
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

export const remoteApi = {
  googleStatus: () => req<GoogleStatus>('/api/google/status'),
  configureGoogle: (configuration: unknown) => send<GoogleStatus>('POST', '/api/google/configure', configuration),
  connectGoogle: () => send<GoogleStatus>('POST', '/api/google/connect'),
  disconnectGoogle: () => send<GoogleStatus>('POST', '/api/google/disconnect'),
  googleDocuments: (pageToken = '') => req<{ files: GoogleFile[]; nextPageToken?: string; warnings?: string[] }>('/api/google/documents' + (pageToken ? '?page_token=' + encodeURIComponent(pageToken) : '')),
  googleBackups: () => req<{ files: GoogleBackup[] }>('/api/google/backup/list'),
  exportGoogleBackup: () => send<GoogleBackup>('POST', '/api/google/backup/export'),
  importGoogleBackup: (id: string) => send<{ ok: true; projects: number; entries: number; tasks: number }>('POST', `/api/google/backup/${encodeURIComponent(id)}/import`),
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

  deleteAttachment: (id: string) => send<{ ok: true }>('DELETE', `/api/attachments/${id}`),
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
