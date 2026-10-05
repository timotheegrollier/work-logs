import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Project, type SharedEntry, type SharedListing, type SharedStatus } from '../lib';
import { badgesFor, REACH_HELP, REACH_LABELS } from '../shared-session';
import { editorKind } from '../file-formats';

const OPEN_KEY = 'worklogs-shared-open';
const POLL_MS = 30_000;

const readOpen = () => {
  try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; }
};

/**
 * Section « Dossier partagé » de la colonne Procédures : le dossier du TSE monté
 * sur cet ordinateur, en arbre. Un fichier s'ouvre au centre comme une entrée.
 * Absente de la PWA (un navigateur n'atteint pas un partage SMB). Voir §25.
 */
export function SharedFolder({ active, projectId, projects, selectedPath, revision, onOpen }: {
  /** Colonne Procédures affichée : sinon, ni requête ni sondage. */
  active: boolean;
  projectId: string;
  projects: Project[];
  selectedPath: string | null;
  revision: number;
  onOpen: (path: string) => void;
}) {
  const [status, setStatus] = useState<SharedStatus | null>(null);
  const [open, setOpen] = useState(readOpen);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [listings, setListings] = useState<Map<string, SharedListing>>(() => new Map());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const linked = status?.projects?.[projectId] ?? '';
  const root = projectId && linked ? linked : '';
  const project = projects.find((candidate) => candidate.id === projectId);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.sharedStatus());
    } catch {
      setStatus({ available: false });
    }
  }, []);

  const loadDir = useCallback(async (dir: string) => {
    try {
      const listing = await api.sharedList(dir);
      setListings((current) => new Map(current).set(dir, listing));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await refreshStatus();
    await Promise.all([root, ...expandedRef.current].map((dir) => loadDir(dir)));
  }, [refreshStatus, loadDir, root]);

  useEffect(() => {
    if (active) void refreshStatus();
  }, [active, refreshStatus, revision]);

  const usable = Boolean(active && status?.available && status.root);
  useEffect(() => {
    if (!open || !usable) return;
    void refreshAll();
  }, [open, usable, refreshAll, revision, status?.reach]);

  useEffect(() => {
    if (!open || !usable) return;
    const poll = () => { if (document.visibilityState !== 'hidden') void refreshAll(); };
    const timer = setInterval(poll, POLL_MS);
    window.addEventListener('focus', poll);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', poll);
    };
  }, [open, usable, refreshAll]);

  if (!status?.available) return null;

  const choose = async () => {
    const bridge = window.worklogsDesktop?.shared;
    if (!bridge) return;
    setBusy(true);
    setError('');
    try {
      const result = await bridge.chooseRoot();
      if (result.error) setError(result.error);
      if (result.status) {
        setStatus(result.status);
        setListings(new Map());
        setExpanded(new Set());
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleDir = (dir: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void loadDir(dir);
      }
      return next;
    });
  };

  const reach = status.reach ?? 'unconfigured';
  const renderDir = (dir: string, depth: number) => {
    const listing = listings.get(dir);
    if (!listing) return <p className="empty">Lecture…</p>;
    if (!listing.entries.length) return <p className="empty">{listing.offline ? 'Rien de gardé sur cet ordinateur ici.' : 'Dossier vide.'}</p>;
    return (
      <ul className="shared-tree" aria-label={dir ? `Contenu de ${dir}` : 'Contenu du dossier partagé'}>
        {listing.entries.map((entry) => (entry.type === 'dir'
          ? (
            <li key={entry.path}>
              <button
                className="shared-dir"
                aria-expanded={expanded.has(entry.path)}
                aria-label={`Dossier ${entry.name}`}
                onClick={() => toggleDir(entry.path)}
              >
                <span aria-hidden="true">{expanded.has(entry.path) ? '▾' : '▸'}</span> {entry.name}
              </button>
              {expanded.has(entry.path) && depth < 12 && renderDir(entry.path, depth + 1)}
            </li>
          )
          : <FileRow key={entry.path} entry={entry} selected={entry.path === selectedPath} onOpen={onOpen} />))}
        {listing.truncated && <li className="empty">Dossier trop grand : seuls les 2 000 premiers éléments sont listés.</li>}
      </ul>
    );
  };

  return (
    <details
      className="archives shared-folder"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        try { localStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch {}
      }}
    >
      <summary>
        Dossier partagé
        {status.root && <span className={'shared-reach is-' + reach}>{REACH_LABELS[reach]}</span>}
        {Boolean(status.pending) && <span className="count" title="Envois en attente" aria-label={`${status.pending} envoi(s) en attente`}>⇡ {status.pending}</span>}
        {Boolean(status.conflicts) && <span className="count is-conflict" title="Conflits à régler" aria-label={`${status.conflicts} conflit(s) à régler`}>⚠ {status.conflicts}</span>}
      </summary>
      <div className="shared-body">
        {!status.root ? (
          status.configurable ? (
            <>
              <p className="empty">Choisis le dossier de l’équipe (le partage du TSE monté sur cet ordinateur) : ses fichiers s’ouvriront ici, chacun son tour, sans rien écraser.</p>
              <button className="ghost" disabled={busy} onClick={() => void choose()}>Choisir le dossier…</button>
            </>
          ) : <p className="empty">Aucun dossier partagé n’est configuré.</p>
        ) : (
          <>
            <p className="shared-root" title={status.root}>
              {status.label}{root && <> · {project?.name ?? 'projet'} : <strong>{root}</strong></>}
            </p>
            {REACH_HELP[reach] && <p className="notice">{REACH_HELP[reach]}</p>}
            {error && <p className="error" role="alert">{error}</p>}
            {renderDir(root, 0)}
            {status.configurable && <button className="ghost shared-change" disabled={busy} onClick={() => void choose()}>Changer de dossier…</button>}
          </>
        )}
      </div>
    </details>
  );
}

function FileRow({ entry, selected, onOpen }: { entry: SharedEntry; selected: boolean; onOpen: (path: string) => void }) {
  const badges = badgesFor(entry);
  const editable = Boolean(editorKind(entry.ext));
  return (
    <li>
      <button
        className={'shared-file' + (selected ? ' is-selected' : '') + (editable ? '' : ' is-foreign')}
        aria-current={selected ? 'true' : undefined}
        aria-label={`Ouvrir ${entry.name}${badges.length ? ` — ${badges.map((badge) => badge.label).join(', ')}` : ''}`}
        onClick={() => onOpen(entry.path)}
      >
        <span className="shared-file-name">{entry.name}</span>
        {badges.map((badge) => <span key={badge.icon} className="shared-badge" title={badge.label} aria-hidden="true">{badge.icon}</span>)}
      </button>
    </li>
  );
}
