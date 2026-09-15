import { useEffect, useRef, useState } from 'react';

/** Le cadre React réserve la place ; Electron y affiche Google sans iframe. */
export function GoogleDocsEditor({ documentId, tabId, onLocalCopy }: {
  documentId: string; tabId: string; onLocalCopy: () => Promise<void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [token] = useState(() => crypto.randomUUID());
  const [state, setState] = useState({ phase: 'loading', message: 'Chargement de Google Docs…' });
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const bridge = window.worklogsDesktop?.googleDocs;
    if (!bridge || !host.current) return;
    let disposed = false;
    let frame = 0;
    const measure = () => {
      const rect = host.current!.getBoundingClientRect();
      const center = host.current!.closest('.center')?.getBoundingClientRect();
      const top = Math.max(0, rect.top, center?.top ?? 0);
      const left = Math.max(0, rect.left);
      const bottom = Math.min(window.innerHeight, rect.bottom, center?.bottom ?? window.innerHeight);
      return { x: left, y: top, width: Math.max(0, Math.min(window.innerWidth, rect.right) - left), height: Math.max(0, bottom - top) };
    };
    const position = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const bounds = measure();
        const modal = document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]');
        bridge.bounds({ token, bounds, visible: !modal && !document.hidden && bounds.width > 0 && bounds.height > 0 });
      });
    };
    const unsubscribe = bridge.onState(next => { if (next.token === token) setState(next); });
    void bridge.open({ documentId, tabId, token, bounds: measure() }).then(next => {
      if (!disposed) { setState(next); position(); }
    }, error => { if (!disposed) setState({ phase: 'error', message: (error as Error).message }); });
    const observer = new ResizeObserver(position);
    observer.observe(host.current);
    const mutations = new MutationObserver(position);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'role', 'aria-modal'] });
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    document.addEventListener('visibilitychange', position);
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); unsubscribe();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      document.removeEventListener('visibilitychange', position);
      // Masquer garde Google vivant : ses dernières frappes peuvent finir l’envoi.
      bridge.hide(token);
    };
  }, [documentId, tabId, token]);

  const leave = async () => {
    setLeaving(true);
    try { await onLocalCopy(); }
    catch (error) { setState({ phase: 'error', message: (error as Error).message }); }
    finally { setLeaving(false); }
  };
  return <div className="google-native" aria-label="Éditeur Google Docs intégré">
    <div className="google-native-bar no-print">
      <div role={state.phase === 'error' ? 'alert' : 'status'}><strong>Google Docs dans WorkLogs</strong><span>{state.message}</span></div>
      <button className="ghost" disabled={leaving} onClick={() => void window.worklogsDesktop?.googleDocs?.reload(token)}>Recharger l’éditeur</button>
      <button className="ghost" disabled={leaving} onClick={() => void leave()}>{leaving ? 'Actualisation…' : 'Copie locale'}</button>
    </div>
    <div className="google-native-host" ref={host} aria-label="Zone du document Google" />
  </div>;
}
