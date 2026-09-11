import { useState } from 'react';
import { api, COLUMNS, PRIOS, TYPES, type Project, type Status, type Task } from '../lib';
import { Modal } from './ui';

interface TaskForm { title: string; description: string; project_id: string; priority: Task['priority']; type: Task['type']; status: Status; due_date: string; estimate_h: string }
export const emptyTask: TaskForm = { title: '', description: '', project_id: '', priority: 'medium', type: 'task', status: 'todo', due_date: '', estimate_h: '' };

export function TaskModal({ projects, initial, onClose, onSaved }: {
  projects: Project[]; initial?: Partial<Task> & { title?: string }; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState<TaskForm>({
    ...emptyTask,
    ...(initial as Partial<TaskForm>),
    project_id: (initial?.project_id as string) || '',
    due_date: (initial?.due_date as string) || '',
    estimate_h: initial?.estimate_h != null ? String(initial.estimate_h) : '',
  });
  const [err, setErr] = useState('');
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    try {
      if (!f.title.trim()) { setErr('Titre requis'); return; }
      const body = { title: f.title, description: f.description, project_id: f.project_id || null, status: f.status, priority: f.priority, type: f.type, due_date: f.due_date || null, estimate_h: f.estimate_h === '' ? null : Number(f.estimate_h) };
      if ((initial as Task)?.id) await api.updateTask((initial as Task).id, body);
      else await api.createTask(body);
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal onClose={onClose}>
      <h2 style={{ marginTop: 0 }}>{(initial as Task)?.id ? 'Modifier la tâche' : 'Nouvelle tâche'}</h2>
      {err && <div className="err">{err}</div>}
      <label>Titre *</label>
      <input autoFocus value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Ex. Relire le devis client" />
      <label>Description</label>
      <textarea value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Détails, critères…" />
      <div className="grid2">
        <div><label>Projet</label>
          <select value={f.project_id} onChange={(e) => set('project_id', e.target.value)}>
            <option value="">— aucun —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <div><label>Statut</label>
          <select value={f.status} onChange={(e) => set('status', e.target.value)}>
            {COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select></div>
        <div><label>Type</label>
          <select value={f.type} onChange={(e) => set('type', e.target.value)}>
            {TYPES.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
          </select></div>
        <div><label>Priorité</label>
          <select value={f.priority} onChange={(e) => set('priority', e.target.value)}>
            {PRIOS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select></div>
        <div><label>Échéance</label>
          <input type="date" value={String(f.due_date).slice(0, 10)} onChange={(e) => set('due_date', e.target.value)} /></div>
        <div><label>Estimation (h)</label>
          <input type="number" min="0" step="0.5" value={f.estimate_h} onChange={(e) => set('estimate_h', e.target.value)} /></div>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={save}>Enregistrer</button>
        <button className="ghost" onClick={onClose}>Annuler</button>
      </div>
    </Modal>
  );
}
