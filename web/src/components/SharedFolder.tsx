import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Project, type SharedDirSummary, type SharedEntry, type SharedListing, type SharedSearch, type SharedStatus } from '../lib';
import { badgesFor, REACH_HELP, REACH_LABELS, sinceLabel } from '../shared-session';
import { editorKind } from '../file-formats';
import { fileNameProblem, NEW_FILE_TYPES, newFileBytes, withExtension, type NewFileType } from '../new-files';

const OPEN_KEY = 'worklogs-shared-open';
const POLL_MS = 30_000;

/** Un dossier de l'arbre : son contenu, ou pourquoi on ne peut pas l'ouvrir (accès refusé…). */
type DirState = SharedListing | { failure: string; denied: boolean };
const failed = (state: DirState | undefined): state is { failure: string; denied: boolean } => Boolean(state && 'failure' in state);

const SEARCH_DELAY_MS = 350;

const readOpen = () => {
  try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; }
};

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/** `path` est le dossier `dir` lui-même, ou quelque chose dedans. */
const within = (path: string, dir: string) => path === dir || path.startsWith(dir + '/');
/** `path` une fois le dossier `from` renommé en `to` (inchangé s'il n'est pas dedans). */
const movedPath = (path: string, from: string, to: string) => (within(path, from) ? to + path.slice(from.length) : path);
const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`;

/**
 * Section « Dossier partagé » de la colonne Procédures : le dossier du TSE monté
 * sur cet ordinateur, en arbre. Un fichier s'ouvre au centre comme une entrée.
 * Absente de la PWA (un navigateur n'atteint pas un partage SMB). Voir §25.
 */
export function SharedFolder({ active, projectId, projects, selectedPath, revision, onOpen, onDeleted, onRenamed }: {
  /** Colonne Procédures affichée : sinon, ni requête ni sondage. */
  active: boolean;
  projectId: string;
  projects: Project[];
  selectedPath: string | null;
  revision: number;
  onOpen: (path: string) => void;
  /** Un fichier, ou un dossier avec tout son contenu. */
  onDeleted: (path: string) => void;
  /** Un dossier renommé : ce qui était dedans a changé de chemin. */
  onRenamed: (from: string, to: string) => void;
}) {
  const [status, setStatus] = useState<SharedStatus | null>(null);
  const [open, setOpen] = useState(readOpen);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [listings, setListings] = useState<Map<string, DirState>>(() => new Map());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Choix du sous-dossier du projet filtré : chaque dossier de l'arbre propose « Relier ici ». */
  const [linking, setLinking] = useState(false);
  /** Adresse du partage à monter (\\serveur\partage) ; formulaire visible sans dossier, ou sur demande. */
  const [address, setAddress] = useState('');
  /** Compte Windows du partage (`SRVMURGAT\TonNom`), facultatif : le mot de passe se saisit dans la fenêtre du système. */
  const [account, setAccount] = useState('');
  const [showConnect, setShowConnect] = useState(false);
  const [connecting, setConnecting] = useState('');
  /** Recherche par nom dans le partage (ou le dossier du projet) : remplace l'arbre tant qu'elle est tapée. */
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SharedSearch | null>(null);
  const [searching, setSearching] = useState(false);
  /** « Nouveau fichier » : type, nom, dossier (la racine ou un dossier déplié de l'arbre). */
  const [creating, setCreating] = useState<{ ext: NewFileType['ext']; name: string; dir: string } | null>(null);
  /** « Nouveau dossier » : nom, et où (la racine ou un dossier déplié). */
  const [creatingDir, setCreatingDir] = useState<{ name: string; dir: string } | null>(null);
  /** Dossier dont les actions (Renommer, Supprimer) sont ouvertes sous sa ligne. */
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  /** Dossier renommé dans sa ligne de l'arbre. */
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  /** Refus d'une action sur un dossier : affiché sous sa ligne, pas en haut de la section. */
  const [dirError, setDirError] = useState<{ path: string; message: string } | null>(null);
  const [lastOpened, setLastOpened] = useState('');
  useEffect(() => { setLinking(false); }, [projectId]);
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
      // Partage parti (démonté, réseau) : l'état affiché suit, avec « Se reconnecter ».
      if (listing.offline) void refreshStatus();
    } catch (e) {
      // L'erreur reste sous ce dossier (sinon il afficherait « Lecture… » sans fin).
      setListings((current) => new Map(current).set(dir, { failure: (e as Error).message, denied: e instanceof ApiError && e.code === 'SHARED_DENIED' }));
    }
  }, [refreshStatus]);

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

  const searchRoot = projectId && status?.projects?.[projectId] ? status.projects[projectId] : '';
  useEffect(() => {
    const words = query.trim();
    setSearch(null);
    if (words.replace(/\s+/g, '').length < 2) { setSearching(false); return; }
    setSearching(true);
    let alive = true;
    const timer = setTimeout(() => {
      api.searchShared(words, searchRoot).then(
        (found) => { if (alive) { setSearch(found); setSearching(false); } },
        (e: Error) => { if (alive) { setError(e.message); setSearching(false); } },
      );
    }, SEARCH_DELAY_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, searchRoot]);

  if (!status?.available) return null;

  const applyStatus = (next: SharedStatus) => {
    setStatus(next);
    setListings(new Map());
    setExpanded(new Set());
    setShowConnect(false);
  };

  /** Monte le partage comme Nemo ; un mot de passe se saisit dans la fenêtre du gestionnaire de fichiers. */
  const connect = async (target: string, who = '') => {
    const bridge = window.worklogsDesktop?.shared;
    if (!bridge?.connect) return;
    setBusy(true);
    setError('');
    setConnecting(target);
    try {
      const result = await bridge.connect(target, who.trim() || undefined);
      if (result.error) setError(result.error);
      if (result.status) applyStatus(result.status);
    } finally {
      setConnecting('');
      setBusy(false);
    }
  };

  const choose = async () => {
    const bridge = window.worklogsDesktop?.shared;
    if (!bridge) return;
    setBusy(true);
    setError('');
    try {
      const result = await bridge.chooseRoot();
      if (result.error) setError(result.error);
      if (result.status) applyStatus(result.status);
    } finally {
      setBusy(false);
    }
  };

  const link = async (dir: string) => {
    setBusy(true);
    setError('');
    try {
      setStatus(await api.linkSharedFolder(projectId, dir));
      setLinking(false);
      setExpanded(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    setBusy(true);
    setError('');
    try {
      setStatus(await api.unlinkSharedFolder(projectId));
      setExpanded(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Crée le fichier sur le partage (jamais par-dessus un autre), puis l'ouvre au centre. */
  const createFile = async () => {
    if (!creating) return;
    const problem = fileNameProblem(creating.name);
    if (problem) {
      setError(problem);
      return;
    }
    const name = withExtension(creating.name, creating.ext);
    const rel = creating.dir ? `${creating.dir}/${name}` : name;
    setBusy(true);
    setError('');
    try {
      const bytes = await newFileBytes(creating.ext, { title: name.slice(0, name.length - creating.ext.length - 1), author: status?.displayName ?? '' });
      await api.createShared(rel, bytes);
      setCreating(null);
      if (creating.dir) setExpanded((current) => new Set([...current, creating.dir]));
      await loadDir(creating.dir);
      onOpen(rel);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Un dossier trouvé : l'arbre s'ouvre jusqu'à lui. */
  const reveal = (dir: string) => {
    const start = searchRoot ? searchRoot.split('/').length : 0;
    const parts = dir.split('/');
    const chain = parts.map((_part, index) => parts.slice(0, index + 1).join('/')).slice(start);
    setQuery('');
    setExpanded((current) => new Set([...current, ...chain]));
    for (const each of chain) void loadDir(each);
  };

  /** Supprime un fichier du partage, après confirmation : immédiat pour toute l'équipe. */
  const removeFile = async (entry: SharedEntry) => {
    if (entry.unavailable) return;
    if (!confirm(`Supprimer « ${entry.name} » du dossier partagé ? Cette action est immédiate pour toute l’équipe.`)) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteShared(entry.path);
      await loadDir(parentOf(entry.path));
      onDeleted(entry.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Crée le dossier sur le partage (jamais par-dessus un autre), puis le déplie : un nouveau fichier y ira. */
  const createDir = async () => {
    if (!creatingDir) return;
    const name = creatingDir.name.trim();
    const problem = fileNameProblem(name, 'dossier');
    if (problem) {
      setError(problem);
      return;
    }
    const { dir } = creatingDir;
    const rel = dir ? `${dir}/${name}` : name;
    setBusy(true);
    setError('');
    try {
      await api.createSharedDir(rel);
      setCreatingDir(null);
      setExpanded((current) => new Set([...current, ...(dir && dir !== root ? [dir] : []), rel]));
      setLastOpened(rel);
      await Promise.all([loadDir(dir), loadDir(rel)]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Renomme un dossier sur place : l'arbre (dossiers dépliés, fichier ouvert) suit le nouveau nom. */
  const renameDir = async () => {
    if (!renaming) return;
    const from = renaming.path;
    const name = renaming.name.trim();
    if (name === from.split('/').pop()) {
      setRenaming(null);
      return;
    }
    const problem = fileNameProblem(name, 'dossier');
    if (problem) {
      setDirError({ path: from, message: problem });
      return;
    }
    setBusy(true);
    setDirError(null);
    try {
      const { path: to } = await api.renameSharedDir(from, name);
      setRenaming(null);
      setExpanded((current) => new Set([...current].map((dir) => movedPath(dir, from, to))));
      setListings((current) => new Map([...current].filter(([dir]) => !within(dir, from))));
      setLastOpened((current) => movedPath(current, from, to));
      await loadDir(parentOf(from));
      onRenamed(from, to);
    } catch (e) {
      setDirError({ path: from, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Supprime un dossier et tout ce qu'il contient. Le serveur fait d'abord le
   * bilan (ou dit pourquoi c'est refusé : fichier ouvert, brouillon…) ; la
   * confirmation annonce ce qui partira, et seul ce contenu-là est supprimé.
   */
  const removeDir = async (entry: SharedEntry) => {
    setBusy(true);
    setDirError(null);
    let summary: SharedDirSummary;
    try {
      summary = await api.sharedDirSummary(entry.path);
    } catch (e) {
      setDirError({ path: entry.path, message: (e as Error).message });
      setBusy(false);
      return;
    }
    const content = [summary.files ? plural(summary.files, 'fichier') : '', summary.dirs ? plural(summary.dirs, 'sous-dossier') : '']
      .filter(Boolean).join(' et ');
    const question = content
      ? `Supprimer le dossier « ${entry.name} » et tout son contenu (${content}) du dossier partagé ? Cette action est immédiate pour toute l’équipe.`
      : `Supprimer le dossier vide « ${entry.name} » du dossier partagé ?`;
    if (!confirm(question)) {
      setBusy(false);
      return;
    }
    try {
      await api.deleteSharedDir(entry.path, summary.token);
      setActionsFor(null);
      setExpanded((current) => new Set([...current].filter((dir) => !within(dir, entry.path))));
      onDeleted(entry.path);
    } catch (e) {
      // Arrêtée en route : le message dit ce qui est parti ; l'arbre montre ce qui reste.
      setDirError({ path: entry.path, message: (e as Error).message });
    } finally {
      await loadDir(parentOf(entry.path));
      setBusy(false);
    }
  };

  const toggleDir = (dir: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        setLastOpened(dir);
        void loadDir(dir);
      }
      return next;
    });
  };

  const reach = status.reach ?? 'unconfigured';
  const canConnect = Boolean(status.configurable && window.worklogsDesktop?.shared?.connect);
  /** Où créer un fichier ou un dossier : le dernier dossier déplié, sinon la racine (ou le dossier du projet). */
  const defaultDir = lastOpened && expanded.has(lastOpened) && (!root || lastOpened.startsWith(root + '/')) ? lastOpened : root;
  const dirOptions = (
    <>
      <option value={root}>{root ? root.split('/').pop() : status.label}</option>
      {[...expanded].filter((dir) => dir !== root && (!root || dir.startsWith(root + '/'))).sort().map((dir) => (
        <option key={dir} value={dir}>{root ? dir.slice(root.length + 1) : dir}</option>
      ))}
    </>
  );
  const connectForm = canConnect && (
    <>
      <form className="shared-connect" onSubmit={(event) => { event.preventDefault(); void connect(address, account); }}>
        <label>
          Adresse du partage
          <input
            aria-label="Adresse du partage"
            placeholder="\\serveur\partage"
            value={address}
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <label>
          Compte (facultatif)
          <input
            aria-label="Compte du partage"
            placeholder="SRVMURGAT\TonNom"
            value={account}
            spellCheck={false}
            autoComplete="username"
            onChange={(event) => setAccount(event.target.value)}
          />
        </label>
        <button className="task-primary" type="submit" disabled={busy || !address.trim()}>Se connecter</button>
      </form>
      {connecting && (
        <p className="notice" role="status">
          Connexion à {connecting}… Si la fenêtre « Authentification requise » s’ouvre (parfois derrière WorkLogs),
          saisis-y ton mot de passe et choisis « Se souvenir pour toujours » : WorkLogs attend que le partage soit monté.
        </p>
      )}
    </>
  );
  const renderDir = (dir: string, depth: number) => {
    const listing = listings.get(dir);
    if (!listing) return <p className="empty">Lecture…</p>;
    if (failed(listing)) {
      // Le dossier relié au projet n'est pas (ou plus) dans ce partage : le dire, « Délier » est juste au-dessus.
      if (dir && dir === root && project && !listing.denied) {
        return (
          <p className="error shared-dir-error" role="alert">
            Le dossier relié à {project.name} (« {root} ») n’est pas dans ce partage. « Délier {project.name} de son dossier » affiche tout le partage.
          </p>
        );
      }
      return (
        <p className="error shared-dir-error" role="alert">
          {listing.failure}
          {listing.denied && canConnect && (
            <> Sur un partage Windows, c’est souvent l’accès invité ou un autre compte que celui du TSE.{' '}
              <button className="link-button" onClick={() => { setAddress(status?.address ?? ''); setAccount(status?.account ?? ''); setShowConnect(true); }}>
                Se connecter avec mon compte…
              </button>
            </>
          )}
        </p>
      );
    }
    const seen = listing.offline && listing.listed_at ? <p className="empty shared-seen">Hors ligne — liste vue {sinceLabel(listing.listed_at)}.</p> : null;
    if (!listing.entries.length) return <>{seen}<p className="empty">{listing.offline ? 'Rien de gardé sur cet ordinateur ici.' : 'Dossier vide.'}</p></>;
    // Renommer, supprimer : seulement quand le partage répond (pas sur une liste gardée hors ligne).
    const editable = reach === 'ok' && !listing.offline;
    return (
      <>
      {seen}
      <ul className="shared-tree" aria-label={dir ? `Contenu de ${dir}` : 'Contenu du dossier partagé'}>
        {listing.entries.map((entry) => (entry.type === 'dir'
          ? (
            <li key={entry.path}>
              {renaming?.path === entry.path ? (
                <form className="shared-rename" aria-label={`Renommer le dossier ${entry.name}`} onSubmit={(event) => { event.preventDefault(); void renameDir(); }}>
                  <input
                    aria-label="Nouveau nom du dossier"
                    value={renaming.name}
                    autoFocus
                    // Le nom entier sélectionné : on tape le nouveau, comme dans l'explorateur de fichiers.
                    onFocus={(event) => event.currentTarget.select()}
                    spellCheck={false}
                    onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setRenaming(null);
                        setDirError(null);
                      }
                    }}
                  />
                  <button className="task-primary" type="submit" disabled={busy || !renaming.name.trim()}>Renommer</button>
                  <button className="ghost" type="button" onClick={() => { setRenaming(null); setDirError(null); }}>Annuler</button>
                </form>
              ) : (
                <div className="shared-dir-row">
                  <button
                    className="shared-dir"
                    aria-expanded={expanded.has(entry.path)}
                    aria-label={`Dossier ${entry.name}`}
                    onClick={() => toggleDir(entry.path)}
                  >
                    <span aria-hidden="true">{expanded.has(entry.path) ? '▾' : '▸'}</span> {entry.name}
                  </button>
                  {linking && project ? (
                    <button className="ghost shared-link-here" disabled={busy} aria-label={`Relier ${project.name} au dossier ${entry.path}`} onClick={() => void link(entry.path)}>
                      Relier ici
                    </button>
                  ) : editable && (
                    <button
                      className="ghost shared-dir-more"
                      aria-label={`Renommer ou supprimer ${entry.name}`}
                      aria-expanded={actionsFor === entry.path}
                      title="Renommer ou supprimer ce dossier"
                      onClick={() => {
                        setDirError(null);
                        setActionsFor(actionsFor === entry.path ? null : entry.path);
                      }}
                    >
                      ⋯
                    </button>
                  )}
                </div>
              )}
              {actionsFor === entry.path && editable && !linking && renaming?.path !== entry.path && (
                <div className="shared-dir-actions">
                  <button
                    className="ghost"
                    disabled={busy}
                    aria-label={`Renommer ${entry.name}`}
                    onClick={() => {
                      setActionsFor(null);
                      setDirError(null);
                      setRenaming({ path: entry.path, name: entry.name });
                    }}
                  >
                    Renommer
                  </button>
                  <button className="ghost shared-dir-remove" disabled={busy} aria-label={`Supprimer ${entry.name} du partage`} onClick={() => void removeDir(entry)}>
                    Supprimer…
                  </button>
                </div>
              )}
              {dirError?.path === entry.path && <p className="error shared-dir-error" role="alert">{dirError.message}</p>}
              {expanded.has(entry.path) && depth < 12 && renderDir(entry.path, depth + 1)}
            </li>
          )
          : <FileRow key={entry.path} entry={entry} selected={entry.path === selectedPath} disabled={busy} onOpen={onOpen} onDelete={(target) => void removeFile(target)} />))}
        {listing.truncated && <li className="empty">Dossier trop grand : seuls les 2 000 premiers éléments sont listés.</li>}
      </ul>
      </>
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
              <p className="empty">Le dossier de l’équipe, sur le TSE : son adresse comme sous Windows (\\serveur\partage). Ses fichiers s’ouvriront ici, chacun son tour, sans rien écraser.</p>
              {connectForm}
              {error && <p className="error" role="alert">{error}</p>}
              <button className="ghost shared-change" disabled={busy} onClick={() => void choose()}>
                {canConnect ? 'ou choisir un dossier déjà monté…' : 'Choisir le dossier…'}
              </button>
            </>
          ) : <p className="empty">Aucun dossier partagé n’est configuré.</p>
        ) : (
          <>
            <p className="shared-root" title={status.root}>
              {status.label}{root && <> · {project?.name ?? 'projet'} : <strong>{root}</strong></>}
            </p>
            {project && (
              <div className="shared-project-link">
                {root ? (
                  <button className="ghost" disabled={busy} aria-label={`Délier ${project.name} de son dossier`} onClick={() => void unlink()}>
                    Délier {project.name} de son dossier
                  </button>
                ) : linking ? (
                  <>
                    <span>Choisis le dossier de {project.name} dans l’arbre.</span>
                    <button className="ghost" onClick={() => setLinking(false)}>Annuler</button>
                  </>
                ) : (
                  <button className="ghost" disabled={busy || reach !== 'ok'} onClick={() => setLinking(true)}>
                    Relier {project.name} à un dossier…
                  </button>
                )}
              </div>
            )}
            {status.relayError ? (
              <p className="notice">Le relais du dossier partagé ne répond pas ({status.relayError}). Tailscale est-il allumé sur ce téléphone ?</p>
            ) : REACH_HELP[reach] && <p className="notice">{REACH_HELP[reach]}</p>}
            {reach === 'unmounted' && status.address && canConnect && (
              <button className="task-primary" disabled={busy} onClick={() => void connect(status.address!, status.account ?? '')}>
                Se reconnecter à {status.address}
              </button>
            )}
            {connecting && !showConnect && <p className="notice" role="status">Connexion à {connecting}… saisis ton mot de passe dans la fenêtre « Authentification requise » si elle s’ouvre (parfois derrière WorkLogs).</p>}
            {error && <p className="error" role="alert">{error}</p>}
            {creating ? (
              <form className="shared-new" aria-label="Nouveau fichier" onSubmit={(event) => { event.preventDefault(); void createFile(); }}>
                <label>
                  Type
                  <select aria-label="Type de fichier" value={creating.ext} onChange={(event) => setCreating({ ...creating, ext: event.target.value as NewFileType['ext'] })}>
                    {NEW_FILE_TYPES.map((type) => <option key={type.ext} value={type.ext}>{type.label}</option>)}
                  </select>
                </label>
                <label>
                  Nom
                  <input aria-label="Nom du fichier" placeholder="Procédure sauvegarde" value={creating.name} autoFocus onChange={(event) => setCreating({ ...creating, name: event.target.value })} />
                </label>
                <label>
                  Dans
                  <select aria-label="Dossier du nouveau fichier" value={creating.dir} onChange={(event) => setCreating({ ...creating, dir: event.target.value })}>
                    {dirOptions}
                  </select>
                </label>
                <div className="shared-project-link">
                  <button className="task-primary" type="submit" disabled={busy || !creating.name.trim()}>Créer</button>
                  <button className="ghost" type="button" onClick={() => { setCreating(null); setError(''); }}>Annuler</button>
                </div>
              </form>
            ) : creatingDir ? (
              <form className="shared-new" aria-label="Nouveau dossier" onSubmit={(event) => { event.preventDefault(); void createDir(); }}>
                <label>
                  Nom
                  <input aria-label="Nom du dossier" placeholder="3. Sauvegardes" value={creatingDir.name} autoFocus onChange={(event) => setCreatingDir({ ...creatingDir, name: event.target.value })} />
                </label>
                <label>
                  Dans
                  <select aria-label="Emplacement du nouveau dossier" value={creatingDir.dir} onChange={(event) => setCreatingDir({ ...creatingDir, dir: event.target.value })}>
                    {dirOptions}
                  </select>
                </label>
                <div className="shared-project-link">
                  <button className="task-primary" type="submit" disabled={busy || !creatingDir.name.trim()}>Créer</button>
                  <button className="ghost" type="button" onClick={() => { setCreatingDir(null); setError(''); }}>Annuler</button>
                </div>
              </form>
            ) : reach === 'ok' && (
              <div className="shared-new-buttons">
                <button className="ghost shared-change" disabled={busy} onClick={() => setCreating({ ext: 'docx', name: '', dir: defaultDir })}>
                  ＋ Nouveau fichier…
                </button>
                <button className="ghost shared-change" disabled={busy} onClick={() => setCreatingDir({ name: '', dir: defaultDir })}>
                  ＋ Nouveau dossier…
                </button>
              </div>
            )}
            <input
              className="shared-search"
              type="search"
              aria-label="Chercher dans le partage"
              placeholder={root ? `Chercher dans ${root.split('/').pop()}…` : 'Chercher un fichier ou un dossier…'}
              value={query}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query.trim().replace(/\s+/g, '').length >= 2 ? (
              <div className="shared-search-results" role="region" aria-label="Résultats de la recherche">
                {searching || !search ? <p className="empty">Recherche…</p> : (
                  <>
                    <p className="empty">
                      {search.results.length ? `${search.results.length}${search.results.length >= 100 ? '+' : ''} résultat${search.results.length > 1 ? 's' : ''}` : 'Aucun nom ne correspond'}
                      {search.offline ? ', dans les listes gardées sur cet ordinateur (hors ligne)' : search.partial ? ' — recherche arrêtée avant la fin : précise les mots' : ''}
                      {search.denied ? ` · ${search.denied} dossier${search.denied > 1 ? 's' : ''} fermé${search.denied > 1 ? 's' : ''} à ton compte` : ''}.
                    </p>
                    <ul className="shared-tree">
                      {search.results.map((result) => (
                        <li key={result.path}>
                          {result.type === 'dir' ? (
                            <button className="shared-dir shared-search-hit" aria-label={`Afficher le dossier ${result.path}`} onClick={() => reveal(result.path)}>
                              <span className="shared-file-name"><span aria-hidden="true">▸</span> {result.name}</span>
                              <span className="shared-search-where">{result.dir || status.label}</span>
                            </button>
                          ) : (
                            <button
                              className={'shared-file shared-search-hit' + (result.path === selectedPath ? ' is-selected' : '') + (editorKind(result.ext) ? '' : ' is-foreign')}
                              aria-label={`Ouvrir ${result.path}`}
                              onClick={() => onOpen(result.path)}
                            >
                              <span className="shared-file-name">{result.name}</span>
                              <span className="shared-search-where">{result.dir || status.label}</span>
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : renderDir(root, 0)}
            {status.configurable && !showConnect && (
              <button
                className="ghost shared-change"
                disabled={busy}
                onClick={() => {
                  if (!canConnect) return void choose();
                  setAddress(status.address ?? '');
                  setAccount(status.account ?? '');
                  setShowConnect(true);
                }}
              >
                Changer de dossier…
              </button>
            )}
            {showConnect && (
              <>
                {connectForm}
                <div className="shared-project-link">
                  <button className="ghost" disabled={busy} onClick={() => void choose()}>Choisir un dossier déjà monté…</button>
                  <button className="ghost" onClick={() => setShowConnect(false)}>Annuler</button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function FileRow({ entry, selected, disabled, onOpen, onDelete }: { entry: SharedEntry; selected: boolean; disabled: boolean; onOpen: (path: string) => void; onDelete: (entry: SharedEntry) => void }) {
  const badges = badgesFor(entry);
  // Grisé : WorkLogs ne l'ouvre pas lui-même. Un PDF se lit sur place, sans être modifiable.
  const opens = Boolean(editorKind(entry.ext)) || entry.ext === 'pdf';
  return (
    <li className="shared-file-row">
      <button
        className={'shared-file' + (selected ? ' is-selected' : '') + (opens && !entry.unavailable ? '' : ' is-foreign')}
        aria-current={selected ? 'true' : undefined}
        aria-label={`Ouvrir ${entry.name}${badges.length ? ` — ${badges.map((badge) => badge.label).join(', ')}` : ''}${entry.unavailable ? ' — pas gardé sur cet ordinateur, attends le retour du partage' : ''}`}
        title={entry.unavailable ? 'Hors ligne : ce fichier n’est pas gardé sur cet ordinateur.' : undefined}
        disabled={entry.unavailable}
        onClick={() => onOpen(entry.path)}
      >
        <span className="shared-file-name">{entry.name}</span>
        {badges.map((badge) => <span key={badge.icon} className="shared-badge" title={badge.label} aria-hidden="true">{badge.icon}</span>)}
      </button>
      <button
        className="ghost shared-file-delete"
        disabled={disabled || entry.unavailable}
        aria-label={`Supprimer ${entry.name} du partage`}
        title="Supprimer ce fichier du dossier partagé"
        onClick={() => onDelete(entry)}
      >
        ✕
      </button>
    </li>
  );
}
