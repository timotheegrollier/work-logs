import { api, fmtDate, isOverdue, prioColor, typeIcon, type Project, type Stats, type Task, type WLEvent } from '../lib';
import { useRefresh } from '../components/ui';
import { useState } from 'react';
import { TaskModal } from '../components/TaskModal';

export default function Dashboard({ projects, reloadAll }: { projects: Project[]; reloadAll: () => void }) {
  const stats = useRefresh(api.stats);
  const tasks = useRefresh(() => api.tasks({}), []);
  const events = useRefresh(() => api.events(new Date().toISOString(), new Date(Date.now() + 7 * 864e5).toISOString()), []);
  const [quick, setQuick] = useState('');
  const [show, setShow] = useState(false);

  const s: Stats | null = stats.data;
  const all: Task[] = tasks.data || [];
  const urgent = all.filter((t) => t.status !== 'done' && (t.priority === 'high' || t.priority === 'urgent')).slice(0, 6);
  const late = all.filter(isOverdue).slice(0, 6);
  const evs: WLEvent[] = events.data || [];

  const addQuick = async () => {
    if (!quick.trim()) return;
    await api.createTask({ title: quick.trim(), status: 'todo' });
    setQuick('');
    tasks.reload(); stats.reload(); reloadAll();
  };
  return (
    <div>
      <div className="top"><h1>Tableau de bord</h1><div className="sp" />
        <button className="btn" onClick={() => setShow(true)}>+ Nouvelle tâche</button>
      </div>
      {stats.error && <div className="err">{stats.error}</div>}
      <div className="cards">
        <div className="card"><b>{s?.total ?? '…'}</b><small>Tâches totales</small></div>
        <div className="card"><b>{s?.done ?? '…'}</b><small>Terminées</small></div>
        <div className="card"><b style={{ color: '#ef4444' }}>{s?.overdue ?? '…'}</b><small>En retard</small></div>
        <div className="card"><b style={{ color: '#f59e0b' }}>{s?.urgent ?? '…'}</b><small>Urgentes / hautes</small></div>
        <div className="card"><b>{s?.upcomingEvents ?? '…'}</b><small>Événements (7j)</small></div>
      </div>
      <div className="panel">
        <b>Ajout rapide</b>
        <div className="row" style={{ marginTop: 8 }}>
          <input style={{ flex: 1 }} placeholder="Écris une tâche et Entrée…" value={quick}
            onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addQuick()} />
          <button className="btn" onClick={addQuick}>Ajouter</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 12 }}>
        <div className="panel"><b>⚠ En retard</b>
          {late.length === 0 && <div style={{ color: '#93a0bb' }}>Rien en retard. Bravo.</div>}
          {late.map((t) => <div key={t.id}>• {typeIcon(t.type)} {t.title} <small>({fmtDate(t.due_date)})</small></div>)}
        </div>
        <div className="panel"><b>🔥 Prioritaires</b>
          {urgent.map((t) => <div key={t.id}>• <span className="dot" style={{ background: prioColor(t.priority) }} />{t.title}</div>)}
          {urgent.length === 0 && <div style={{ color: '#93a0bb' }}>Aucune tâche prioritaire ouverte.</div>}
        </div>
        <div className="panel"><b>📅 Agenda — 7 jours</b>
          {evs.map((e) => <div key={e.id}>• {fmtDate(e.starts_at)} — {e.title}</div>)}
          {evs.length === 0 && <div style={{ color: '#93a0bb' }}>Aucun événement à venir.</div>}
        </div>
      </div>
      {show && <TaskModal projects={projects} onClose={() => setShow(false)} onSaved={() => { setShow(false); tasks.reload(); stats.reload(); reloadAll(); }} />}
    </div>
  );
}
