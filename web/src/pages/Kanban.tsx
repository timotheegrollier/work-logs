import { useMemo, useState } from 'react';
import { api, COLUMNS, PRIOS, TYPES, fmtDate, isOverdue, prioColor, typeIcon, type Project, type Status, type Task } from '../lib';
import { Modal, useRefresh } from '../components/ui';
import { TaskModal } from '../components/TaskModal';

export default function Kanban({ projects, reloadAll }: { projects: Project[]; reloadAll: () => void }) {
  const [fp, setFp] = useState('');
  const [fpr, setFpr] = useState('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Task | null>(null);
  const [detail, setDetail] = useState<Task | null>(null);
  const [createIn, setCreateIn] = useState<Status | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const list = useRefresh(() => api.tasks({ project_id: fp, priority: fpr, search: q }), [fp, fpr, q]);

  const tasks: Task[] = list.data || [];
  const byCol = useMemo(() => {
    const m = Object.fromEntries(COLUMNS.map((c) => [c.id, [] as Task[]]));
    for (const t of tasks) (m[t.status] ||= []).push(t);
    for (const k of Object.keys(m)) m[k].sort((a, b) => a.position - b.position);
    return m as Record<Status, Task[]>;
  }, [tasks]);

  const drop = async (e: React.DragEvent, status: Status) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/task-id');
    if (!id) return;
    const col = byCol[status];
    await api.moveTask(id, status, col.length);
    list.reload(); reloadAll();
  };
  const remove = async (id: string) => {
    if (!confirm('Supprimer cette tâche ?')) return;
    await api.deleteTask(id);
    setDetail(null); list.reload(); reloadAll();
  };

  return (
    <div>
      <div className="top"><h1>Kanban</h1><div className="sp" />
        <select value={fp} onChange={(e) => setFp(e.target.value)}>
          <option value="">Tous projets</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={fpr} onChange={(e) => setFpr(e.target.value)}>
          <option value="">Toutes priorités</option>
          {PRIOS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <input placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => setCreateIn('todo')}>+ Tâche</button>
      </div>
      {list.error && <div className="err">{list.error}</div>}
      <div className="kanban">
        {COLUMNS.map((c) => (
          <div key={c.id} className={'col' + (over === c.id ? ' over' : '')}
            onDragOver={(e) => { e.preventDefault(); setOver(c.id); }}
            onDragLeave={() => setOver(null)} onDrop={(e) => drop(e, c.id)}>
            <h3>{c.label} ({byCol[c.id].length})</h3>
            {byCol[c.id].map((t) => (
              <div key={t.id} className={'tcard' + (isOverdue(t) ? ' late' : t.priority === 'urgent' || t.priority === 'high' ? ' urg' : '')}
                draggable onDragStart={(e) => e.dataTransfer.setData('text/task-id', t.id)}
                onClick={() => setDetail(t)}>
                <div className="meta">
                  <span>{typeIcon(t.type)}</span>
                  {t.project_name && <span className="badge"><span className="dot" style={{ background: t.project_color }} />{t.project_name}</span>}
                  <span className="badge" style={{ borderColor: prioColor(t.priority), color: prioColor(t.priority) }}>{t.priority}</span>
                </div>
                <div className="tt">{t.status === 'done' ? <s>{t.title}</s> : t.title}</div>
                <div className="meta"><span>📅 {fmtDate(t.due_date)}</span>{t.estimate_h ? <span>⏱ {t.estimate_h}h</span> : null}</div>
              </div>
            ))}
            <button className="ghost" style={{ width: '100%' }} onClick={() => setCreateIn(c.id)}>+ Ajouter</button>
          </div>
        ))}
      </div>
      {createIn && <TaskModal projects={projects} initial={{ status: createIn, project_id: fp }} onClose={() => setCreateIn(null)} onSaved={() => { setCreateIn(null); list.reload(); reloadAll(); }} />}
      {edit && <TaskModal projects={projects} initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setDetail(null); list.reload(); reloadAll(); }} />}
      {detail && (
        <Modal onClose={() => setDetail(null)}>
          <h2 style={{ marginTop: 0 }}>{typeIcon(detail.type)} {detail.title}</h2>
          <div className="row">
            <span className="badge">{detail.status}</span>
            <span className="badge">{TYPES.find((x) => x.id === detail.type)?.label}</span>
            <span className="badge" style={{ color: prioColor(detail.priority) }}>{detail.priority}</span>
            {detail.project_name && <span className="badge">{detail.project_name}</span>}
            <span className="badge">📅 {fmtDate(detail.due_date)}</span>
          </div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{detail.description || <i style={{ color: '#93a0bb' }}>Pas de description.</i>}</p>
          <div className="row">
            <button className="btn" onClick={() => { setEdit(detail); }}>Modifier</button>
            {detail.status !== 'done' && <button className="ghost" onClick={async () => { await api.updateTask(detail.id, { status: 'done' }); setDetail(null); list.reload(); reloadAll(); }}>Marquer terminée</button>}
            <button className="danger" onClick={() => remove(detail.id)}>Supprimer</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
