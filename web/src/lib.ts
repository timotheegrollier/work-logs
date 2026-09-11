export type Status = 'todo' | 'doing' | 'done';

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
  updated_at: string;
  excerpt: string;
  attachments: number;
}
export interface Entry {
  id: string;
  title: string;
  content_md: string;
  entry_date: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  attachments: Attachment[];
}
export interface Task {
  id: string;
  title: string;
  status: Status;
  due_date: string | null;
  pinned: 0 | 1;
  position: number;
  project_id: string | null;
  created_at: string;
  updated_at: string;
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

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(payload?.error || `Erreur ${res.status}`);
  }
  return res.json() as Promise<T>;
}
const send = <T>(method: string, url: string, body?: unknown) =>
  req<T>(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
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

  createTask: (body: Partial<Task>) => send<Task>('POST', '/api/tasks', body),
  updateTask: (id: string, body: Partial<Task>) => send<Task>('PUT', `/api/tasks/${id}`, body),
  moveTask: (id: string, status: Status, position: number) =>
    send<Task>('PATCH', `/api/tasks/${id}/move`, { status, position }),
  deleteTask: (id: string) => send<{ ok: true }>('DELETE', `/api/tasks/${id}`),

  createProject: (body: { name: string; color?: string }) =>
    send<Project>('POST', '/api/projects', body),
  updateProject: (id: string, body: { name?: string; color?: string }) =>
    send<Project>('PUT', `/api/projects/${id}`, body),
  deleteProject: (id: string) => send<{ ok: true }>('DELETE', `/api/projects/${id}`),

  deleteAttachment: (id: string) => send<{ ok: true }>('DELETE', `/api/attachments/${id}`),
  fileUrl: (stored: string) => `/api/files/${stored}`,
  async upload(file: File, entryId: string) {
    const form = new FormData();
    form.append('file', file);
    form.append('entry_id', entryId);
    const res = await fetch('/api/uploads', { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'envoi impossible');
    return res.json() as Promise<Attachment>;
  },
};

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
