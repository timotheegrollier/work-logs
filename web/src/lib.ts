export type Status = 'todo' | 'in_progress' | 'review' | 'done';
export interface Project { id: string; name: string; pkey: string; color: string; description: string; created_at: string; open_tasks?: number }
export interface Task {
  id: string; project_id: string | null; parent_id: string | null;
  title: string; description: string; status: Status;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  type: 'task' | 'bug' | 'story' | 'epic' | 'subtask';
  due_date: string | null; estimate_h: number | null; position: number;
  created_at: string; updated_at: string;
  project_name?: string; project_color?: string;
  attachments?: Attachment[];
}
export interface WLEvent { id: string; title: string; description: string; starts_at: string; ends_at: string; task_id: string | null; project_id: string | null; created_at: string; project_name?: string }
export interface Doc { id: string; title: string; content_md: string; project_id: string | null; task_id: string | null; created_at: string; updated_at: string }
export interface Attachment { id: string; filename: string; stored: string; mime: string; size: number; project_id: string | null; task_id: string | null; doc_id: string | null; created_at: string }
export interface Stats { total: number; done: number; overdue: number; urgent: number; upcomingEvents: number; byStatus: Record<Status, number> }

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
const qs = (f: Record<string, string> = {}) => {
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString();
  return q ? '?' + q : '';
};
export const api = {
  health: () => req<{ ok: boolean }>('/api/health'),
  stats: () => req<Stats>('/api/stats'),
  search: (q: string) => req<{ tasks: Task[]; docs: Doc[]; events: WLEvent[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  projects: () => req<Project[]>('/api/projects'),
  createProject: (b: Partial<Project>) => req<Project>('/api/projects', { method: 'POST', body: JSON.stringify(b) }),
  updateProject: (id: string, b: Partial<Project>) => req<Project>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteProject: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  tasks: (f: Record<string, string> = {}) => req<Task[]>(`/api/tasks${qs(f)}`),
  task: (id: string) => req<Task>(`/api/tasks/${id}`),
  createTask: (b: Partial<Task>) => req<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(b) }),
  updateTask: (id: string, b: Partial<Task>) => req<Task>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  moveTask: (id: string, status: Status, position: number) => req<Task>(`/api/tasks/${id}/move`, { method: 'PATCH', body: JSON.stringify({ status, position }) }),
  deleteTask: (id: string) => req<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  events: (from = '', to = '') => req<WLEvent[]>(`/api/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  allEvents: () => req<WLEvent[]>('/api/events'),
  createEvent: (b: Partial<WLEvent>) => req<WLEvent>('/api/events', { method: 'POST', body: JSON.stringify(b) }),
  updateEvent: (id: string, b: Partial<WLEvent>) => req<WLEvent>(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteEvent: (id: string) => req<{ ok: boolean }>(`/api/events/${id}`, { method: 'DELETE' }),
  docs: (f: Record<string, string> = {}) => req<Doc[]>(`/api/docs${qs(f)}`),
  createDoc: (b: Partial<Doc>) => req<Doc>('/api/docs', { method: 'POST', body: JSON.stringify(b) }),
  updateDoc: (id: string, b: Partial<Doc>) => req<Doc>(`/api/docs/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteDoc: (id: string) => req<{ ok: boolean }>(`/api/docs/${id}`, { method: 'DELETE' }),
  attachments: (f: Record<string, string> = {}) => req<Attachment[]>(`/api/attachments${qs(f)}`),
  deleteAttachment: (id: string) => req<{ ok: boolean }>(`/api/attachments/${id}`, { method: 'DELETE' }),
  fileUrl: (stored: string) => `/api/files/${stored}`,
  upload: async (file: File, link: Record<string, string>) => {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(link)) if (v) fd.append(k, v);
    const r = await fetch('/api/uploads', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('upload échoué');
    return r.json() as Promise<Attachment>;
  },
};

export const COLUMNS: { id: Status; label: string }[] = [
  { id: 'todo', label: 'À faire' },
  { id: 'in_progress', label: 'En cours' },
  { id: 'review', label: 'Revue' },
  { id: 'done', label: 'Terminé' },
];
export const PRIOS = [
  { id: 'low', label: 'Basse', color: '#22c55e' },
  { id: 'medium', label: 'Moyenne', color: '#3b82f6' },
  { id: 'high', label: 'Haute', color: '#f59e0b' },
  { id: 'urgent', label: 'Urgente', color: '#ef4444' },
];
export const TYPES = [
  { id: 'task', label: 'Tâche', icon: '✓' },
  { id: 'bug', label: 'Bug', icon: '🐞' },
  { id: 'story', label: 'Story', icon: '★' },
  { id: 'epic', label: 'Epic', icon: '⚡' },
  { id: 'subtask', label: 'Sous-tâche', icon: '↳' },
];
export const prioColor = (p: string) => PRIOS.find((x) => x.id === p)?.color || '#999';
export const typeIcon = (t: string) => TYPES.find((x) => x.id === t)?.icon || '✓';
export const fmtDate = (d?: string | null) => {
  if (!d) return '—';
  const dt = new Date(d.length <= 10 ? d + 'T12:00:00' : d);
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) + (d.length > 10 ? ' ' + dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
};
export const isOverdue = (t: Task) => t.status !== 'done' && !!t.due_date && t.due_date.slice(0, 10) < new Date().toISOString().slice(0, 10);

