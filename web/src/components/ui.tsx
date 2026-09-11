import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib';

export function useRefresh<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then((d) => alive && (setData(d), setError(''))).catch((e) => alive && setError(e.message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, loading, error, reload: () => setTick((t) => t + 1), setData };
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

export function GlobalSearch({ onGo }: { onGo: (tab: string) => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.search>> | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => api.search(q).then(setRes).catch(() => null), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div style={{ position: 'relative' }}>
      <input className="search" placeholder="Recherche globale…" value={q} onChange={(e) => setQ(e.target.value)} />
      {res && (
        <div className="panel" style={{ position: 'absolute', zIndex: 20, width: 340, marginTop: 6 }}>
          <b>Tâches ({res.tasks.length})</b>
          {res.tasks.slice(0, 5).map((t: { id: string; title: string }) => <div key={t.id}>• {t.title}</div>)}
          <b>Docs ({res.docs.length})</b>
          {res.docs.slice(0, 5).map((d: { id: string; title: string }) => <div key={d.id}>• {d.title}</div>)}
          <b>Events ({res.events.length})</b>
          {res.events.slice(0, 5).map((e: { id: string; title: string }) => <div key={e.id}>• {e.title}</div>)}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="ghost" onClick={() => { onGo('kanban'); setQ(''); setRes(null); }}>Voir kanban</button>
            <button className="ghost" onClick={() => { setQ(''); setRes(null); }}>Fermer</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Mini rendu Markdown (titres, gras, listes, code) — sans dépendance
export function md(src: string) {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = esc
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.*)$/gm, '<li>$1</li>');
  return { __html: html.replace(/\n/g, '<br/>') };
}
