import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import './styles.css';
import { api, emptyDocument, taskViewMatch, todayISO, type AppState, type Entry, type GoogleStatus, type GoogleSyncStatus, type Task, type TaskView } from './lib';
import { startWebSync, subscribeWebSync } from './store/sync-web';
import { EntryList } from './components/EntryList';
import { ProcedureList } from './components/ProcedureList';
import { EntryEditor } from './components/EntryEditor';
import { Logo } from './components/Logo';
import { UpdateBar } from './components/UpdateBar';
import { TaskBoard } from './components/TaskBoard';
import { ProjectOverview } from './components/ProjectOverview';
import { ProjectBar } from './components/ProjectBar';
import { CategoryBar } from './components/CategoryBar';
import { categoryDescendants, UNCATEGORIZED } from './categories';
import { AiSettings } from './components/AiSettings';
import { AccountMenu } from './components/AccountMenu';
import { ColumnResizer } from './components/ColumnResizer';
import { SharedFolder } from './components/SharedFolder';
import { SharedSettings } from './components/SharedSettings';
import { RelaySettings } from './components/RelaySettings';
import { readRelay } from './relay-settings';
import { hasLeaveGuard, requestLeave } from './shared-leave';
import { flushPendingSaves, hasPendingSaves } from './autosave';

const isPwa = import.meta.env.VITE_PWA === '1';

// Chargés à la demande : le dossier partagé (Word, Excel, tableur) et Google Drive
// pèsent lourd et ne servent pas à chaque ouverture. Le service worker les
// précache quand même (`emit-sw.mjs`) : la PWA les a hors ligne.
const SharedFileEditor = lazy(() => import('./components/SharedFileEditor').then((m) => ({ default: m.SharedFileEditor })));
const GoogleDocuments = lazy(() => import('./components/GoogleDocuments').then((m) => ({ default: m.GoogleDocuments })));
const GoogleDrive = lazy(() => import('./components/GoogleDrive').then((m) => ({ default: m.GoogleDrive })));
const loading = <p className="empty">Chargement…</p>;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = usePersisted(PROJECT_KEY, (stored) => stored || '');
  const [categoryId, setCategoryId] = useState('');
  const [groupedCategories, setGroupedCategories] = useState(false);
  const currentFilters = useRef({ query, projectId, categoryId });
  currentFilters.current = { query, projectId, categoryId };
  const navigationSequence = useRef(0);
  // L'entrée ouverte survit au rechargement et au redémarrage : on retrouve le
  // document qu'on éditait, au lieu de retomber sur « le plus récent ». C'est
  // aussi ce qui rend les recettes déterministes — elles pariaient jusqu'ici sur
  // l'ordre des entrées après un rechargement.
  const [selectedId, setSelectedId] = usePersisted<string | null>(SELECTED_KEY, (stored) => stored, orForget);
  // Fichier du dossier partagé ouvert au centre, à la place de l'entrée (§25).
  // Desktop et dev seulement : la PWA n'atteint pas un partage SMB.
  // PWA : le dossier partagé passe par le relais du bureau, s'il est réglé.
  const [sharedPath, setSharedPath] = usePersisted<string | null>(SHARED_KEY, (stored) => (isPwa && !readRelay() ? null : stored), orForget);
  const [sharedRevision, setSharedRevision] = useState(0);
  const bumpShared = useCallback(() => setSharedRevision((n) => n + 1), []);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [freshEntry, setFreshEntry] = useState(false);
  const [procedureEdit, setProcedureEdit] = useState({ id: '', sequence: 0 });
  const [showDocumentTasks, setShowDocumentTasks] = useState(false);
  // Vue rapide de la colonne Tâches (en retard, en cours…) : un filtre d'affichage,
  // pas un mode — non retenu au redémarrage, levé d'un clic sur « Toutes ».
  const [taskView, setTaskView] = useState<TaskView | null>(null);
  // Vue d'ensemble des projets au centre, à la place de l'entrée : un affichage, pas un
  // mode (§33) — non retenu au redémarrage, refermé par tout ce qui ouvre autre chose.
  const [overview, setOverview] = useState(false);
  const documentRef = useRef<string | undefined>(undefined);
  documentRef.current = entry?.google_sync?.document_id;
  const [theme, setTheme] = usePersisted('worklogs-theme', (stored) => (stored === 'light' ? 'light' : 'dark'));
  const [colLeft, setColLeft] = usePersisted('worklogs-col-left', readWidth(290));
  const [colRight, setColRight] = usePersisted('worklogs-col-right', readWidth(320));
  const [colProcedures, setColProcedures] = usePersisted(COL_PROC_KEY, readWidth(320, PROC_MIN));
  const [showLeft, setShowLeft] = usePersisted('worklogs-show-left', readPanel(), writePanel);
  const [showCenter, setShowCenter] = usePersisted('worklogs-show-center', readPanel(), writePanel);
  const [showRight, setShowRight] = usePersisted('worklogs-show-right', readPanel(), writePanel);
  // Procédures : masqué par défaut pour ne pas rétrécir l'éditeur d'office ;
  // un clic suffit, l'état est retenu comme les autres panneaux.
  const [showProcedures, setShowProcedures] = usePersisted('worklogs-show-procedures', readPanel(false), writePanel);
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

  // Téléphone : un panneau à la fois, choisi par la barre du bas (§53). Le journal est
  // l'accueil ; chaque vue retrouve où on l'avait laissée. Non retenu au redémarrage.
  const phone = useSyncExternalStore(onPhoneChange, isPhone);
  const [phoneView, setPhoneView] = useState<PhoneView>('journal');
  const phoneViewRef = useRef(phoneView);
  phoneViewRef.current = phoneView;
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollMemory = useRef<Partial<Record<PhoneView, number>>>({});
  const goTo = useCallback((next: PhoneView, fromTop = false) => {
    const page = pageRef.current;
    if (next !== phoneViewRef.current) scrollMemory.current[phoneViewRef.current] = page?.scrollTop ?? 0;
    else if (fromTop) page?.scrollTo?.(0, 0);
    if (fromTop) scrollMemory.current[next] = 0;
    setPhoneView(next);
  }, []);
  useLayoutEffect(() => {
    if (phone) pageRef.current?.scrollTo?.(0, scrollMemory.current[phoneView] ?? 0);
  }, [phone, phoneView]);
  // Hors du journal, une marche dans l'historique : le retour d'Android ramène au
  // journal au lieu de fermer l'application. Rechargée hors du journal, la marche
  // d'avant ne mène plus à cette page : on l'oublie.
  useEffect(() => {
    if (history.state?.[VIEW_STEP]) history.replaceState(null, '');
    const back = () => { if (!history.state?.[VIEW_STEP]) goTo('journal'); };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [goTo]);
  useEffect(() => {
    if (!phone) return;
    const stepped = Boolean(history.state?.[VIEW_STEP]);
    if (phoneView !== 'journal' && !stepped) history.pushState({ [VIEW_STEP]: true }, '');
    if (phoneView === 'journal' && stepped) history.back();
  }, [phone, phoneView]);
  /**
   * Ouvrir ou créer amène à l'écriture : sur téléphone, sa vue, par le haut ; cartes
   * empilées (tablette), on y fait défiler ; colonnes côte à côte, rien à faire.
   */
  const revealEditor = useCallback(() => {
    if (isPhone()) return goTo('editor', true);
    if (!window.matchMedia?.('(max-width: 900px)').matches) return;
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    // Après le rendu : la carte vient peut-être d'être réaffichée.
    requestAnimationFrame(() => document.getElementById('workspace-editor')?.scrollIntoView?.({ block: 'start', behavior }));
  }, [goTo]);

  /**
   * Un geste vers une entrée referme le fichier partagé. Avec un brouillon non
   * envoyé, l'éditeur demande d'abord : Envoyer · Garder le brouillon ici · Annuler.
   */
  const selectEntry = useCallback((id: string | null) => {
    const navigation = ++navigationSequence.current;
    // Aucun fichier partagé ouvert : sélection immédiate, comme avant (les gestes
    // qui enchaînent sur l'entrée — joindre un fichier… — ne doivent pas attendre).
    if (!hasLeaveGuard()) {
      setSharedPath(null);
      setOverview(false);
      setSelectedId(id);
      revealEditor();
      return;
    }
    void requestLeave().then((ok) => {
      if (!ok || navigation !== navigationSequence.current) return;
      setSharedPath(null);
      setOverview(false);
      setSelectedId(id);
      revealEditor();
    });
  }, []);
  const openShared = useCallback(async (path: string) => {
    const navigation = ++navigationSequence.current;
    if (!(await requestLeave())) return;
    await flushPendingSaves().catch(() => {});
    if (navigation !== navigationSequence.current) return;
    setSharedPath(path);
    setOverview(false);
    setShowCenter(true);
    revealEditor();
  }, []);
  /**
   * La vue d'ensemble porte sur tout : projet, catégorie et recherche sont levés, comme
   * pour les compteurs de l'en-tête. Même garde de sortie qu'un fichier du partage.
   */
  const openOverview = useCallback(async () => {
    const navigation = ++navigationSequence.current;
    if (!(await requestLeave())) return;
    await flushPendingSaves().catch(() => {});
    if (navigation !== navigationSequence.current) return;
    setProjectId('');
    setCategoryId('');
    setSearch('');
    setOverview(true);
    setShowCenter(true);
    revealEditor();
  }, []);
  /** Un nœud de la vue d'ensemble mène à sa carte : le panneau Tâches, sans vue rapide, et le focus sur le titre. */
  const revealTask = useCallback((task: Task) => {
    setTaskView(null);
    setShowRight(true);
    if (isPhone()) goTo('tasks');
    requestAnimationFrame(() => document.getElementById('task-' + task.id)?.querySelector<HTMLElement>('.card-title')?.focus());
  }, [goTo]);

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
    setOverview(false);
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
    // La vue d'ensemble porte sur tous les projets : en choisir un, c'est aller y travailler.
    if (next) setOverview(false);
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
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--col-left', `${colLeft}px`);
    document.documentElement.style.setProperty('--col-right', `${colRight}px`);
    document.documentElement.style.setProperty('--col-procedures', `${colProcedures}px`);
  }, [colLeft, colRight, colProcedures]);

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

  // Les trois colonnes latérales sont mémoïsées : taper dans la recherche ne les
  // redessine pas. Leurs gestes sont donc des fonctions stables, d'où `useCallback`.
  const creationProjectId = projectId || state?.categories?.find((category) => category.id === categoryId)?.project_id || null;
  const creationCategoryId = categoryId && categoryId !== UNCATEGORIZED ? categoryId : null;
  const createEntry = useCallback(async (rich = false) => {
    // Un fichier partagé ouvert avec un brouillon non envoyé : la question d'abord.
    if (!(await requestLeave())) return;
    const created = await api.createEntry({
      title: 'Sans titre',
      entry_date: todayISO(),
      project_id: creationProjectId,
      category_id: creationCategoryId,
      ...(rich ? { content_json: emptyDocument() } : {}),
    });
    setSearch('');
    setFreshEntry(true);
    setShowCenter(true);
    setSharedPath(null);
    setOverview(false);
    setSelectedId(created.id);
    setEntry({ ...created, attachments: [] });
    revealEditor();
    reload();
  }, [creationProjectId, creationCategoryId, reload, setSelectedId, setSharedPath, setShowCenter]);
  const createDocument = useCallback(() => void createEntry(true), [createEntry]);

  // Les procédures vivent dans leur propre sidebar, jamais dans le journal ;
  // archivées, elles restent dans les archives du journal pour être restaurées.
  const journalEntries = useMemo(() => (state?.entries ?? []).filter((e) => e.kind !== 'procedure' || e.archived), [state?.entries]);
  const createProcedure = useCallback(async () => {
    if (!(await requestLeave())) return;
    const created = await api.createEntry({
      title: 'Sans titre',
      entry_date: todayISO(),
      project_id: creationProjectId,
      category_id: creationCategoryId,
      kind: 'procedure',
      content_json: emptyDocument(),
    });
    setSearch('');
    setFreshEntry(true);
    setShowCenter(true);
    setSharedPath(null);
    setOverview(false);
    setSelectedId(created.id);
    setEntry({ ...created, attachments: [] });
    revealEditor();
    reload();
  }, [creationProjectId, creationCategoryId, reload, setSelectedId, setSharedPath, setShowCenter]);
  // Ouvrir depuis le journal ou la colonne Procédures ; « Modifier » passe en Écrire.
  const selectFromList = useCallback((id: string) => {
    setFreshEntry(false);
    selectEntry(id);
    setShowCenter(true);
  }, [selectEntry, setShowCenter]);
  const editProcedure = useCallback((id: string) => {
    selectFromList(id);
    setProcedureEdit((current) => ({ id, sequence: current.sequence + 1 }));
  }, [selectFromList]);
  const procedureDeleted = useCallback((id: string) => {
    if (selectedRef.current === id) {
      selectedRef.current = null;
      setSelectedId(null);
      setEntry(null);
    }
    void reload();
  }, [reload, setSelectedId]);
  const sharedProcedures = useMemo(
    () => (state?.entries ?? []).filter((entry) => entry.kind === 'procedure' && !entry.archived).map((entry) => ({ id: entry.id, title: entry.title })),
    [state?.entries],
  );
  const sharedDeleted = useCallback((path: string) => {
    // Un fichier, ou un dossier et tout ce qu'il contenait.
    if (sharedPath && (sharedPath === path || sharedPath.startsWith(path + '/'))) setSharedPath(null);
    bumpShared();
  }, [bumpShared, setSharedPath, sharedPath]);
  const sharedRenamed = useCallback((from: string, to: string) => {
    // Le fichier ouvert suit son dossier (rien n'y était en route : le renommage aurait été refusé).
    if (sharedPath?.startsWith(from + '/')) setSharedPath(to + sharedPath.slice(from.length));
    bumpShared();
  }, [bumpShared, setSharedPath, sharedPath]);

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

  const googleSync = entry?.google_sync;
  const siblingTabs = useMemo(() => (googleSync?.tabs || state?.entries.filter(e => e.google_document_id === googleSync?.document_id && e.google_document_id) || [])
    .map(tab => ({ ...tab, ...state?.entries.find(e => e.id === tab.id) }))
    .sort((a, b) => (a.google_tab_order ?? 0) - (b.google_tab_order ?? 0)), [googleSync, state?.entries]);
  // La vue d'ensemble couvre la page Google : le panneau Tâches n'a pas à disparaître.
  const isGoogleDocument = Boolean(entry?.google_sync) && !overview;
  // Session Google active (pas expirée) : la synchro automatique tourne.
  const autoSynced = Boolean(google?.connected && !google.expired);
  // Mêmes interrupteurs partout ; sur téléphone, ils choisissent la vue au lieu de replier.
  const panels: { view: PhoneView; label: string; id: string; shown: boolean; toggle: Dispatch<SetStateAction<boolean>>; what: string; icon: ReactNode }[] = [
    { view: 'journal', label: 'Journal', id: 'workspace-journal', shown: phone ? phoneView === 'journal' : showLeft, toggle: setShowLeft, what: 'le journal',
      icon: <><path d="M7 4v16" /><circle cx="7" cy="7.5" r="2.2" /><circle cx="7" cy="16.5" r="2.2" /><path d="M12.5 7.5H20M12.5 16.5H20" /></> },
    { view: 'editor', label: 'Écriture', id: 'workspace-editor', shown: phone ? phoneView === 'editor' : showCenter, toggle: setShowCenter, what: 'l’écriture',
      icon: <><path d="M5 19.5h3.5L19 9a2.3 2.3 0 0 0-3.3-3.3L5 16.2z" /><path d="m14 7.5 3.3 3.3" /></> },
    { view: 'tasks', label: 'Tâches', id: 'workspace-tasks', shown: phone ? phoneView === 'tasks' : showRight, toggle: setShowRight, what: 'les tâches',
      icon: <><rect x="4.5" y="4.5" width="15" height="15" rx="4" /><path d="m8.6 12.2 2.4 2.4 4.6-4.8" /></> },
    { view: 'procedures', label: 'Procédures', id: 'workspace-procedures', shown: phone ? phoneView === 'procedures' : showProcedures, toggle: setShowProcedures, what: 'les procédures',
      icon: <><path d="M6 4.5h12v15H7.7A1.7 1.7 0 0 1 6 17.8z" /><path d="M6 17.8a1.7 1.7 0 0 1 1.7-1.7H18M9.5 8.5h5" /></> },
  ];
  const [showJournal, showEditor, showBoard, showProcedureBar] = panels.map((panel) => panel.shown);
  const documentTasks = phone ? phoneView === 'tasks' : showDocumentTasks;

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
    <div className="app" ref={pageRef}>
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
          placeholder={phone ? 'Rechercher…' : 'Rechercher dans tout…'}
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
          {panels.map((panel) => (
            <button
              key={panel.view}
              type="button"
              className={'panel-toggle' + (panel.shown ? ' is-on' : '')}
              aria-pressed={panel.shown}
              aria-controls={panel.id}
              title={phone ? undefined : `${panel.shown ? 'Masquer' : 'Afficher'} ${panel.what}`}
              onClick={() => (phone ? goTo(panel.view) : panel.toggle((v) => !v))}
            >
              <svg className="panel-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{panel.icon}</svg>
              {panel.label}
            </button>
          ))}
        </div>
        <button
          className="ghost theme-btn"
          aria-label="Changer de thème"
          title={theme === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre'}
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.1" /><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M3.5 12.5l1.2-1.2M11.3 4.7l1.2-1.2" /></svg> : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M13.6 9.9A5.6 5.6 0 0 1 6.1 2.4a5.6 5.6 0 1 0 7.5 7.5z" /></svg>}
        </button>
        {/* Connecté à Google, la synchro automatique garde déjà une copie à jour
            sur Drive : l'export manuel n'a plus sa place dans l'en-tête. */}
        {!autoSynced && (
          <button className="ghost export-btn" type="button" aria-label="Exporter" title="Télécharger toute la base en JSON" onClick={() => void exportJson()}>
            <svg className="export-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5v8M4.8 7.4 8 10.6l3.2-3.2M3 13.5h10" /></svg>
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
          compact={phone}
        >
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
        </ProjectBar>
      </div>

      {isGoogleDocument && <div className="workspace-switch no-print"><span>Document Google · {siblingTabs.length} onglet{siblingTabs.length > 1 ? 's' : ''}</span>
        <button aria-expanded={showDocumentTasks} aria-controls="workspace-tasks" onClick={() => setShowDocumentTasks(!showDocumentTasks)}>{showDocumentTasks ? 'Masquer les tâches' : 'Afficher les tâches'}</button>
      </div>}
      <div className={'columns' + (isGoogleDocument ? ' is-document' : '') + (documentTasks ? ' with-tasks' : '') + (showJournal ? '' : ' hide-left') + (showEditor ? '' : ' hide-center') + (showBoard ? '' : ' hide-right') + (showProcedureBar ? ' show-procedures' : '')}>
        <aside id="workspace-journal" className="left no-print">
          <EntryList
            categories={state?.categories ?? []}
            grouped={groupedCategories}
            entries={journalEntries}
            projects={state?.projects ?? []}
            selectedId={sharedPath ? null : selectedId}
            onSelect={selectFromList}
            onCreate={createEntry}
            onCreateDocument={createDocument}
            searching={query !== ''}
          />
        </aside>

        <ColumnResizer side="left" panelId="workspace-journal" value={colLeft} onChange={setColLeft} />

        <main id="workspace-editor" className="center">
          {overview && state ? (
            <ProjectOverview
              projects={state.projects}
              tasks={state.tasks}
              entries={state.entries}
              onProject={(id) => void switchProject(id)}
              onTask={revealTask}
              onClose={() => setOverview(false)}
            />
          ) : sharedPath ? (
            <Suspense fallback={loading}>
              <SharedFileEditor
                key={sharedPath}
                path={sharedPath}
                projectId={projectId || null}
                onOpenPath={openShared}
                onChanged={bumpShared}
                onClose={() => setSharedPath(null)}
              />
            </Suspense>
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
              compact={phone}
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
              <p>Choisis une entrée dans le journal, ou crée-en une nouvelle.</p>
            </section>
          )}
        </main>

        <ColumnResizer side="right" panelId="workspace-tasks" value={colRight} onChange={setColRight} />

        <aside id="workspace-tasks" className="right no-print">
          <TaskBoard
            categories={state?.categories ?? []}
            categoryId={categoryId}
            search={search}
            grouped={groupedCategories}
            tasks={state?.tasks ?? []}
            entries={state?.entries ?? []}
            projectId={projectId}
            projects={state?.projects ?? []}
            view={taskView}
            onView={setTaskView}
            onOpenDocument={openDocument}
            onOpenShared={openShared}
            onProcedureCreated={openCreatedProcedure}
            onChanged={reload}
            onOverview={openOverview}
            overviewOpen={overview}
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
            onSelect={selectFromList}
            onEdit={editProcedure}
            onCreate={createProcedure}
            onChanged={reload}
            onDeleted={procedureDeleted}
          />
          {/* PWA : absente tant que le relais n'est pas réglé (le statut dit « indisponible »). */}
          <SharedFolder
            active={showProcedureBar}
            projectId={projectId}
            projects={state?.projects ?? []}
            procedures={sharedProcedures}
            selectedPath={sharedPath}
            revision={sharedRevision}
            onOpen={openShared}
            onDeleted={sharedDeleted}
            onRenamed={sharedRenamed}
            onProjectsChanged={reload}
            onLocalChanged={reload}
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
            <Suspense fallback={loading}>
              <GoogleDrive onRestored={reload} onOpen={openDriveEntry} onDocuments={() => { setShowSettings(false); setShowDocuments(true); }} />
            </Suspense>
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
        <Suspense fallback={loading}>
          <GoogleDocuments
            projects={state?.projects ?? []}
            onClose={() => setShowDocuments(false)}
            onOpen={openDriveEntry}
            onChanged={reload}
          />
        </Suspense>
      )}
    </div>
  );
}

const SELECTED_KEY = 'worklogs-entry';
const PROJECT_KEY = 'worklogs-project';
const SHARED_KEY = 'worklogs-shared-path';
const COL_PROC_KEY = 'worklogs-col-procedures';
/** En dessous, les boutons d'une procédure ne tiennent plus sur leur ligne. */
const PROC_MIN = 260;

/**
 * État retenu dans `localStorage` sous `key` : `read` l'interprète (et le borne),
 * `write` le sérialise — `null` retire la clé. Mêmes clés et mêmes valeurs
 * qu'avant : les recettes et l'application desktop les lisent telles quelles.
 */
function usePersisted<T>(key: string, read: (stored: string | null) => T, write: (value: T) => string | null = String) {
  const [value, setValue] = useState(() => read(typeof localStorage === 'undefined' ? null : localStorage.getItem(key)));
  useEffect(() => {
    const stored = write(value);
    if (stored === null) localStorage.removeItem(key);
    else localStorage.setItem(key, stored);
  }, [key, value, write]);
  return [value, setValue] as const;
}
/** Une valeur vide ne s'enregistre pas : la clé est oubliée. */
const orForget = (value: string | null) => value || null;
/** Largeur de colonne en pixels, dans ses bornes ; sinon la largeur par défaut. */
const readWidth = (fallback: number, min = 120) => (stored: string | null) => {
  const v = Number(stored);
  return Number.isFinite(v) && v >= min && v <= 600 ? v : fallback;
};
/** Panneau visible par défaut ; `'0'` enregistré le replie durablement. */
const readPanel = (fallback = true) => (stored: string | null) => (stored === null ? fallback : stored !== '0');
const writePanel = (shown: boolean) => (shown ? '1' : '0');

/** Téléphone, en portrait comme en paysage : les mêmes requêtes que `styles.css` (§53). */
const PHONE = '(max-width: 600px), (max-width: 900px) and (max-height: 500px)';
type PhoneView = 'journal' | 'editor' | 'tasks' | 'procedures';
const isPhone = () => Boolean(window.matchMedia?.(PHONE).matches);
const onPhoneChange = (notify: () => void) => {
  const query = window.matchMedia?.(PHONE);
  query?.addEventListener('change', notify);
  return () => query?.removeEventListener('change', notify);
};
/** Marque l'entrée d'historique laissée en quittant le journal sur téléphone. */
const VIEW_STEP = 'worklogsView';
