import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './styles.css';
import { api, emptyDocument, todayISO, type AppState, type Entry } from './lib';
import { EntryList } from './components/EntryList';
import { ProcedureList } from './components/ProcedureList';
import { EntryEditor } from './components/EntryEditor';
import { Logo } from './components/Logo';
import { UpdateBar } from './components/UpdateBar';
import { TaskBoard } from './components/TaskBoard';
import { ProjectBar } from './components/ProjectBar';
import { GoogleDrive } from './components/GoogleDrive';
import { AiSettings } from './components/AiSettings';
import { ColumnResizer } from './components/ColumnResizer';
import { flushPendingSaves, hasPendingSaves } from './autosave';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState(readProject);
  // L'entrée ouverte survit au rechargement et au redémarrage : on retrouve le
  // document qu'on éditait, au lieu de retomber sur « le plus récent ». C'est
  // aussi ce qui rend les recettes déterministes — elles pariaient jusqu'ici sur
  // l'ordre des entrées après un rechargement.
  const [selectedId, setSelectedId] = useState<string | null>(readSelected);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [freshEntry, setFreshEntry] = useState(false);
  const [showDocumentTasks, setShowDocumentTasks] = useState(false);
  const documentRef = useRef<string | undefined>(undefined);
  documentRef.current = entry?.google_sync?.document_id;
  const [theme, setTheme] = useState(readTheme);
  const [colLeft, setColLeft] = useState(readColLeft);
  const [colRight, setColRight] = useState(readColRight);
  const [showLeft, setShowLeft] = useState(() => readPanel('worklogs-show-left'));
  const [showCenter, setShowCenter] = useState(() => readPanel('worklogs-show-center'));
  const [showRight, setShowRight] = useState(() => readPanel('worklogs-show-right'));
  const [showSettings, setShowSettings] = useState(false);
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
  }, [colLeft, colRight]);

  useEffect(() => {
    localStorage.setItem('worklogs-show-left', showLeft ? '1' : '0');
  }, [showLeft]);

  useEffect(() => {
    localStorage.setItem('worklogs-show-center', showCenter ? '1' : '0');
  }, [showCenter]);

  useEffect(() => {
    localStorage.setItem('worklogs-show-right', showRight ? '1' : '0');
  }, [showRight]);

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
      // Une tâche terminée peut archiver l'entrée actuellement ouverte :
      // actualiser seulement ses métadonnées évite d'écraser un brouillon local.
      const selectedSummary = next.entries.find((e) => e.id === selectedRef.current);
      if (selectedSummary) {
        setEntry((current) => current && current.id === selectedSummary.id
          ? { ...current, archived: selectedSummary.archived, updated_at: selectedSummary.updated_at }
          : current);
      }
      // Rien de sélectionné (premier chargement, ou entrée supprimée) : on ouvre la plus récente.
      const stillThere = next.entries.some((e) => e.id === selectedRef.current || (documentRef.current && e.google_document_id === documentRef.current));
      if (!stillThere) setSelectedId(next.entries[0]?.id ?? null);
    } catch {
      setError('API injoignable. Lance `npm run dev` dans /home/timo/WorkLogs.');
    }
  }, [query, projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (state && projectId && !state.projects.some((project) => project.id === projectId)) {
      setProjectId('');
    }
  }, [state, projectId]);

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

  const createProcedure = async () => {
    const created = await api.createEntry({
      title: 'Sans titre',
      entry_date: todayISO(),
      project_id: projectId || null,
      kind: 'procedure',
      content_json: emptyDocument(),
    });
    setSearch('');
    setFreshEntry(true);
    setSelectedId(created.id);
    setEntry({ ...created, attachments: [] });
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

  const stats = state?.stats;

  const openDocument = useCallback((entryId: string) => {
    const summary = state?.entries.find((candidate) => candidate.id === entryId)
      ?? state?.tasks.flatMap((task) => task.documents ?? []).find((candidate) => candidate.id === entryId);
    if (summary && summary.project_id !== projectId) setProjectId(summary.project_id ?? '');
    setFreshEntry(false);
    selectedRef.current = entryId;
    setSelectedId(entryId);
  }, [projectId, state]);

  // Ouverture d'un document Drive : même geste que depuis une carte de tâche,
  // mais en rechargeant l'état sans filtrer par projet.
  const openDriveEntry = useCallback((opened: Entry) => {
    const sequence = ++reloadSequence.current;
    setSearch(''); setQuery(''); setFreshEntry(false);
    selectedRef.current = opened.id;
    setSelectedId(opened.id); setEntry(opened);
    void api.state('', projectId).then(next => { if (sequence === reloadSequence.current) setState(next); }).catch(() => {});
  }, [projectId]);

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
            {stats.overdue > 0 && (
              <>
                {' · '}
                <b className="late">{stats.overdue}</b> en retard
              </>
            )}
          </p>
        )}
        <button
          className="ghost theme-btn"
          aria-label="Changer de thème"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <div className="panel-toggles no-print" role="group" aria-label="Panneaux latéraux">
          <button
            type="button"
            className={'ghost' + (showLeft ? ' is-on' : '')}
            aria-pressed={showLeft}
            aria-controls="workspace-journal"
            title={showLeft ? 'Masquer le journal' : 'Afficher le journal'}
            onClick={() => setShowLeft((v) => !v)}
          >
            Journal
          </button>
          <button
            type="button"
            className={'ghost' + (showCenter ? ' is-on' : '')}
            aria-pressed={showCenter}
            aria-controls="workspace-editor"
            title={showCenter ? 'Masquer l’écriture' : 'Afficher l’écriture'}
            onClick={() => setShowCenter((v) => !v)}
          >
            Écriture
          </button>
          <button
            type="button"
            className={'ghost' + (showRight ? ' is-on' : '')}
            aria-pressed={showRight}
            aria-controls="workspace-tasks"
            title={showRight ? 'Masquer les tâches' : 'Afficher les tâches'}
            onClick={() => setShowRight((v) => !v)}
          >
            Tâches
          </button>
        </div>
        <div className="col-widths">
          <div className="col-width-control">
            <label htmlFor="col-left-width">Gauche</label>
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
          </div>
          <div className="col-width-control">
            <label htmlFor="col-right-width">Droite</label>
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
          </div>
          <button
            className="col-width-reset"
            type="button"
            onClick={() => {
              setColLeft(290);
              setColRight(320);
            }}
            aria-label="Largeurs par défaut"
          >
            Par défaut
          </button>
        </div>
        <button className="ghost export-btn" type="button" aria-label="Exporter" onClick={() => void exportJson()}>
          <span className="export-icon" aria-hidden="true">⤓</span>
          <span className="export-label">Exporter</span>
        </button>
        <button
          className="ghost settings-btn"
          type="button"
          aria-haspopup="dialog"
          aria-label="⚙ Paramètres"
          title="Paramètres (dont Google Drive)"
          onClick={() => setShowSettings(true)}
        >
          <span className="settings-icon" aria-hidden="true">⚙</span>
          <span className="settings-label">Paramètres</span>
        </button>
      </header>

      {error && <p className="error banner no-print">{error}</p>}

      {/* Projets hors de la sidebar : le filtre et la gestion restent accessibles
          même quand le journal est replié, sur mobile comme sur desktop. */}
      <div className="project-strip no-print">
        <ProjectBar
          projects={state?.projects ?? []}
          selected={projectId}
          onSelect={setProjectId}
          onChanged={reload}
        />
      </div>

      {isGoogleDocument && <div className="workspace-switch no-print"><span>Document Google · {siblingTabs.length} onglet{siblingTabs.length > 1 ? 's' : ''}</span>
        <button aria-expanded={showDocumentTasks} aria-controls="workspace-tasks" onClick={() => setShowDocumentTasks(!showDocumentTasks)}>{showDocumentTasks ? 'Masquer les tâches' : 'Afficher les tâches'}</button>
      </div>}
      <div className={'columns' + (isGoogleDocument ? ' is-document' : '') + (showDocumentTasks ? ' with-tasks' : '') + (showLeft ? '' : ' hide-left') + (showCenter ? '' : ' hide-center') + (showRight ? '' : ' hide-right')}>
        <aside id="workspace-journal" className="left no-print">
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
          <ProcedureList
            entries={state?.entries ?? []}
            attachments={state?.procedure_attachments ?? []}
            projects={state?.projects ?? []}
            projectId={projectId}
            selectedId={selectedId}
            onSelect={(id) => {
              setFreshEntry(false);
              setSelectedId(id);
            }}
            onCreate={() => void createProcedure()}
          />
        </aside>

        <ColumnResizer side="left" panelId="workspace-journal" value={colLeft} onChange={setColLeft} />

        <main id="workspace-editor" className="center">
          {entry && state ? (
            <EntryEditor
              key={entry.id}
              tabs={siblingTabs}
              onSelectTab={setSelectedId}
              entry={entry}
              projects={state.projects}
              linkedTasks={state.tasks
                .filter((task) => (task.documents ?? []).some((document) => document.id === entry.id))
                .map((task) => ({ title: task.title, status: task.status }))}
              autoFocusTitle={freshEntry}
              onChanged={reload}
              onTaskCreated={reload}
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
            tasks={state?.tasks ?? []}
            entries={state?.entries ?? []}
            projectId={projectId}
            projects={state?.projects ?? []}
            onOpenDocument={openDocument}
            onChanged={reload}
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
          }}
        >
          <div className="settings-dialog-heading">
            <h2>Paramètres</h2>
            <button className="ghost" type="button" onClick={() => setShowSettings(false)}>
              Fermer
            </button>
          </div>
          <div className="settings-content">
            <GoogleDrive onRestored={reload} onOpen={openDriveEntry} />
            <AiSettings />
          </div>
          {/* La pastille de version de l'en-tête est masquée sur mobile :
              le numéro reste accessible ici. */}
          <p className="settings-version">WorkLogs {__WORKLOGS_VERSION__}</p>
        </dialog>
      ), document.body)}
    </div>
  );
}

const SELECTED_KEY = 'worklogs-entry';
const PROJECT_KEY = 'worklogs-project';

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

/** Panneau visible par défaut ; `'0'` enregistré le replie durablement. */
function readPanel(key: string) {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(key) !== '0';
}
