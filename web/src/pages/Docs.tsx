import { useState } from 'react';
import { api, fmtDate, type Doc, type Project } from '../lib';
import { Modal, md, useRefresh } from '../components/ui';

export default function Docs({ projects }: { projects: Project[] }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Doc | null>(null);
  const [edit, setEdit] = useState<Partial<Doc> | null>(null);
  const list = useRefresh(() => api.docs({ search: q }), [q]);

  const docs: Doc[] = list.data || [];
  const cur: Doc | undefined = (list.data || []).find((d) => d.id === sel?.id) || sel || undefined;
  return (
    <div>
      <div className="top"><h1>Docs</h1><div className="sp" />
        <input placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => setEdit({ title: '', content_md: '# Nouveau doc\n\n', project_id: null })}>+ Doc</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,300px) 1fr', gap: 12 }}>
        <div className="panel">
          <b>Notes ({docs.length})</b>
          {docs.map((d) => (
            <div key={d.id} onClick={() => setSel(d)}
              style={{ padding: '8px', borderRadius: 10, cursor: 'pointer', background: sel?.id === d.id ? '#1e2740' : 'transparent' }}>
              <b>{d.title}</b><br /><small style={{ color: '#93a0bb' }}>{fmtDate(d.updated_at)}</small>
            </div>
          ))}
          {docs.length === 0 && <div style={{ color: '#93a0bb' }}>Aucun doc.</div>}
        </div>
        <div className="panel">
          {!cur && <i style={{ color: '#93a0bb' }}>Sélectionne un doc ou crée-en un.</i>}
          {cur && (
            <div>
              <div className="top"><h2 style={{ margin: 0 }}>{cur.title}</h2><div className="sp" />
                <button className="ghost" onClick={() => setEdit(cur)}>Modifier</button>
                <button className="danger" onClick={async () => { if (confirm('Supprimer ?')) { await api.deleteDoc(cur.id); setSel(null); list.reload(); } }}>Supprimer</button>
              </div>
              <div className="md" dangerouslySetInnerHTML={md(cur.content_md || '*Vide*')} />
            </div>
          )}
        </div>
      </div>
      {edit && <DocModal projects={projects} initial={edit} onClose={() => setEdit(null)} onSaved={(d) => { setEdit(null); setSel(d); list.reload(); }} />}
    </div>
  );
}

function DocModal({ projects, initial, onClose, onSaved }: { projects: Project[]; initial: Partial<Doc>; onClose: () => void; onSaved: (d: Doc) => void }) {
  const [f, setF] = useState({ title: initial.title || '', content_md: initial.content_md || '', project_id: (initial.project_id as string) || '' });
  const [err, setErr] = useState('');
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal onClose={onClose}>
      <h2 style={{ marginTop: 0 }}>{initial.id ? 'Modifier le doc' : 'Nouveau doc'}</h2>
      {err && <div className="err">{err}</div>}
      <label>Titre *</label>
      <input autoFocus value={f.title} onChange={(e) => set('title', e.target.value)} />
      <label>Projet</label>
      <select value={f.project_id} onChange={(e) => set('project_id', e.target.value)}>
        <option value="">— aucun —</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <label>Contenu (Markdown)</label>
      <textarea style={{ minHeight: 220 }} value={f.content_md} onChange={(e) => set('content_md', e.target.value)} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={async () => {
          try {
            if (!f.title.trim()) { setErr('Titre requis'); return; }
            const body = { title: f.title.trim(), content_md: f.content_md, project_id: f.project_id || null };
            const d = initial.id ? await api.updateDoc(initial.id, body) : await api.createDoc(body);
            onSaved(d);
          } catch (e) { setErr((e as Error).message); }
        }}>Enregistrer</button>
        <button className="ghost" onClick={onClose}>Annuler</button>
      </div>
    </Modal>
  );
}
