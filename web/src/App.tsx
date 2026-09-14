import { useCallback, useEffect, useRef, useState } from 'react';
import './styles.css';
import { api, emptyDocument, todayISO, type AppState, type Entry } from './lib';
import { EntryList } from './components/EntryList';
import { EntryEditor } from './components/EntryEditor';
import { Logo } from './components/Logo';
import { UpdateBar } from './components/UpdateBar';
import { TaskBoard } from './components/TaskBoard';
import { ProjectBar } from './components/ProjectBar';
import { GoogleDrive } from './components/GoogleDrive';
import { flushPendingSaves, hasPendingSaves } from './autosave';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [freshEntry, setFreshEntry] = useState(false);
  const [theme, setTheme] = useState(readTheme);
  const selectedRef = useRef<string | null>(null);
  const reloadSequence = useRef(0);
  selectedRef.current = selectedId;

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

  // La recherche attend une pause de frappe avant d'interroger l'API.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    try {
      const next = await api.state(query, projectId);
      if (sequence !== reloadSequence.current) return;
      setState(next);
      setError('');
      // Rien de sélectionné (premier chargement, ou entrée supprimée) : on ouvre la plus récente.
      const stillThere = next.entries.some((e) => e.id === selectedRef.current);
      if (!stillThere) setSelectedId(next.entries[0]?.id ?? null);
    } catch {
      setError('API injoignable. Lance `npm run dev` dans /home/timo/WorkLogs.');
    }
  }, [query, projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

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
    const created = await api.createEntry({
      title: 'Sans titre',
      entry_date: todayISO(),
      project_id: projectId || null,
      ...(rich ? { content_json: emptyDocument() } : {}),
    });
    setSearch('');
    setFreshEntry(true);
    setSelectedId(created.id);
    setEntry({ ...created, attachments: [] });
    reload();
  };

  const stats = state?.stats;

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
            {stats.overdue > 0 && (
              <>
                {' · '}
                <b className="late">{stats.overdue}</b> en retard
              </>
            )}
          </p>
        )}
        <button
          className="ghost"
          aria-label="Changer de thème"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <a className="ghost" href="/api/export" download="worklogs.json">
          Exporter
        </a>
      </header>

      {error && <p className="error banner no-print">{error}</p>}

      <div className="columns">
        <aside className="left no-print">
          <ProjectBar
            projects={state?.projects ?? []}
            selected={projectId}
            onSelect={setProjectId}
            onChanged={reload}
          />
          <EntryList
            entries={state?.entries ?? []}
            projects={state?.projects ?? []}
            selectedId={selectedId}
            onSelect={(id) => {
              setFreshEntry(false);
              setSelectedId(id);
            }}
            onCreate={() => void createEntry()}
            onCreateDocument={() => void createEntry(true)}
            searching={query !== ''}
          />
          <GoogleDrive onOpen={(opened) => {
            const sequence = ++reloadSequence.current;
            setSearch(''); setQuery(''); setProjectId(''); setFreshEntry(false);
            selectedRef.current = opened.id;
            setSelectedId(opened.id); setEntry(opened);
            void api.state().then(next => { if (sequence === reloadSequence.current) setState(next); }).catch(() => {});
          }} />
        </aside>

        <main className="center">
          {entry && state ? (
            <EntryEditor
              key={entry.id}
              entry={entry}
              projects={state.projects}
              autoFocusTitle={freshEntry}
              onChanged={reload}
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

        <aside className="right no-print">
          <TaskBoard tasks={state?.tasks ?? []} projectId={projectId} onChanged={reload} />
        </aside>
      </div>
    </div>
  );
}

function readTheme() {
  if (typeof localStorage === 'undefined') return 'dark';
  return localStorage.getItem('worklogs-theme') === 'light' ? 'light' : 'dark';
}
