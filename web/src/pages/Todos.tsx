import { useState } from 'react';
import { api, fmtDate, isOverdue, type Project } from '../lib';
import { useRefresh } from '../components/ui';

export default function Todos({ reloadAll }: { projects: Project[]; reloadAll: () => void }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const list = useRefresh(() => api.tasks({}), []);

  const add = async () => {
    if (!title.trim()) return;
    await api.createTask({ title: title.trim(), due_date: due || undefined, status: 'todo' });
    setTitle(''); setDue('');
    list.reload(); reloadAll();
  };
  const toggle = async (id: string, done: boolean) => {
    await api.updateTask(id, { status: done ? 'todo' : 'done' });
    list.reload(); reloadAll();
  };
  const open = (list.data || []).filter((t) => t.status !== 'done');
  const done = (list.data || []).filter((t) => t.status === 'done').slice(0, 30);
  return (
    <div>
      <div className="top"><h1>Todos — inbox</h1></div>
      <div className="panel">
        <div className="row">
          <input style={{ flex: 1 }} placeholder="Nouvelle tâche rapide…" value={title}
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          <button className="btn" onClick={add}>Ajouter</button>
        </div>
      </div>
      {list.error && <div className="err">{list.error}</div>}
      <div className="panel">
        <b>À faire ({open.length})</b>
        <table><tbody>
          {open.map((t) => (
            <tr key={t.id}>
              <td style={{ width: 30 }}><input type="checkbox" checked={false} onChange={() => toggle(t.id, false)} /></td>
              <td><b>{t.title}</b> <small style={{ color: '#93a0bb' }}>{t.project_name || ''}</small></td>
              <td style={{ color: isOverdue(t) ? '#ff8fa3' : '#93a0bb' }}>{fmtDate(t.due_date)}</td>
              <td><span className="badge">{t.priority}</span></td>
              <td style={{ textAlign: 'right' }}>
                <button className="danger" onClick={async () => { if (confirm('Supprimer ?')) { await api.deleteTask(t.id); list.reload(); reloadAll(); } }}>✕</button>
              </td>
            </tr>
          ))}
          {open.length === 0 && <tr><td><i style={{ color: '#93a0bb' }}>Inbox vide 🎉</i></td></tr>}
        </tbody></table>
      </div>
      <div className="panel">
        <b>Terminées (30 dernières)</b>
        {done.map((t) => (
          <div key={t.id} className="row" style={{ padding: '4px 0' }}>
            <input type="checkbox" checked onChange={() => toggle(t.id, true)} />
            <s style={{ color: '#93a0bb' }}>{t.title}</s>
          </div>
        ))}
        {done.length === 0 && <div style={{ color: '#93a0bb' }}>Rien de terminé pour l'instant.</div>}
      </div>
    </div>
  );
}
