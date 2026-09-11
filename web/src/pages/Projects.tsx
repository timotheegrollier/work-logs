import { useState } from 'react';
import { api, fmtDate, type Attachment, type Project, type Task } from '../lib';
import { useRefresh } from '../components/ui';

export default function Projects({ projects, reloadAll }: { projects: Project[]; reloadAll: () => void }) {
  const [name, setName] = useState('');
  const [pkey, setPkey] = useState('');
  const [err, setErr] = useState('');

  const create = async () => {
    try {
      if (!name.trim() || !pkey.trim()) { setErr('Nom + clé requis (ex. PERSO)'); return; }
      await api.createProject({ name: name.trim(), pkey: pkey.trim(), color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0') });
      setName(''); setPkey(''); setErr('');
      reloadAll();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div>
      <div className="top"><h1>Projets</h1></div>
      {err && <div className="err">{err}</div>}
      <div className="panel">
        <b>Nouveau projet</b>
        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="Nom (ex. Maison)" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Clé (ex. MAISON)" value={pkey} onChange={(e) => setPkey(e.target.value)} style={{ width: 160 }} />
          <button className="btn" onClick={create}>Créer</button>
        </div>
      </div>
      <div className="cards">
        {projects.map((p) => (
          <div className="card" key={p.id}>
            <span className="dot" style={{ background: p.color }} />
            <b style={{ display: 'inline' }}>{p.name}</b>
            <div><small>{p.pkey} · {p.open_tasks ?? 0} ouverte(s)</small></div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="danger" onClick={async () => { if (confirm(`Supprimer ${p.name} ? (tâches conservées, détachées)`)) { await api.deleteProject(p.id); reloadAll(); } }}>Supprimer</button>
            </div>
          </div>
        ))}
      </div>
      {projects.length === 0 && <div className="panel">Aucun projet.</div>}
    </div>
  );
}

export function Files({ projects }: { projects: Project[] }) {
  const [link, setLink] = useState({ project_id: '', task_id: '', doc_id: '' });
  const [tasks, setTasks] = useState<Task[]>([]);
  const list = useRefresh(() => api.attachments(link.task_id ? { task_id: link.task_id } : link.project_id ? { project_id: link.project_id } : {}), [link.task_id, link.project_id]);

  const loadTasks = async (pid: string) => {
    setLink((p) => ({ ...p, project_id: pid, task_id: '' }));
    setTasks(pid ? await api.tasks({ project_id: pid }).catch(() => []) : []);
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    await api.upload(f, link);
    list.reload();
  };
  const atts: Attachment[] = list.data || [];
  return (
    <div>
      <div className="top"><h1>Fichiers</h1></div>
      <div className="panel">
        <div className="row">
          <select value={link.project_id} onChange={(e) => loadTasks(e.target.value)}>
            <option value="">— projet —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={link.task_id} onChange={(e) => setLink((p) => ({ ...p, task_id: e.target.value }))}>
            <option value="">— tâche —</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
          <label className="btn" style={{ cursor: 'pointer' }}>+ Uploader
            <input type="file" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
        </div>
        <small style={{ color: '#93a0bb' }}>Astuce : choisis un projet/tâche avant d'uploader pour lier le fichier.</small>
      </div>
      <div className="panel">
        <table><thead><tr><th>Fichier</th><th>Taille</th><th>Ajouté</th><th></th></tr></thead>
          <tbody>
            {atts.map((a) => (
              <tr key={a.id}>
                <td><a href={api.fileUrl(a.stored)} target="_blank" rel="noreferrer">{a.filename}</a></td>
                <td>{(a.size / 1024).toFixed(1)} Ko</td>
                <td>{fmtDate(a.created_at)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="danger" onClick={async () => { if (confirm('Supprimer ce fichier ?')) { await api.deleteAttachment(a.id); list.reload(); } }}>✕</button>
                </td>
              </tr>
            ))}
            {atts.length === 0 && <tr><td colSpan={4}><i style={{ color: '#93a0bb' }}>Aucun fichier.</i></td></tr>}
          </tbody></table>
      </div>
    </div>
  );
}
