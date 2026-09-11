import { useState } from 'react';
import { api, fmtDate, type Project, type WLEvent } from '../lib';
import { Modal, useRefresh } from '../components/ui';

const toLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export default function Agenda({ projects }: { projects: Project[] }) {
  const [from] = useState(() => new Date(Date.now() - 864e5).toISOString());
  const [to] = useState(() => new Date(Date.now() + 30 * 864e5).toISOString());
  const [show, setShow] = useState(false);
  const list = useRefresh(() => api.events(from, to), []);

  const evs: WLEvent[] = list.data || [];
  const days: Record<string, WLEvent[]> = {};
  for (const e of evs) {
    const k = e.starts_at.slice(0, 10);
    (days[k] ||= []).push(e);
  }
  return (
    <div>
      <div className="top"><h1>Agenda</h1><div className="sp" />
        <button className="btn" onClick={() => setShow(true)}>+ Événement</button>
      </div>
      {list.error && <div className="err">{list.error}</div>}
      <div className="panel"><b>7 prochains jours</b>
        {Object.keys(days).sort().slice(0, 7).map((d) => (
          <div key={d} style={{ marginTop: 8 }}>
            <b>{new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'short' })}</b>
            {days[d].map((e) => (
              <div key={e.id} className="row" style={{ padding: '4px 0' }}>
                <span className="badge">{fmtDate(e.starts_at)} → {fmtDate(e.ends_at)}</span>
                <span>{e.title}</span>
                {e.project_name && <small style={{ color: '#93a0bb' }}>{e.project_name}</small>}
                <span style={{ flex: 1 }} />
                <button className="danger" onClick={async () => { if (confirm('Supprimer ?')) { await api.deleteEvent(e.id); list.reload(); } }}>✕</button>
              </div>
            ))}
          </div>
        ))}
        {evs.length === 0 && <div style={{ color: '#93a0bb' }}>Aucun événement.</div>}
      </div>
      <div className="panel"><b>Tous les événements ({evs.length})</b>
        <table><tbody>
          {evs.map((e) => <tr key={e.id}><td>{fmtDate(e.starts_at)}</td><td><b>{e.title}</b></td><td>{e.project_name || ''}</td></tr>)}
        </tbody></table>
      </div>
      {show && <EventModal projects={projects} onClose={() => setShow(false)} onSaved={() => { setShow(false); list.reload(); }} />}
    </div>
  );
}

export function EventModal({ projects, onClose, onSaved }: { projects: Project[]; onClose: () => void; onSaved: () => void }) {
  const now = new Date();
  const [f, setF] = useState({ title: '', description: '', starts_at: toLocal(now), ends_at: toLocal(new Date(now.getTime() + 36e5)), project_id: '' });
  const [err, setErr] = useState('');
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal onClose={onClose}>
      <h2 style={{ marginTop: 0 }}>Nouvel événement</h2>
      {err && <div className="err">{err}</div>}
      <label>Titre *</label>
      <input autoFocus value={f.title} onChange={(e) => set('title', e.target.value)} />
      <div className="grid2">
        <div><label>Début</label><input type="datetime-local" value={f.starts_at} onChange={(e) => set('starts_at', e.target.value)} /></div>
        <div><label>Fin</label><input type="datetime-local" value={f.ends_at} onChange={(e) => set('ends_at', e.target.value)} /></div>
      </div>
      <label>Projet</label>
      <select value={f.project_id} onChange={(e) => set('project_id', e.target.value)}>
        <option value="">— aucun —</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <label>Description</label>
      <textarea value={f.description} onChange={(e) => set('description', e.target.value)} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={async () => {
          try {
            if (!f.title.trim()) { setErr('Titre requis'); return; }
            await api.createEvent({ ...f, project_id: f.project_id || null, starts_at: new Date(f.starts_at).toISOString(), ends_at: new Date(f.ends_at).toISOString() });
            onSaved();
          } catch (e) { setErr((e as Error).message); }
        }}>Enregistrer</button>
        <button className="ghost" onClick={onClose}>Annuler</button>
      </div>
    </Modal>
  );
}
