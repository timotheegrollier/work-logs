import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './styles.css';
import { api, emptyDocument, taskViewMatch, todayISO, type AppState, type Entry, type GoogleStatus, type GoogleSyncStatus, type TaskView } from './lib';
import { startWebSync, subscribeWebSync } from './store/sync-web';
import { EntryList } from './components/EntryList';
import { ProcedureList } from './components/ProcedureList';
import { EntryEditor } from './components/EntryEditor';
import { Logo } from './components/Logo';
import { UpdateBar } from './components/UpdateBar';
import { TaskBoard } from './components/TaskBoard';
import { ProjectBar } from './components/ProjectBar';
import { CategoryBar } from './components/CategoryBar';
import { categoryDescendants, UNCATEGORIZED } from './categories';
import { GoogleDrive } from './components/GoogleDrive';
import { AiSettings } from './components/AiSettings';
import { AccountMenu } from './components/AccountMenu';
import { GoogleDocuments } from './components/GoogleDocuments';
import { ColumnResizer } from './components/ColumnResizer';
import { SharedFolder } from './components/SharedFolder';
import { SharedFileEditor } from './components/SharedFileEditor';
import { SharedSettings } from './components/SharedSettings';
import { RelaySettings } from './components/RelaySettings';
import { readRelay } from './relay-settings';
import { hasLeaveGuard, requestLeave } from './shared-leave';
import { flushPendingSaves, hasPendingSaves } from './autosave';

const isPwa = import.meta.env.VITE_PWA === '1';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState(readProject);
  const [categoryId, setCategoryId] = useState('');
  const [groupedCategories, setGroupedCategories] = useState(false);
  const currentFilters = useRef({ query, projectId, categoryId });
  currentFilters.current = { query, projectId, categoryId };
  const navigationSequence = useRef(0);
  // L'entrée ouverte survit au rechargement et au redémarrage : on retrouve le
  // document qu'on éditait, au lieu de retomber sur « le plus récent ». C'est
  // aussi ce qui rend les recettes déterministes — elles pariaient jusqu'ici sur
  // l'ordre des entrées après un rechargement.
  const [selectedId, setSelectedId] = useState<string | null>(readSelected);
  // Fichier du dossier partagé ouvert au centre, à la place de l'entrée (§25).
  // Desktop et dev seulement : la PWA n'atteint pas un partage SMB.
  // PWA : le dossier partagé passe par le relais du bureau, s'il est réglé.
  const [sharedPath, setSharedPath] = useState<string | null>(() => (isPwa && !readRelay() ? null : readSharedPath()));
  const [sharedRevision, setSharedRevision] = useState(0);
  const bumpShared = useCallback(() => setSharedRevision((n) => n + 1), []);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [freshEntry, setFreshEntry] = useState(false);
  const [procedureEdit, setProcedureEdit] = useState({ id: '', sequence: 0 });
  const [showDocumentTasks, setShowDocumentTasks] = useState(false);
  // Vue rapide de la colonne Tâches (en retard, en cours…) : un filtre d'affichage,
  // pas un mode — non retenu au redémarrage, levé d'un clic sur « Toutes ».
  const [taskView, setTaskView] = useState<TaskView | null>(null);
  const documentRef = useRef<string | undefined>(undefined);
  documentRef.current = entry?.google_sync?.document_id;
  const [theme, setTheme] = useState(readTheme);
  const [colLeft, setColLeft] = useState(readColLeft);
  const [colRight, setColRight] = useState(readColRight);
  const [colProcedures, setColProcedures] = useState(readColProcedures);
  const [showLeft, setShowLeft] = useState(() => readPanel('worklogs-show-left'));
  const [showCenter, setShowCenter] = useState(() => readPanel('worklogs-show-center'));
  const [showRight, setShowRight] = useState(() => readPanel('worklogs-show-right'));
  // Procédures : masqué par défaut pour ne pas rétrécir l'éditeur d'office ;
  // un clic suffit, l'état est retenu comme les autres panneaux.
  const [showProcedures, setShowProcedures] = useState(() => readPanel('worklogs-show-procedures', false));
  const [showSettings, setShowSettings] = useState(false);
  const [showDocuments, setShowDocuments] = useState(false);
  // Compte Google au niveau de l'app : le menu de l'en-tête le montre partout.
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const refreshGoogle = useCallback(async () => {
    try { setGoogle(await api.googleStatus()); } catch { setGoogle(null); }
  }, []);
  useEffect(() => {
    void refreshGoogle();
    const onFocus = () => void refreshGoogle();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshGoogle]);
  // Desktop : la connexion se termine dans le navigateur système, on suit son issue.
  useEffect(() => {
    if (!google?.pending) return;
    const timer = setInterval(() => void refreshGoogle(), 1500);
    return () => clearInterval(timer);
  }, [google?.pending, refreshGoogle]);
  // Synchro Drive : la PWA la porte elle-même, le desktop la fait côté serveur.
  const [sync, setSync] = useState<GoogleSyncStatus | null>(null);
  const syncRevision = useRef<number | null>(null);
  // Retour de Google en échec (PWA) : à part d'`error`, que chaque `reload` efface.
  const [loginError, setLoginError] = useState('');
  useEffect(() => {
    if (!isPwa) return;
    const stop = startWebSync(() => void refreshGoogle(), setLoginError);
    const unsubscribe = subscribeWebSync(setSync);
    return () => { unsubscribe(); stop(); };
  }, [refreshGoogle]);
  useEffect(() => {
    if (isPwa || !google?.connected) return;
    let alive = true;
    const poll = () => void api.googleSync().then((next) => { if (alive) setSync(next); }).catch(() => {});
    poll();
    const timer = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [google?.connected]);
  const googleAction = (action: () => Promise<GoogleStatus>) => async () => {
    setError('');
    try { setGoogle(await action()); } catch (e) { setError((e as Error).message); }
  };
  const settingsRef = useRef<HTMLDialogElement>(null);
  const selectedRef = useRef<string | null>(null);
  const reloadSequence = useRef(0);
  selectedRef.current = selectedId;

  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId);
    else localStorage.removeItem(SELECTED_KEY);
  }, [selectedId]);

  useEffect(() => {
    localStorage.setItem(PROJECT_KEY, projectId);
  }, [projectId]);

  useEffect(() => {
    if (sharedPath) localStorage.setItem(SHARED_KEY, sharedPath);
    else localStorage.removeItem(SHARED_KEY);
  }, [sharedPath]);

  /**
   * Un geste vers une entrée referme le fichier partagé. Avec un brouillon non
   * envoyé, l'éditeur demande d'abord : Envoyer · Garder le brouillon ici · Annuler.
   */
  const selectEntry = useCallback((id: string | null) => {
    // Aucun fichier partagé ouvert : sélection immédiate, comme avant (les gestes
    // qui enchaînent sur l'entrée — joindre un fichier… — ne doivent pas attendre).
    if (!hasLeaveGuard()) {
      setSharedPath(null);
      setSelectedId(id);
      revealEditor();
      return;
    }
    void requestLeave().then((ok) => {
      if (!ok) return;
      setSharedPath(null);
      setSelectedId(id);
      revealEditor();
    });
  }, []);
  const openShared = useCallback(async (path: string) => {
    if (!(await requestLeave())) return;
    await flushPendingSaves().catch(() => {});
    setSharedPath(path);
    setShowCenter(true);
    revealEditor();
  }, []);

  /**
   * Ouvre une entrée au centre, en suivant son projet si `project` est donné.
   * Le fichier du partage n'est quitté qu'une fois la garde passée, et le
   * filtre projet ne change qu'après : « Annuler » laisse tout en place.
   */
  const openEntry = useCallback(async (id: string, project: string | undefined) => {
    const navigation = ++navigationSequence.current;
    if (!(await requestLeave())) return false;
    await flushPendingSaves().catch(() => {});
    if (navigation !== navigationSequence.current) return false;
    setCategoryId('');
    if (project !== undefined && project !== projectId) setProjectId(project);
    setFreshEntry(false);
    setShowCenter(true);
    setSharedPath(null);
    selectedRef.current = id;
    setSelectedId(id);
    revealEditor();
    return true;
  }, [projectId]);

  /**
   * Le centre suit le filtre : changer de projet referme ce qui appartient au
   * précédent — un fichier du partage (il n'est plus dans l'arbre affiché) et
   * l'entrée ouverte (elle n'est plus dans le journal). Sans ça, les listes
   * changeaient sous un document resté là, et les deux se contredisaient.
   * Un brouillon de fichier non envoyé pose sa question d'abord ; « Annuler »
   * laisse le projet où il est.
   */
  const switchProject = useCallback(async (next: string) => {
    const navigation = ++navigationSequence.current;
    if (next === projectId) return;
    if (!(await requestLeave())) return;
    await flushPendingSaves().catch(() => {});
    if (navigation !== navigationSequence.current) return;
    // Un fichier du partage est toujours rattaché à un projet par son dossier :
    // en changer le referme. « Tout » garde le partage entier, donc le fichier.
    if (next && sharedPath) setSharedPath(null);
    const openSummary = state?.entries.find((candidate) => candidate.id === selectedRef.current);
    const openProject = openSummary?.project_id
      ?? (entry && entry.id === selectedRef.current ? entry.project_id : null);
    // « Tout » affiche aussi l'entrée du projet quitté : elle peut rester.
    if (next && openProject !== next) {
      // Une lecture d'état déjà en vol répondrait avec l'ancien filtre.
      reloadSequence.current += 1;
      selectedRef.current = null;
      setSelectedId(null);
      setEntry(null);
      setFreshEntry(false);
      setShowDocumentTasks(false);
      setProcedureEdit({ id: '', sequence: 0 });
    }
    setProjectId(next);
    setCategoryId('');
  }, [entry, projectId, sharedPath, state?.entries]);

  useEffect(() => {
    const unsubscribe = window.worklogsDesktop?.onBeforeClose(flushPendingSaves);
    // Le garde se contentait d'un preventDefault() : il demandait confirmation
    // sans jamais **envoyer** ce qui était en attente. Recharger ou fermer
    // perdait donc les frappes des dernières centaines de millisecondes.
    // On déclenche l'écriture tout de suite — la requête part avant que la page
    // ne disparaisse — et on retarde la sortie le temps qu'elle aboutisse.
    const flushNow = () => { if (hasPendingSaves()) void flushPendingSaves(); };
    const guard = (event: BeforeUnloadEvent) => {
      if (!hasPendingSaves()) return;
      flushNow();
      event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', flushNow);
    return () => {
      unsubscribe?.();
      window.removeEventListener('beforeunload', guard);
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', flushNow);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('worklogs-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--col-left', `${colLeft}px`);
    document.documentElement.style.setProperty('--col-right', `${colRight}px`);
    localStorage.setItem('worklogs-col-left', String(colLeft));
    localStorage.setItem('worklogs-col-right', String(colRight));
    document.documentElement.style.setProperty('--col-procedures', `${colProcedures}px`);
    localStorage.setItem(COL_PROC_KEY, String(colProcedures));
  }, [colLeft, colRight, colProcedures]);

  useEffect(() => {
    localStorage.setItem('worklogs-show-left', showLeft ? '1' : '0');
  }, [showLeft]);

  useEffect(() => {
    localStorage.setItem('worklogs-show-center', showCenter ? '1' : '0');
  }, [showCenter]);

  useEffect(() => {
    localStorage.setItem('worklogs-show-right', showRight ? '1' : '0');
  }, [showRight]);

  useEffect(() => {
    localStorage.setItem('worklogs-show-procedures', showProcedures ? '1' : '0');
  }, [showProcedures]);

  // Une procédure affichée au centre montre d'où elle vient : la colonne Procédures se
  // déplie, une fois par procédure (la refermer ensuite tient). Archivée, elle n'y est pas.
  const openProcedureId = showCenter && !sharedPath && entry?.kind === 'procedure' && !entry.archived ? entry.id : null;
  useEffect(() => {
    if (openProcedureId) setShowProcedures(true);
  }, [openProcedureId]);

  // La recherche attend une pause de frappe avant d'interroger l'API.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const latestReload = useRef<() => Promise<void>>(async () => {});
  const reload = useCallback(async () => {
    const isCurrent = () => currentFilters.current.query === query && currentFilters.current.projectId === projectId && currentFilters.current.categoryId === categoryId;
    // Une mutation commencée sous l'ancien filtre doit encore rafraîchir l'écran,
    // en relisant le filtre courant plutôt qu'en perdant sa notification.
    if (!isCurrent()) return latestReload.current();
    const sequence = ++reloadSequence.current;
    try {
      const next = await api.state(query, projectId, categoryId);
      if (sequence !== reloadSequence.current || !isCurrent()) return;
      setState(next);
      setError('');
      // Une tâche terminée peut archiver l'entrée actuellement ouverte :
      // actualiser seulement ses métadonnées évite d'écraser un brouillon local.
      const selectedSummary = next.entries.find((e) => e.id === selectedRef.current);
      if (selectedSummary) {
        setEntry((current) => current && current.id === selectedSummary.id
          ? { ...current, archived: selectedSummary.archived, project_id: selectedSummary.project_id, category_id: selectedSummary.category_id, updated_at: selectedSummary.updated_at,
              ...(selectedSummary.kind === 'procedure' ? { attachments: next.procedure_attachments.filter((file) => file.entry_id === current.id) } : {}) }
          : current);
      }
      // Rien de sélectionné (premier chargement, changement de projet, entrée supprimée) :
      // on ouvre la plus récente du journal, sinon une procédure — jamais une archive,
      // qui ne s'ouvre que si on va la chercher dans les Archives.
      const stillThere = next.entries.some((e) => e.id === selectedRef.current || (!categoryId && documentRef.current && e.google_document_id === documentRef.current));
      const active = next.entries.filter((e) => !e.archived);
      if (!stillThere) setSelectedId((active.find((e) => e.kind !== 'procedure') ?? active[0])?.id ?? null);
    } catch {
      if (!isCurrent() || sequence !== reloadSequence.current) return;
      setError('API injoignable. Lance `npm run dev` dans /home/timo/WorkLogs.');
    }
  }, [query, projectId, categoryId]);
  latestReload.current = reload;

  const switchCategory = async (next: string) => {
    if (currentFilters.current.projectId !== projectId || currentFilters.current.categoryId !== categoryId) return;
    const navigation = ++navigationSequence.current;
    if (next === categoryId || !(await requestLeave())) return;
    await flushPendingSaves();
    if (navigation !== navigationSequence.current) return;
    reloadSequence.current += 1;
    const selected = state?.entries.find((row) => row.id === selectedRef.current) ?? entry;
    const matches = !next || (next === UNCATEGORIZED ? !selected?.category_id : categoryDescendants(state?.categories ?? [], next).has(selected?.category_id || ''));
    if (!matches) {
      selectedRef.current = null;
      setSelectedId(null);
      setEntry(null);
      setFreshEntry(false);
    }
    setCategoryId(next);
  };

  // Des changements sont arrivés de l'autre appareil : l'écran se met à jour seul.
  useEffect(() => {
    if (!sync) return;
    if (syncRevision.current !== null && sync.revision !== syncRevision.current) void reload();
    syncRevision.current = sync.revision;
  }, [sync, reload]);
  // L'accès au relais est revenu du compte Google : la section « Dossier partagé » apparaît.
  const relayRevision = sync?.relayRevision ?? 0;
  useEffect(() => {
    if (relayRevision) bumpShared();
  }, [relayRevision, bumpShared]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (state && projectId && !state.projects.some((project) => project.id === projectId)) {
      setProjectId('');
      setCategoryId('');
    }
  }, [state, projectId]);

  useEffect(() => {
    if (state && categoryId && categoryId !== UNCATEGORIZED && !(state.categories ?? []).some((category) => category.id === categoryId && (!projectId || category.project_id === projectId))) setCategoryId('');
  }, [state, categoryId, projectId]);

  useEffect(() => {
    if (!selectedId) {
      setEntry(null);
      return;
    }
    let alive = true;
    api
      .entry(selectedId)
      .then((loaded) => alive && setEntry(loaded))
      .catch(() => alive && setEntry(null));
    return () => {
      alive = false;
    };
  }, [selectedId]);

  const createEntry = async (rich = false) => {
    // Un fichier partagé ouvert avec un brouillon non envoyé : la question d'abord.
    if (!(await requestLeave())) return;
    const created = await api.createEntry({
      title: 'Sans titre',
      entry_date: todayISO(),
      project_id: projectId || state?.categories?.find((category) => category.id === categoryId)?.project_id || null,
      category_id: categoryId && categoryId !== UNCATEGORIZED ? categoryId : null,
      ...(rich ? { content_json: emptyDocument() } : {}),
    });
    setSearch('');
    setFreshEntry(true);
    setShowCenter(true);
    setSharedPath(null);
    setSelectedId(created.id);
    setEntry({ ...created, attachments: [] });
    revealEditor();
    reload();
  };

  // Les procédures vivent dans leur propre sidebar, jamais dans le journal ;
  // archivées, elles restent dans les archives du journal pour être restaurées.
  const journalEntries = (state?.entries ?? []).filter((e) => e.kind !== 'procedure' || e.archived);
  const createProcedure = async () => {
    if (!(await requestLeave())) return;
    const created = await api.createEntry({
      title: 'Sans titre',
      entry_date: todayISO(),
      project_id: projectId || state?.categories?.find((category) => category.id === categoryId)?.project_id || null,
      category_id: categoryId && categoryId !== UNCATEGORIZED ? categoryId : null,
      kind: 'procedure',
      content_json: emptyDocument(),
    });
    setSearch('');
    setFreshEntry(true);
    setShowCenter(true);
    setSharedPath(null);
    setSelectedId(created.id);
    setEntry({ ...created, attachments: [] });
    revealEditor();
    reload();
  };

  // Même geste dans les deux backends : le distant renvoie le JSON du serveur,
  // le local construit le blob depuis IndexedDB (PWA hors-ligne comprise).
  const exportJson = async () => {
    try {
      const { filename, blob } = await api.exportBackup();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const siblingTabs = (entry?.google_sync?.tabs || state?.entries.filter(e => e.google_document_id === entry?.google_sync?.document_id && e.google_document_id) || [])
    .map(tab => ({ ...tab, ...state?.entries.find(e => e.id === tab.id) }))
    .sort((a, b) => (a.google_tab_order ?? 0) - (b.google_tab_order ?? 0));
  const isGoogleDocument = Boolean(entry?.google_sync);
  // Session Google active (pas expirée) : la synchro automatique tourne.
  const autoSynced = Boolean(google?.connected && !google.expired);

  const stats = state?.stats;

  // Les compteurs de l'en-tête portent sur toute la base. Si le projet filtré ou la
  // recherche en cachent une partie, on les lève : le clic montre ce que le chiffre annonce.
  const showTasks = (view: TaskView, total: number) => {
    const today = todayISO();
    const match = taskViewMatch(view);
    if ((state?.tasks ?? []).filter((task) => match(task, today)).length < total) {
      setProjectId('');
      setCategoryId('');
      setSearch('');
    }
    setTaskView(view);
    setShowRight(true);
    if (isGoogleDocument) setShowDocumentTasks(true);
  };

  const openDocument = useCallback((entryId: string, knownProject?: string | null) => {
    const summary = state?.entries.find((candidate) => candidate.id === entryId)
      ?? state?.tasks.flatMap((task) => task.documents ?? []).find((candidate) => candidate.id === entryId);
    // Sans résumé (document inconnu de l'état filtré), le projet que l'appelant connaît
    // (« Trouver la doc ») ; sinon on ne change pas le projet.
    const project = summary ? summary.project_id : knownProject;
    void openEntry(entryId, project === undefined ? undefined : (project ?? ''));
  }, [openEntry, state]);

  // Procédure rédigée par l'IA depuis une entrée ou une tâche : ouverte au centre,
  // en lecture. Elle naît dans le projet de sa source, donc dans le filtre ; une
  // recherche en cours la masquerait : on l'efface, ce qui relit l'état (relire
  // aussi avec l'ancienne recherche pourrait répondre d'abord et la refermer).
  const openCreatedProcedure = useCallback((procedure: Entry) => {
    setCategoryId('');
    setSearch('');
    setFreshEntry(false);
    setShowCenter(true);
    selectedRef.current = procedure.id;
    selectEntry(procedure.id);
    if (query) setQuery('');
    else void reload();
  }, [query, reload, selectEntry]);

  // Ouverture d'un document Drive : le filtre suit le projet du document, comme
  // une carte de tâche — sinon le journal d'un projet montrait le document d'un autre.
  const openDriveEntry = useCallback((opened: Entry) => {
    const project = opened.project_id ?? '';
    // La recherche est levée tout de suite : elle pourrait masquer le document
    // dans l'état relu, même avant que la garde de sortie ne réponde.
    setSearch(''); setQuery('');
    void openEntry(opened.id, project).then((allowed) => {
      if (!allowed) return;
      setEntry(opened);
      const sequence = ++reloadSequence.current;
      void api.state('', project).then(next => { if (sequence === reloadSequence.current) setState(next); }).catch(() => {});
    });
  }, [openEntry]);

  useEffect(() => {
    if (!showSettings) return;
    const dialog = settingsRef.current;
    if (!dialog || dialog.open) return;
    try { dialog.showModal(); }
    catch { dialog.setAttribute('open', ''); }
  }, [showSettings]);

  return (
    <div className="app">
      <UpdateBar />
      <header className="head no-print">
        <h1 className="logo">
          <Logo />
          Work<span>Logs</span>
          <button
            className="version"
            type="button"
            title="Vérifier les mises à jour"
            onClick={() => void window.worklogsDesktop?.checkUpdatesNow?.()}
          >
            {__WORKLOGS_VERSION__}
          </button>
        </h1>
        <input
          className="search"
          type="search"
          aria-label="Rechercher"
          placeholder="Rechercher dans tout…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="grow" />
        {stats && (
          <p className="stats">
            <b>{stats.entriesThisWeek}</b> entrée(s) cette semaine · <b>{stats.tasks.todo}</b> à
            faire
            {stats.tasks.doing > 0 && (
              <>
                {' · '}
                <button className="stat-link" type="button" title="Voir les tâches en cours" onClick={() => showTasks('doing', stats.tasks.doing)}>
                  <b>{stats.tasks.doing}</b> en cours
                </button>
              </>
            )}
            {stats.overdue > 0 && (
              <>
                {' · '}
                <button className="stat-link" type="button" title="Voir les tâches en retard" onClick={() => showTasks('late', stats.overdue)}>
                  <b className="late">{stats.overdue}</b> en retard
                </button>
              </>
            )}
          </p>
        )}
        <div className="panel-toggles no-print" role="group" aria-label="Panneaux latéraux">
          <button
            type="button"
            className={'panel-toggle' + (showLeft ? ' is-on' : '')}
            aria-pressed={showLeft}
            aria-controls="workspace-journal"
            title={showLeft ? 'Masquer le journal' : 'Afficher le journal'}
            onClick={() => setShowLeft((v) => !v)}
          >
            Journal
          </button>
          <button
            type="button"
            className={'panel-toggle' + (showCenter ? ' is-on' : '')}
            aria-pressed={showCenter}
            aria-controls="workspace-editor"
            title={showCenter ? 'Masquer l’écriture' : 'Afficher l’écriture'}
            onClick={() => setShowCenter((v) => !v)}
          >
            Écriture
          </button>
          <button
            type="button"
            className={'panel-toggle' + (showRight ? ' is-on' : '')}
            aria-pressed={showRight}
            aria-controls="workspace-tasks"
            title={showRight ? 'Masquer les tâches' : 'Afficher les tâches'}
            onClick={() => setShowRight((v) => !v)}
          >
            Tâches
          </button>
          <button
            type="button"
            className={'panel-toggle' + (showProcedures ? ' is-on' : '')}
            aria-pressed={showProcedures}
            aria-controls="workspace-procedures"
            title={showProcedures ? 'Masquer les procédures' : 'Afficher les procédures'}
            onClick={() => setShowProcedures((v) => !v)}
          >
            Procédures
          </button>
        </div>
        <button
          className="ghost theme-btn"
          aria-label="Changer de thème"
          title={theme === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre'}
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        {/* Connecté à Google, la synchro automatique garde déjà une copie à jour
            sur Drive : l'export manuel n'a plus sa place dans l'en-tête. */}
        {!autoSynced && (
          <button className="ghost export-btn" type="button" aria-label="Exporter" title="Télécharger toute la base en JSON" onClick={() => void exportJson()}>
            <span className="export-icon" aria-hidden="true">⤓</span>
            <span className="export-label">Exporter</span>
          </button>
        )}
        <AccountMenu
          status={google}
          onSettings={() => setShowSettings(true)}
          onDocuments={() => setShowDocuments(true)}
          onConnect={googleAction(api.connectGoogle)}
          onSwitch={googleAction(api.switchGoogleAccount)}
          onDisconnect={googleAction(api.disconnectGoogle)}
          sync={sync}
          onSyncNow={() => void api.syncGoogleNow().then(setSync).catch((e) => setError((e as Error).message))}
        />
      </header>

      {(error || loginError) && <p className="error banner no-print">{error || loginError}</p>}

      {/* Projets hors de la sidebar : le filtre et la gestion restent accessibles
          même quand le journal est replié, sur mobile comme sur desktop. */}
      <div className="project-strip no-print">
        <ProjectBar
          projects={state?.projects ?? []}
          selected={projectId}
          onSelect={(id) => void switchProject(id)}
          onChanged={reload}
        />
      </div>

      <CategoryBar
        key={projectId}
        categories={state?.categories ?? []}
        projects={state?.projects ?? []}
        projectId={projectId}
        selected={categoryId}
        grouped={groupedCategories}
        onSelect={(id) => void switchCategory(id).catch((e) => setError((e as Error).message))}
        onGrouped={setGroupedCategories}
        onChanged={reload}
      />

      {isGoogleDocument && <div className="workspace-switch no-print"><span>Document Google · {siblingTabs.length} onglet{siblingTabs.length > 1 ? 's' : ''}</span>
        <button aria-expanded={showDocumentTasks} aria-controls="workspace-tasks" onClick={() => setShowDocumentTasks(!showDocumentTasks)}>{showDocumentTasks ? 'Masquer les tâches' : 'Afficher les tâches'}</button>
      </div>}
      <div className={'columns' + (isGoogleDocument ? ' is-document' : '') + (showDocumentTasks ? ' with-tasks' : '') + (showLeft ? '' : ' hide-left') + (showCenter ? '' : ' hide-center') + (showRight ? '' : ' hide-right') + (showProcedures ? ' show-procedures' : '')}>
        <aside id="workspace-journal" className="left no-print">
          <EntryList
            categories={state?.categories ?? []}
            grouped={groupedCategories}
            entries={journalEntries}
            projects={state?.projects ?? []}
            selectedId={sharedPath ? null : selectedId}
            onSelect={(id) => {
              setFreshEntry(false);
              selectEntry(id);
              setShowCenter(true);
            }}
            onCreate={() => void createEntry()}
            onCreateDocument={() => void createEntry(true)}
            searching={query !== ''}
          />
        </aside>

        <ColumnResizer side="left" panelId="workspace-journal" value={colLeft} onChange={setColLeft} />

        <main id="workspace-editor" className="center">
          {sharedPath ? (
            <SharedFileEditor
              key={sharedPath}
              path={sharedPath}
              projectId={projectId || null}
              onOpenPath={(path) => void openShared(path)}
              onChanged={bumpShared}
              onClose={() => setSharedPath(null)}
            />
          ) : entry && state ? (
            <EntryEditor
              categories={state.categories ?? []}
              key={entry.id}
              tabs={siblingTabs}
              onSelectTab={setSelectedId}
              entry={entry}
              projects={state.projects}
              linkedTasks={state.tasks
                .filter((task) => (task.documents ?? []).some((document) => document.id === entry.id))
                .map((task) => ({ id: task.id, title: task.title, status: task.status }))}
              tasks={state.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status }))}
              autoFocusTitle={freshEntry}
              editRequest={procedureEdit.id === entry.id ? procedureEdit.sequence : 0}
              onChanged={reload}
              onTaskCreated={reload}
              onProcedureCreated={openCreatedProcedure}
              onDeleted={() => {
                setSelectedId(null);
                reload();
              }}
            />
          ) : (
            <section className="editor placeholder">
              <p>Choisis une entrée à gauche, ou crée-en une nouvelle.</p>
            </section>
          )}
        </main>

        <ColumnResizer side="right" panelId="workspace-tasks" value={colRight} onChange={setColRight} />

        <aside id="workspace-tasks" className="right no-print">
          <TaskBoard
            categories={state?.categories ?? []}
            categoryId={categoryId}
            grouped={groupedCategories}
            tasks={state?.tasks ?? []}
            entries={state?.entries ?? []}
            projectId={projectId}
            projects={state?.projects ?? []}
            view={taskView}
            onView={setTaskView}
            onOpenDocument={openDocument}
            onOpenShared={(path) => void openShared(path)}
            onProcedureCreated={openCreatedProcedure}
            onChanged={reload}
          />
        </aside>

        <ColumnResizer
          side="right"
          area="procedures"
          panelId="workspace-procedures"
          label="Redimensionner la colonne des procédures"
          min={PROC_MIN}
          value={colProcedures}
          onChange={setColProcedures}
        />

        <aside id="workspace-procedures" className="procedures-bar no-print">
          <ProcedureList
            categories={state?.categories ?? []}
            grouped={groupedCategories}
            entries={state?.entries ?? []}
            attachments={state?.procedure_attachments ?? []}
            projects={state?.projects ?? []}
            projectId={projectId}
            selectedId={sharedPath ? null : selectedId}
            onSelect={(id) => {
              setFreshEntry(false);
              selectEntry(id);
              setShowCenter(true);
            }}
            onEdit={(id) => {
              setFreshEntry(false);
              selectEntry(id);
              setShowCenter(true);
              setProcedureEdit((current) => ({ id, sequence: current.sequence + 1 }));
            }}
            onCreate={() => void createProcedure()}
            onChanged={reload}
            onDeleted={(id) => {
              if (selectedRef.current === id) {
                selectedRef.current = null;
                setSelectedId(null);
                setEntry(null);
              }
              void reload();
            }}
          />
          {/* PWA : absente tant que le relais n'est pas réglé (le statut dit « indisponible »). */}
          <SharedFolder
            active={showProcedures}
            projectId={projectId}
            projects={state?.projects ?? []}
            procedures={(state?.entries ?? []).filter((entry) => entry.kind === 'procedure' && !entry.archived).map((entry) => ({ id: entry.id, title: entry.title }))}
            selectedPath={sharedPath}
            revision={sharedRevision}
            onOpen={(path) => void openShared(path)}
            onDeleted={(path) => {
              // Un fichier, ou un dossier et tout ce qu'il contenait.
              if (sharedPath && (sharedPath === path || sharedPath.startsWith(path + '/'))) setSharedPath(null);
              bumpShared();
            }}
            onRenamed={(from, to) => {
              // Le fichier ouvert suit son dossier (rien n'y était en route : le renommage aurait été refusé).
              if (sharedPath?.startsWith(from + '/')) setSharedPath(to + sharedPath.slice(from.length));
              bumpShared();
            }}
            onProjectsChanged={reload}
            onLocalChanged={() => void reload()}
          />
        </aside>
      </div>
      {showSettings && createPortal((
        <dialog
          className="settings-dialog"
          aria-label="Paramètres"
          aria-modal="true"
          ref={settingsRef}
          onCancel={(event) => {
            event.preventDefault();
            setShowSettings(false);
            void refreshGoogle();
          }}
        >
          <div className="settings-dialog-heading">
            <h2>Paramètres</h2>
            <button className="ghost" type="button" onClick={() => { setShowSettings(false); void refreshGoogle(); }}>
              Fermer
            </button>
          </div>
          <div className="settings-content">
            <GoogleDrive onRestored={reload} onOpen={openDriveEntry} onDocuments={() => { setShowSettings(false); setShowDocuments(true); }} />
            <AiSettings projects={state?.projects ?? []} />
            {isPwa && <RelaySettings onChange={() => setSharedRevision((n) => n + 1)} />}
            <SharedSettings key={`nom-${sharedRevision}`} />
            {/* Largeurs au pixel près : les poignées entre les colonnes font le
                geste courant, ce réglage fin n'a pas besoin de l'en-tête. */}
            <section className="display-settings" aria-label="Affichage">
              <h3>Affichage</h3>
              <p className="ai-hint">Largeur des colonnes latérales, en pixels. Les poignées entre les colonnes font la même chose à la souris.</p>
              <div className="col-widths">
                <label className="col-width-control">
                  Journal
                  <input
                    id="col-left-width"
                    type="number"
                    min={120}
                    max={600}
                    value={colLeft}
                    onChange={(e) => setColLeft(Math.max(120, Math.min(600, Number(e.target.value) || 290)))}
                    aria-label="Largeur de la colonne de gauche (px)"
                  />
                  <span aria-hidden="true">px</span>
                </label>
                <label className="col-width-control">
                  Tâches
                  <input
                    id="col-right-width"
                    type="number"
                    min={120}
                    max={600}
                    value={colRight}
                    onChange={(e) => setColRight(Math.max(120, Math.min(600, Number(e.target.value) || 320)))}
                    aria-label="Largeur de la colonne de droite (px)"
                  />
                  <span aria-hidden="true">px</span>
                </label>
                <label className="col-width-control">
                  Procédures
                  <input
                    id="col-procedures-width"
                    type="number"
                    min={PROC_MIN}
                    max={600}
                    value={colProcedures}
                    onChange={(e) => setColProcedures(Math.max(PROC_MIN, Math.min(600, Number(e.target.value) || 320)))}
                    aria-label="Largeur de la colonne des procédures (px)"
                  />
                  <span aria-hidden="true">px</span>
                </label>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setColLeft(290);
                    setColRight(320);
                    setColProcedures(320);
                  }}
                  aria-label="Largeurs par défaut"
                >
                  Largeurs par défaut
                </button>
              </div>
            </section>
          </div>
          {/* La pastille de version de l'en-tête est masquée dès 1180 px
              (mobile, tablette, PWA étroite) : le numéro reste accessible
              ici, en pied fixe du dialogue. */}
          <p className="settings-version">WorkLogs {__WORKLOGS_VERSION__}</p>
        </dialog>
      ), document.body)}
      {showDocuments && (
        <GoogleDocuments
          projects={state?.projects ?? []}
          onClose={() => setShowDocuments(false)}
          onOpen={openDriveEntry}
          onChanged={reload}
        />
      )}
    </div>
  );
}

const SELECTED_KEY = 'worklogs-entry';
const PROJECT_KEY = 'worklogs-project';
const SHARED_KEY = 'worklogs-shared-path';

function readSharedPath() {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SHARED_KEY);
}

function readSelected() {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SELECTED_KEY);
}

function readProject() {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(PROJECT_KEY) || '';
}

function readTheme() {
  if (typeof localStorage === 'undefined') return 'dark';
  return localStorage.getItem('worklogs-theme') === 'light' ? 'light' : 'dark';
}

const COL_LS_KEY = 'worklogs-col-left';
const COL_RS_KEY = 'worklogs-col-right';
const COL_PROC_KEY = 'worklogs-col-procedures';
/** En dessous, les boutons d'une procédure ne tiennent plus sur leur ligne. */
const PROC_MIN = 260;

function readColLeft() {
  if (typeof localStorage === 'undefined') return 290;
  const v = Number(localStorage.getItem(COL_LS_KEY));
  return Number.isFinite(v) && v >= 120 && v <= 600 ? v : 290;
}

function readColRight() {
  if (typeof localStorage === 'undefined') return 320;
  const v = Number(localStorage.getItem(COL_RS_KEY));
  return Number.isFinite(v) && v >= 120 && v <= 600 ? v : 320;
}

function readColProcedures() {
  if (typeof localStorage === 'undefined') return 320;
  const v = Number(localStorage.getItem(COL_PROC_KEY));
  return Number.isFinite(v) && v >= PROC_MIN && v <= 600 ? v : 320;
}

/**
 * Cartes empilées (≤ 900 px) : ouvrir ou créer une entrée amène à la carte
 * Écriture, au lieu de la laisser sous un journal qu'il fallait faire défiler.
 * Sur desktop, les colonnes sont côte à côte : rien à faire.
 */
function revealEditor() {
  if (!window.matchMedia?.('(max-width: 900px)').matches) return;
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  // Après le rendu : la carte vient peut-être d'être réaffichée.
  requestAnimationFrame(() => document.getElementById('workspace-editor')?.scrollIntoView?.({ block: 'start', behavior }));
}

/** Panneau visible par défaut ; `'0'` enregistré le replie durablement. */
function readPanel(key: string, fallback = true) {
  if (typeof localStorage === 'undefined') return fallback;
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : stored !== '0';
}
