import { memo, useEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { COLUMNS, PRIORITIES, TASK_VIEWS, api, dayLabel, isOverdue, overviewOrder, priorityLabel, subtasksMd, todayISO, type Category, type Entry, type EntrySummary, type Priority, type Project, type Status, type Task, type TaskView } from '../lib';
import { AiCancelled, draftProcedure, MAX_SOURCE_DOCUMENTS, prioritizeTasks, readAiSettings, suggestSearchTerms, suggestSubtasks, taskSuggestContext, type AiWorkContext, type DraftedProcedure, type TaskPriorityProposal } from '../ai-suggest';
import { loadAiContext, readProjectAiBrief, selectedAiContext } from '../ai-context';
import { findDocuments, type FoundDocument } from '../doc-finder';
import { richToMarkdown } from '../rich-markdown';
import { ProcedureDraft } from './ProcedureDraft';
import { AiContextDetails } from './AiContextDetails';
import { AiMenu } from './AiMenu';
import { AiRefinement } from './AiRefinement';

import { groupByCategory } from '../categories';
import { CategoryBadge, CategoryPicker } from './CategoryPicker';

const DRAG_TYPE = 'text/plain';
/** `category_base` : le classement reçu sur lequel repose le choix affiché. */
type TaskEditForm = { title: string; due_date: string; priority: Priority; status: Status; status_base: Status; category_id: string; category_base: string };
const taskForm = (task: Task): TaskEditForm => ({ title: task.title, due_date: task.due_date ?? '', priority: task.priority ?? 'normal', status: task.status, status_base: task.status, category_id: task.category_id || '', category_base: task.category_id || '' });

/** Mémoïsé : la recherche de l'en-tête se redessine à chaque frappe, pas les cartes. */
export const TaskBoard = memo(function TaskBoard({
  tasks,
  entries,
  projectId,
  projects,
  categories = [],
  categoryId = '',
  search = '',
  grouped = false,
  view,
  onView,
  onOpenDocument,
  onOpenShared,
  onProcedureCreated,
  onChanged,
  onOverview,
  overviewOpen = false,
}: {
  tasks: Task[];
  entries: EntrySummary[];
  projectId: string;
  projects: Project[];
  categories?: Category[];
  categoryId?: string;
  search?: string;
  grouped?: boolean;
  view: TaskView | null;
  onView: (view: TaskView | null) => void;
  /** `projectId` : projet connu d'un document absent de l'état filtré, que l'ouverture suit. */
  onOpenDocument: (entryId: string, projectId?: string | null) => void;
  onOpenShared: (path: string) => void;
  /** Procédure tirée d'une tâche par l'IA, créée : l'app l'ouvre. */
  onProcedureCreated: (procedure: Entry) => void;
  onChanged: () => void;
  /** Ouvre la vue d'ensemble des projets au centre ; `overviewOpen` : elle y est déjà. */
  onOverview?: () => void;
  overviewOpen?: boolean;
}) {
  const [over, setOver] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Le brouillon survit au passage de la carte dans un autre groupe (suppression
  // ou déplacement de catégorie), même si React remonte cette carte.
  const [editingForm, setEditingForm] = useState<TaskEditForm | null>(null);
  const creationCategory = categories.find((category) => category.id === categoryId);
  const today = todayISO();
  const active = TASK_VIEWS.find((candidate) => candidate.id === view);
  const counts = new Map(TASK_VIEWS.map((candidate) => [candidate.id, tasks.filter((task) => candidate.match(task, today)).length]));
  // Une vue vide n'apprend rien : elle s'efface, sauf celle qu'on regarde.
  const views = TASK_VIEWS.filter((candidate) => counts.get(candidate.id)! > 0 || candidate.id === view);

  // « Tout » avec plusieurs projets : les trois colonnes mêlaient les projets en une pile
  // illisible. Une seule liste des tâches ouvertes, rangée (en cours, retards, épinglées,
  // priorité, échéance), chaque carte disant son projet ; Terminé reste repliée dessous.
  // Projet choisi, ou un seul projet : les colonnes et leur glisser-déposer.
  const overview = !projectId && projects.length > 1;
  // Priorités proposées par l'IA, par tâche, avec leur rang : relues ici, écrites à « Appliquer ».
  const [proposal, setProposal] = useState<Map<string, TaskPriorityProposal & { rank: number }> | null>(null);
  const [prioritizing, setPrioritizing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [prioritizeError, setPrioritizeError] = useState('');
  const aiRequest = useRef<AbortController | null>(null);
  const open = tasks.filter((task) => task.status !== 'done' && (!active || active.match(task, today)));
  // Les champs transmis sont la base de la proposition : une modification reçue depuis
  // l'interface ou un autre appareil la rend périmée, même si le filtre n'a pas changé.
  const taskSnapshot = JSON.stringify(open.map((task) => [task.id, task.title, task.status, task.priority, task.due_date, task.pinned, task.created_at, task.project_id, projects.find((project) => project.id === task.project_id)?.name, task.documents?.length ?? 0]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  useEffect(() => () => aiRequest.current?.abort(), []);
  // Un autre filtre ou des tâches modifiées : la proposition ne les concerne plus.
  useEffect(() => {
    aiRequest.current?.abort();
    setProposal(null);
  }, [projectId, categoryId, search, view, taskSnapshot]);
  useEffect(() => { setPrioritizeError(''); }, [projectId, categoryId, search, view]);
  const stopAi = () => aiRequest.current?.abort();
  const changes = proposal ? open.filter((task) => proposal.get(task.id) && proposal.get(task.id)!.priority !== task.priority).length : 0;
  const prioritize = async () => {
    if (prioritizing) return;
    setPrioritizing(true);
    setPrioritizeError('');
    try {
      const request = new AbortController();
      aiRequest.current = request;
      const proposed = await prioritizeTasks({ ...readAiSettings(), signal: request.signal }, overviewOrder(open).map((task) => ({
        id: task.id, title: task.title, status: task.status, priority: task.priority, due_date: task.due_date, pinned: task.pinned, created_at: task.created_at,
        project: projects.find((project) => project.id === task.project_id)?.name,
        projectId: task.project_id ?? undefined,
        projectBrief: readProjectAiBrief(task.project_id),
        documents: task.documents?.length ?? 0,
      })));
      if (!request.signal.aborted) setProposal(new Map(proposed.map((item, rank) => [item.id, { ...item, rank }])));
    } catch (e) {
      if (!(e instanceof AiCancelled)) setPrioritizeError((e as Error).message);
    } finally {
      setPrioritizing(false);
    }
  };
  const applyProposal = async () => {
    if (!proposal || applying) return;
    setApplying(true);
    setPrioritizeError('');
    try {
      for (const task of open) {
        const item = proposal.get(task.id);
        if (item && item.priority !== task.priority) await api.updateTask(task.id, { priority: item.priority });
      }
      setProposal(null);
      onChanged();
    } catch (e) {
      setPrioritizeError((e as Error).message);
      // Des écritures précédentes peuvent avoir réussi avant l'échec d'une autre.
      onChanged();
    } finally {
      setApplying(false);
    }
  };
  const lanes: { id: string; label: string; status: Status | null; tasks: Task[] }[] = overview
    ? [
      { id: 'open', label: 'À faire · En cours', status: null, tasks: overviewOrder(open, proposal ?? undefined) },
      { id: 'done', label: 'Terminé', status: 'done', tasks: tasks.filter((task) => task.status === 'done') },
    ]
    : COLUMNS.map((column) => ({ id: column.id, label: column.label, status: column.id, tasks: tasks.filter((task) => task.status === column.id) }));

  const drop = async (event: React.DragEvent, status: Status, position: number) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(null);
    const id = event.dataTransfer.getData(DRAG_TYPE);
    if (!id) return;
    await api.moveTask(id, status, position);
    onChanged();
  };

  return (
    <section className="board" aria-label="Tâches">
      <div className="board-head">
        {/* Une tâche neuve n'entre dans aucune vue : on lève le filtre pour la voir arriver. */}
        <QuickAdd projectId={projectId || creationCategory?.project_id || ''} categoryId={creationCategory?.id || null} onAdded={() => { onView(null); onChanged(); }} />

        {views.length > 0 && (
          <div className="chips task-views" role="group" aria-label="Filtrer les tâches">
            <button type="button" className={'chip' + (active ? '' : ' is-on')} aria-pressed={!active} onClick={() => onView(null)}>
              Toutes
            </button>
            {views.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={'chip task-view is-' + candidate.id + (candidate.id === view ? ' is-on' : '')}
                aria-pressed={candidate.id === view}
                title={candidate.hint}
                onClick={() => onView(candidate.id === view ? null : candidate.id)}
              >
                {candidate.icon && <span aria-hidden="true">{candidate.icon}</span>}
                {candidate.label} <span className="count">{counts.get(candidate.id)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="board-tools">
          <AiMenu label="Assistance IA des tâches" busy={prioritizing ? 'Priorisation…' : null} onCancel={stopAi}>
            <button
              role="menuitem"
              type="button"
              disabled={prioritizing || open.length === 0}
              title="Envoie au service IA configuré en Paramètres les titres, projets, statuts, priorités, échéances, épingles, dates de création et nombres de documents des tâches ouvertes, ainsi que le profil et les repères IA des projets ; jamais le contenu des documents. Propose une priorité et sa raison par tâche, à relire avant d’appliquer."
              onClick={() => void prioritize()}
            >
              Prioriser les tâches
            </button>
          </AiMenu>
          {onOverview && (
            <button className={'ghost' + (overviewOpen ? ' is-on' : '')} type="button" aria-pressed={overviewOpen} title="L’avancement de chaque projet, au centre" onClick={onOverview}>
              Vue d’ensemble
            </button>
          )}
        </div>
        {prioritizeError && <p className="error" role="alert">{prioritizeError}</p>}
        {proposal && (
          <div className="ai-proposal" role="region" aria-label="Priorités proposées par l’IA">
            <span>{changes === 0 ? 'L’IA confirme les priorités actuelles.' : `${changes} priorité${changes > 1 ? 's' : ''} à changer`}</span>
            <button className="task-primary" type="button" disabled={applying || changes === 0} onClick={() => void applyProposal()}>
              {applying ? 'Application…' : 'Appliquer'}
            </button>
            <button className="ghost" type="button" disabled={applying} onClick={() => setProposal(null)}>
              Ignorer
            </button>
          </div>
        )}
      </div>

      {/* Seule la liste défile : saisie et vues restent en tête, sans jamais passer
          devant les cartes (elles étaient collantes, et les cartes défilaient dessous). */}
      <div className={'board-lists' + (overview ? ' is-overview' : '')}>
        {active && counts.get(active.id) === 0 && <p className="empty">{active.empty}</p>}
        {lanes.map((lane) => {
          const shown = active ? lane.tasks.filter((task) => active.match(task, today)) : lane.tasks;
          // Une vue ne garde que les colonnes où elle trouve quelque chose.
          if (active && shown.length === 0) return null;
          // La liste de « Tout » mêle deux statuts : rien ne s'y dépose.
          const target = lane.status;
          return (
            <div
              key={lane.id}
              className={'column' + (over === lane.id ? ' is-over' : '')}
              onDragOver={target ? (e) => {
                e.preventDefault();
                setOver(lane.id);
              } : undefined}
              onDragLeave={target ? () => setOver((c) => (c === lane.id ? null : c)) : undefined}
              onDrop={target ? (e) => drop(e, target, Number.MAX_SAFE_INTEGER) : undefined}
            >
              <h2 aria-label={lane.id === 'done' ? lane.label : undefined}>
                {lane.id === 'done' ? (
                  <button
                    className="completed-toggle"
                    type="button"
                    aria-label={`${showCompleted ? 'Masquer' : 'Afficher'} les tâches terminées (${shown.length})`}
                    aria-expanded={showCompleted}
                    aria-controls="completed-task-list"
                    onClick={() => setShowCompleted((shown) => !shown)}
                  >
                    {showCompleted ? 'Masquer' : 'Afficher'} les tâches terminées
                    <span className="count">{shown.length}</span>
                  </button>
                ) : (
                  <>{lane.label} <span className="count">{shown.length}</span></>
                )}
              </h2>
              <ul
                id={lane.id === 'done' ? 'completed-task-list' : undefined}
                hidden={lane.id === 'done' && !showCompleted}
              >
                {(grouped ? groupByCategory(shown, categories, projects) : [{ id: '', label: '', items: shown }]).map((group) => {
                  const cards = group.items.map((task) => (
                    <li key={task.id} id={'task-' + task.id}>
                      <TaskCard
                        task={task}
                        tasks={tasks}
                        entries={entries}
                        projects={projects}
                        categories={categories}
                        // Groupées, les cartes sont déjà sous un titre « Projet · Catégorie ».
                        showProject={overview && !grouped}
                        showStatus={overview}
                        proposal={proposal?.get(task.id)}
                        draggable={!overview}
                        editing={editing === task.id}
                        form={editing === task.id && editingForm ? editingForm : taskForm(task)}
                        onFormChange={(next) => { if (editingRef.current === task.id) setEditingForm((current) => typeof next === 'function' ? next(current || taskForm(task)) : next); }}
                        onEdit={() => { setEditingForm(taskForm(task)); setEditing(task.id); }}
                        onEditDone={() => { if (editingRef.current === task.id) { editingRef.current = null; setEditing(null); setEditingForm(null); } }}
                        onOpenDocument={onOpenDocument}
                        onOpenShared={onOpenShared}
                        onProcedureCreated={onProcedureCreated}
                        onChanged={onChanged}
                        // Position dans la colonne entière : filtres et groupes cachent des voisines.
                        onDrop={target ? (e) => drop(e, target, task.position) : undefined}
                      />
                    </li>
                  ));
                  return grouped ? (
                    <li key={group.id} className="task-category-group">
                      <h3 className="category-group-title">{group.label} <span className="count">{group.items.length}</span></h3>
                      <ul className="task-category-items">{cards}</ul>
                    </li>
                  ) : cards;
                })}

              </ul>
              {lane.tasks.length === 0 && <p className="empty-column">{target ? 'Déposer ici' : 'Aucune tâche ouverte.'}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
});

/** Saisie d'une tâche : son état vit ici, pour que taper ne redessine pas chaque carte. */
function QuickAdd({ projectId, categoryId, onAdded }: { projectId: string; categoryId: string | null; onAdded: () => void }) {
  const [title, setTitle] = useState('');
  const add = async () => {
    if (!title.trim()) return;
    await api.createTask({ title: title.trim(), project_id: projectId || null, category_id: categoryId });
    setTitle('');
    onAdded();
  };
  return (
    <div className="quick">
      <input
        aria-label="Nouvelle tâche"
        placeholder="Nouvelle tâche…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
      />
      <button className="ghost" type="button" onClick={add} disabled={!title.trim()}>
        Ajouter
      </button>
    </div>
  );
}

function TaskCard({
  task,
  tasks,
  entries,
  projects,
  categories,
  showProject = false,
  showStatus = false,
  proposal,
  draggable = true,
  editing,
  form,
  onFormChange: setForm,

  onEdit,
  onEditDone,
  onOpenDocument,
  onOpenShared,
  onProcedureCreated,
  onChanged,
  onDrop,
}: {
  task: Task;
  /** Toutes les tâches du filtre : le contexte IA (tâches voisines, vocabulaire) s'en déduit à la demande. */
  tasks: Task[];
  entries: EntrySummary[];
  projects: Project[];
  categories: Category[];
  /** Tous les projets affichés : la carte porte le sien et dit « En cours » (aucune colonne ne le dit). */
  showProject?: boolean;
  showStatus?: boolean;
  /** Priorité proposée par l'IA et sa raison, tant que la proposition est ouverte. */
  proposal?: { priority: Priority; reason: string };
  draggable?: boolean;
  editing: boolean;
  form: TaskEditForm;
  onFormChange: Dispatch<SetStateAction<TaskEditForm>>;

  onEdit: () => void;
  onEditDone: () => void;
  onOpenDocument: (entryId: string, projectId?: string | null) => void;
  onOpenShared: (path: string) => void;
  onProcedureCreated: (procedure: Entry) => void;
  onChanged: () => void;
  onDrop?: (event: React.DragEvent) => void;
}) {
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  useEffect(() => {
    if (!editing) {
      setEditError('');
      return;
    }
    const remote = task.category_id || '';
    setForm((current) => {
      // Classement reçu pendant l'édition (document lié qui le donne, autre appareil) :
      // il remplace le choix affiché tant qu'on n'y a pas touché, sinon « Enregistrer » l'effacerait.
      if (current.category_base !== remote) return { ...current, category_base: remote, category_id: current.category_id === current.category_base ? remote : current.category_id };
      return current.category_id && !categories.some((category) => category.id === current.category_id && category.project_id === task.project_id)
        ? { ...current, category_id: remote } : current;
    });
  }, [editing, form.category_id, task.category_id, task.project_id, categories]);
  const [linking, setLinking] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Créateur d'entrée liée : titre prérempli + sous-tâches en cases à cocher.
  const [creatingEntry, setCreatingEntry] = useState(false);
  const [entryTitle, setEntryTitle] = useState(task.title);
  const [entrySubtasks, setEntrySubtasks] = useState('');
  const [entryBusy, setEntryBusy] = useState(false);
  // Suggestion IA : un clic = un envoi du titre au service configuré en Paramètres.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState('');
  const [aiContext, setAiContext] = useState<AiWorkContext | null>(null);
  const [excludedSourceIds, setExcludedSourceIds] = useState<string[]>([]);
  const contextVersion = useRef(0);
  const [canRefineCreator, setCanRefineCreator] = useState(false);
  const excludeSources = (ids: string[]) => {
    contextVersion.current += 1;
    setExcludedSourceIds(ids);
    setCanRefineCreator(false);
    setProcedureDraft(null);
  };
  const linkedDocuments = task.documents ?? [];
  const linkedIds = new Set(linkedDocuments.map((document) => document.id));
  const availableDocuments = entries.filter((entry) => !linkedIds.has(entry.id));
  const query = filter.trim().toLowerCase();
  const visibleDocuments = query
    ? availableDocuments.filter((entry) => entry.title.toLowerCase().includes(query))
    : availableDocuments;
  const done = task.status === 'done';
  const late = isOverdue(task);
  // Les documents d'une tâche terminée sont repliés derrière un historique :
  // la carte reste compacte, le contexte reste accessible. `null` = suivre le statut.
  const [docsOverride, setDocsOverride] = useState<boolean | null>(null);
  const docsExpanded = docsOverride ?? !done;

  const patch = async (body: Partial<Task>) => {
    await api.updateTask(task.id, body);
    onChanged();
  };

  const saveEdit = async () => {
    if (!form.title.trim() || editSaving) return;
    setEditSaving(true);
    setEditError('');
    try {
      await api.updateTask(task.id, { title: form.title.trim(), due_date: form.due_date || null, priority: form.priority, category_id: form.category_id || null });
      // Au doigt ou au clavier, pas de glisser-déposer : la carte va au bas de sa nouvelle colonne.
      // Seulement si le choix a changé ici : un déplacement fait ailleurs pendant l'édition tient.
      try {
        if (form.status !== form.status_base) await api.moveTask(task.id, form.status, Number.MAX_SAFE_INTEGER);
      } finally {
        onChanged();
      }
      onEditDone();
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setEditSaving(false);
    }
  };

  const startLinking = () => {
    setFilter('');
    setSelected([]);
    setLinking(true);
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((candidate) => candidate !== id) : [...prev, id]));
  };

  const linkSelected = async () => {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    try {
      await Promise.all(selected.map((id) => api.linkTaskDocument(task.id, id)));
      setLinking(false);
      setSelected([]);
      setFilter('');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const unlinkDocument = async (entryId: string) => {
    await api.unlinkTaskDocument(task.id, entryId);
    onChanged();
  };

  const startEntryCreator = () => {
    setEntryTitle(task.title);
    setEntrySubtasks('');
    setSuggestError('');
    setCanRefineCreator(false);
    setCreatingEntry(true);
  };

  // « Arrêter » coupe les demandes IA de la carte en cours (procédure, recherche, sous-tâches) ;
  // la suivante repart d'un contrôleur neuf. Une carte qui disparaît coupe les siennes.
  const aiRequest = useRef<AbortController | null>(null);
  useEffect(() => () => aiRequest.current?.abort(), []);
  const aiSettings = () => {
    if (!aiRequest.current || aiRequest.current.signal.aborted) aiRequest.current = new AbortController();
    return { ...readAiSettings(), signal: aiRequest.current.signal };
  };
  const stopAi = () => aiRequest.current?.abort();

  const contextForTask = async (version: number, title = task.title, text = '') => {
    const context = await loadAiContext({
      projectId: task.project_id,
      title,
      text,
      taskId: task.id,
      linkedDocumentIds: linkedDocuments.map((document) => document.id),
    });
    if (contextVersion.current !== version) throw new Error('Le contexte IA a changé : relance la demande.');
    setAiContext(context);
    return context;
  };

  const suggestForCreator = async (instruction?: string) => {
    if (suggesting || drafting) return;
    const version = contextVersion.current;
    setSuggesting(true);
    setSuggestError('');
    try {
      const settings = aiSettings();
      if (!settings.key) throw new Error('Colle ta clé IA dans ⚙ Paramètres pour activer les suggestions.');
      const context = selectedAiContext(await contextForTask(version, entryTitle.trim() || task.title, entrySubtasks), excludedSourceIds);
      const raw = await suggestSubtasks(settings, entryTitle.trim() || task.title, {
        context: { ...context, linkedDocuments: linkedDocuments
          .filter((document) => !excludedSourceIds.includes(document.id))
          .map((document) => document.title) },
        refinement: instruction ? { instruction, previous: entrySubtasks } : undefined,
      });
      if (contextVersion.current !== version) return;
      // Suggérer remplace toujours : un seul geste pour générer et recharger.
      setEntrySubtasks(raw);
      setCanRefineCreator(true);
    } catch (e) {
      if (!(e instanceof AiCancelled)) setSuggestError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };

  const createEntry = async () => {
    const title = entryTitle.trim();
    if (!title || entryBusy) return;
    setEntryBusy(true);
    try {
      const created = await api.createEntryFromTask(task.id, { title, content_md: subtasksMd(entrySubtasks) });
      setCreatingEntry(false);
      setEntrySubtasks('');
      onChanged();
      onOpenDocument(created.id);
    } finally {
      setEntryBusy(false);
    }
  };

  // Procédure tirée de la tâche et de ses documents liés, par l'IA : relue dans
  // la carte, créée à part et jamais liée — terminer la tâche archive ses
  // documents, la procédure disparaîtrait de sa colonne (§31). Un document
  // Google ne donne que son titre (§23).
  const [drafting, setDrafting] = useState(false);
  const [procedureDraft, setProcedureDraft] = useState<DraftedProcedure | null>(null);
  const [draftError, setDraftError] = useState('');
  const draftFromTask = async (instruction?: string) => {
    if (drafting || suggesting) return;
    const version = contextVersion.current;
    setDrafting(true);
    setDraftError('');
    try {
      const settings = aiSettings();
      if (!settings.key) throw new Error('Colle ta clé IA dans ⚙ Paramètres pour activer la création de procédure.');
      const suggestContext = taskSuggestContext(task, tasks, entries, projects);
      const fullContext = await contextForTask(version);
      const context = selectedAiContext(fullContext, excludedSourceIds);
      // Un document lié reste le contexte de la tâche, même d'un autre projet : on l'a lié exprès.
      const sourceDocuments = linkedDocuments.slice(0, MAX_SOURCE_DOCUMENTS);
      const documents = await Promise.all(sourceDocuments.map(async (document) => {
        if (isGoogleDocument(document)) return { id: document.id, title: document.title, date: document.entry_date, google: true, text: '', kind: document.kind };
        const full = await api.entry(document.id);
        if (full.google_sync) throw new Error('Un document lié est devenu un document Google : relance la demande.');
        return {
          id: full.id,
          title: full.title,
          date: full.entry_date,
          text: full.content_json ? richToMarkdown(full.content_json) : full.content_md,
          kind: full.kind,
          google: false,
        };
      }));
      const sourceIds = new Set(sourceDocuments.map((document) => document.id));
      // Les documents liés sont la source intégrale ; les extraits complémentaires
      // ne les répètent pas. Le sélecteur montre aussi les sources intégrales.
      const supplementary = { ...context, sources: context.sources?.filter((source) => !sourceIds.has(source.id)) };
      if (contextVersion.current !== version) return;
      setAiContext({ ...fullContext, sources: [
        ...documents.flatMap((document) => !document.google ? [{ id: document.id, title: document.title, text: document.text, kind: document.kind }] : []),
        ...(fullContext.sources?.filter((source) => !sourceIds.has(source.id)) ?? []),
      ] });
      const proposed = await draftProcedure(settings, {
        origin: 'task',
        title: task.title,
        status: COLUMNS.find((column) => column.id === task.status)?.label,
        project: suggestContext.project,
        documents: documents.filter((document) => !excludedSourceIds.includes(document.id)),
      }, {
        context: supplementary,
        refinement: instruction && procedureDraft ? { instruction, previous: `# ${procedureDraft.title}\n\n${procedureDraft.markdown}` } : undefined,
      });
      if (contextVersion.current === version) setProcedureDraft(proposed);
    } catch (e) {
      if (!(e instanceof AiCancelled)) setDraftError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  // La doc qui aide à faire la tâche : l'IA propose les mots (des titres partent,
  // jamais un contenu), WorkLogs et le partage cherchent. Rien n'est lié sans clic.
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ terms: string[]; documents: FoundDocument[]; sharedNote: string } | null>(null);
  const [findError, setFindError] = useState('');
  const findDocs = async () => {
    if (finding) return;
    setFinding(true);
    setFindError('');
    setFound(null);
    try {
      const suggestContext = taskSuggestContext(task, tasks, entries, projects);
      const settings = aiSettings();
      const terms = await suggestSearchTerms(settings, {
        title: task.title,
        status: COLUMNS.find((column) => column.id === task.status)?.label,
        project: suggestContext.project,
        projectBrief: readProjectAiBrief(task.project_id),
        vocabulary: suggestContext.vocabulary,
        linkedDocuments: linkedDocuments.map((document) => document.title),
      });
      const result = await findDocuments(terms, linkedIds);
      // Arrêtée pendant les recherches : la liste n'est plus attendue.
      if (!settings.signal.aborted) setFound({ terms, ...result });
    } catch (e) {
      if (!(e instanceof AiCancelled)) setFindError((e as Error).message);
    } finally {
      setFinding(false);
    }
  };
  const linkFound = async (entryId: string) => {
    setFindError('');
    try {
      await api.linkTaskDocument(task.id, entryId);
      onChanged();
    } catch (e) {
      setFindError((e as Error).message);
    }
  };
  const projectName = (id: string | null) => projects.find((project) => project.id === id)?.name;
  const project = projects.find((candidate) => candidate.id === task.project_id);

  const entryCreator = creatingEntry ? (
    <form
      className="task-creator linked-entry-creator"
      aria-label={`Créer une entrée liée à ${task.title}`}
      onSubmit={(event) => { event.preventDefault(); void createEntry(); }}
    >
      <strong>Nouvelle entrée liée à cette tâche</strong>
      <label className="task-creator-wide">Titre de l’entrée liée
        <input aria-label="Titre de l’entrée liée" autoFocus disabled={suggesting || entryBusy} value={entryTitle} onChange={(e) => setEntryTitle(e.target.value)} />
      </label>
      <div className="task-creator-wide">
        <div className="subtasks-head">
          <span>Sous-tâches, une par ligne</span>
          {entrySubtasks.trim() && (
            <button
              className="ghost"
              type="button"
              disabled={suggesting || entryBusy}
              aria-label="Effacer la suggestion"
              onClick={() => setEntrySubtasks('')}
            >
              Effacer
            </button>
          )}
        </div>
        <textarea
          aria-label="Sous-tâches de l’entrée liée, une par ligne"
          rows={4}
          placeholder={'Relire le devis\nAppeler le client'}
          value={entrySubtasks}
          disabled={suggesting || entryBusy}
          onChange={(e) => setEntrySubtasks(e.target.value)}
        />
      </div>
      {entrySubtasks.trim() && canRefineCreator && <AiRefinement busy={suggesting || entryBusy || drafting} onRefine={(instruction) => void suggestForCreator(instruction)} />}
      {aiContext && <AiContextDetails context={aiContext} excludedIds={excludedSourceIds} onExcludedChange={excludeSources} />}
      <div className="task-creator-actions">
        <button
          className={'ghost' + (suggesting ? ' ai-busy' : '')}
          type="button"
          disabled={suggesting || entryBusy}
          title="Remplace les sous-tâches par une nouvelle suggestion (envoie le titre et son contexte au service IA configuré en Paramètres)"
          onClick={() => void suggestForCreator()}
        >
          {suggesting ? 'Suggestion…' : '✨ Suggérer'}
        </button>
        {suggesting && <button className="ghost" type="button" aria-label="Arrêter la demande IA" onClick={stopAi}>Arrêter</button>}
        <button className="task-primary" type="submit" disabled={entryBusy || !entryTitle.trim()}>
          {entryBusy ? 'Création…' : 'Créer et ouvrir'}
        </button>
        <button className="ghost" type="button" disabled={entryBusy} onClick={() => setCreatingEntry(false)}>
          Annuler
        </button>
      </div>
      {suggestError && <p className="error" role="alert">{suggestError}</p>}
    </form>
  ) : null;
  const entryButton = (
    <button className="card-link" type="button" aria-label="Créer une entrée liée" title="Créer une entrée de journal liée à cette tâche" onClick={startEntryCreator}>
      <span aria-hidden="true">＋ </span>Entrée liée
    </button>
  );
  const linkButton = (
    <button className="card-link" type="button" aria-label="Lier des documents" title="Lier des entrées ou des documents Google existants" onClick={startLinking}>
      <span aria-hidden="true">＋ </span>Documents
    </button>
  );
  const aiMenu = (
    <AiMenu label="Assistance IA de la tâche" className="card-link" busy={drafting ? 'Rédaction…' : finding ? 'Recherche…' : null} onCancel={stopAi}>
      <button
        role="menuitem"
        type="button"
        disabled={drafting}
        title="Rédige une procédure réutilisable à partir de cette tâche et de ses documents liés (envoyés au service IA configuré en Paramètres) ; à relire avant de la créer"
        onClick={() => void draftFromTask()}
      >
        Créer une procédure
      </button>
      <button
        role="menuitem"
        type="button"
        disabled={finding}
        title="Envoie au service IA configuré en Paramètres le titre de la tâche, son projet et les titres de ses documents liés (jamais leur contenu), puis cherche dans les notes et procédures de WorkLogs et dans les noms de fichiers du dossier partagé"
        onClick={() => void findDocs()}
      >
        Trouver la doc
      </button>
    </AiMenu>
  );
  const finder = found ? (
    <section className="document-linker" aria-label="Documents trouvés">
      <p className="ai-hint">Cherché avec : {found.terms.join(', ')}</p>
      {found.documents.length === 0 ? (
        <p className="empty">Aucun document trouvé avec ces mots.</p>
      ) : (
        <ul className="document-picker">
          {found.documents.map((document) => {
            const title = document.kind === 'shared' ? document.file.name : document.entry.title;
            // Le dossier d'un fichier du partage ; le projet d'une entrée qui n'est pas celui de la tâche.
            const where = document.kind === 'shared' ? document.file.dir
              : document.entry.project_id !== task.project_id ? projectName(document.entry.project_id) : '';
            return (
              <li className="task-document doc-found" key={document.kind === 'shared' ? 'partage:' + document.file.path : document.entry.id}>
                <span className="picker-source">{document.kind === 'shared' ? 'Partage' : document.kind === 'procedure' ? 'Procédure' : 'Note'}</span>
                <span className="task-document-open">
                  <span className="task-document-title" title={title}>{title}</span>
                  <span className="task-document-meta">{where ? `${where} · ` : ''}trouvé avec : {document.terms.join(', ')}</span>
                </span>
                <span className="document-linker-actions">
                  <button
                    className="ghost"
                    type="button"
                    aria-label={`Ouvrir ${title}`}
                    onClick={() => (document.kind === 'shared' ? onOpenShared(document.file.path) : onOpenDocument(document.entry.id, document.entry.project_id))}
                  >
                    Ouvrir
                  </button>
                  {document.kind !== 'shared' && (linkedIds.has(document.entry.id) ? (
                    <span className="picker-source">Liée</span>
                  ) : (
                    <button className="ghost" type="button" aria-label={`Lier ${title} à la tâche`} onClick={() => void linkFound(document.entry.id)}>
                      Lier
                    </button>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {found.sharedNote && <p className="ai-hint">{found.sharedNote}</p>}
      <div className="card-actions">
        <button className="ghost" type="button" onClick={() => setFound(null)}>
          Fermer
        </button>
      </div>
    </section>
  ) : null;
  const procedureCreator = procedureDraft ? (
    <ProcedureDraft
      draft={procedureDraft}
      projectId={task.project_id}
      busy={drafting}
      onRefresh={(instruction) => void draftFromTask(instruction)}
      onCancel={stopAi}
      onCreated={(procedure) => {
        setProcedureDraft(null);
        onProcedureCreated(procedure);
      }}
      onClose={() => setProcedureDraft(null)}
    />
  ) : null;

  const documentControls = (
    <div className="card-documents">
      {linkedDocuments.length > 0 && (
        <div className="task-documents" aria-label={`Documents liés à ${task.title}`}>
          {done && (
            <button
              className="history-toggle"
              type="button"
              aria-expanded={docsExpanded}
              aria-label={`${docsExpanded ? 'Masquer' : 'Afficher'} l’historique des documents de ${task.title}`}
              onClick={() => setDocsOverride((current) => !(current ?? !done))}
            >
              {docsExpanded
                ? 'Masquer l’historique'
                : `Historique · ${linkedDocuments.length} document${linkedDocuments.length > 1 ? 's' : ''}`}
            </button>
          )}
          {docsExpanded && linkedDocuments.map((document) => {
            const google = isGoogleDocument(document);
            return (
              <div className="task-document" key={document.id}>
                <span className={'task-document-icon' + (google ? ' is-google' : '')} aria-hidden="true">
                  {google ? 'G' : '📄'}
                </span>
                <button
                  className="task-document-open"
                  type="button"
                  aria-label={`Ouvrir ${document.title}`}
                  title={`${document.title} — ${google ? 'Google' : 'local'} · ${dayLabel(document.entry_date)}`}
                  onClick={() => onOpenDocument(document.id)}
                >
                  <span className="task-document-title">{document.title}</span>
                </button>
                <button
                  className="icon"
                  type="button"
                  aria-label={`Retirer ${document.title} de ${task.title}`}
                  title={`Retirer ${document.title}`}
                  onClick={() => void unlinkDocument(document.id)}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      {linking ? (
        <div className="document-linker" aria-label={`Lier des documents à ${task.title}`}>
          <div className="document-linker-head">
            <strong>Lier des documents</strong>
            <span className="document-linker-count">
              {selected.length > 0 ? `${selected.length} sélectionné${selected.length > 1 ? 's' : ''}` : `${availableDocuments.length} disponible${availableDocuments.length > 1 ? 's' : ''}`}
            </span>
          </div>
          {availableDocuments.length > 0 && (
            <input
              type="search"
              aria-label={`Rechercher un document à lier à ${task.title}`}
              placeholder="Rechercher…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          {availableDocuments.length === 0 ? (
            <p className="empty">Tous les documents sont déjà liés.</p>
          ) : visibleDocuments.length === 0 ? (
            <p className="empty">Aucun document ne correspond à « {filter.trim()} ».</p>
          ) : (
            <ul className="document-picker">
              {visibleDocuments.map((entry) => {
                const checked = selected.includes(entry.id);
                const google = isGoogleDocument(entry);
                return (
                  <li key={entry.id}>
                    <label className={'picker-row' + (checked ? ' is-checked' : '')}>
                      <input
                        type="checkbox"
                        checked={checked}
                        aria-label={`Lier ${entry.title} à ${task.title}`}
                        onChange={() => toggleSelected(entry.id)}
                      />
                      <span className="picker-title">{entry.title}</span>
                      <span className={'picker-source' + (google ? ' is-google' : '')}>
                        {google ? 'Google' : 'local'}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="document-linker-actions">
            {visibleDocuments.length > 1 && (
              <>
                <button
                  className="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => setSelected(visibleDocuments.map((entry) => entry.id))}
                >
                  Tout sélectionner
                </button>
                <button className="ghost" type="button" disabled={busy || selected.length === 0} onClick={() => setSelected([])}>
                  Effacer
                </button>
              </>
            )}
          </div>
          <div className="card-actions">
            <button
              className="ghost primary"
              type="button"
              disabled={selected.length === 0 || busy}
              onClick={() => void linkSelected()}
            >
              {busy ? 'Liaison…' : selected.length > 0 ? `Relier la sélection (${selected.length})` : 'Relier la sélection'}
            </button>
            <button className="ghost" type="button" disabled={busy} onClick={() => setLinking(false)}>
              Annuler
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (editing) {
    return (
      <div className="card is-editing">
        <input
          aria-label="Titre de la tâche"
          disabled={editSaving}
          autoFocus
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          onKeyDown={(e) => {
            if (editSaving) return;
            if (e.key === 'Enter') void saveEdit();
            if (e.key === 'Escape') onEditDone();
          }}
        />
        <input
          type="date"
          aria-label="Échéance"
          disabled={editSaving}
          value={form.due_date}
          onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))}
        />
        <label className="priority-field">
          Statut
          <select
            aria-label="Statut"
            disabled={editSaving}
            value={form.status}
            onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as Status }))}
          >
            {COLUMNS.map((column) => (
              <option key={column.id} value={column.id}>
                {column.label}
              </option>
            ))}
          </select>
        </label>
        <label className="priority-field">
          Priorité
          <select
            aria-label="Priorité"
            disabled={editSaving}
            value={form.priority}
            onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as Priority }))}
          >
            {PRIORITIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <CategoryPicker categories={categories} projectId={task.project_id || ''} value={form.category_id} label="Catégorie de la tâche" disabled={editSaving} onChange={(value) => setForm((current) => ({ ...current, category_id: value || '' }))} />
        <div className="card-actions">
          <button className="ghost" type="button" disabled={editSaving} onClick={() => void saveEdit()}>
            Enregistrer
          </button>
          <button className="ghost" type="button" disabled={editSaving} onClick={onEditDone}>
            Annuler
          </button>
        </div>
        {editError && <p className="error" role="alert">{editError}</p>}
        {documentControls}
        {!linking && <div className="card-links">{linkButton}</div>}
      </div>
    );
  }

  return (
    <div
      className={'card' + (task.pinned ? ' is-pinned' : '') + (done ? ' is-done' : '')}
      draggable={draggable}
      onDragStart={draggable ? (e) => e.dataTransfer.setData(DRAG_TYPE, task.id) : undefined}
      onDrop={onDrop}
    >
      <div className="card-top">
        <input
          className="card-check"
          type="checkbox"
          checked={done}
          aria-label={done ? `Rouvrir ${task.title}` : `Terminer ${task.title}`}
          onChange={() => void patch({ status: done ? 'todo' : 'done' })}
        />
        <button className="card-title" type="button" onClick={onEdit} title="Modifier">
          {task.title}
        </button>
        <span className="card-top-actions">
          {/* Sans glisser-déposer : un clic met en cours ou remet à faire, la carte va au bas de sa colonne (comme « Statut »). */}
          {!done && (
            <button
              className={'icon doing' + (task.status === 'doing' ? ' is-on' : '')}
              type="button"
              aria-label={task.status === 'doing' ? `Remettre à faire ${task.title}` : `Mettre en cours ${task.title}`}
              aria-pressed={task.status === 'doing'}
              title={task.status === 'doing' ? 'Remettre à faire' : 'Mettre en cours'}
              onClick={async () => { await api.moveTask(task.id, task.status === 'doing' ? 'todo' : 'doing', Number.MAX_SAFE_INTEGER); onChanged(); }}
            >
              ▶
            </button>
          )}
          <button
            className={'icon pin' + (task.pinned ? ' is-on' : '')}
            type="button"
            aria-label={task.pinned ? `Désépingler ${task.title}` : `Épingler ${task.title}`}
            aria-pressed={!!task.pinned}
            title={task.pinned ? 'Désépingler' : 'Épingler'}
            onClick={() => void patch({ pinned: task.pinned ? 0 : 1 })}
          >
            ★
          </button>
          <button
            className="icon"
            type="button"
            aria-label={`Supprimer ${task.title}`}
            title="Supprimer"
            onClick={async () => {
              if (!confirm(`Supprimer « ${task.title} » ?`)) return;
              await api.deleteTask(task.id);
              onChanged();
            }}
          >
            ✕
          </button>
        </span>
      </div>
      <div className="card-meta">
        {/* « Tout » mêle les projets : chaque carte dit le sien, dans sa couleur. */}
        {showProject && project && (
          <span className="card-project" style={{ '--project': project.color } as CSSProperties} title={`Projet ${project.name}`}>
            <span className="dot" aria-hidden="true" />
            {project.name}
          </span>
        )}
        {showStatus && task.status === 'doing' && (
          <span className="status-doing" title="En cours">
            <span className="dot" aria-hidden="true" />
            En cours
          </span>
        )}
        <CategoryBadge categories={categories} categoryId={task.category_id} />
        {/* « Normale » sur chaque carte n'apprenait rien : seul l'écart se signale. */}
        {task.priority && task.priority !== 'normal' && (
          <span
            className={'priority is-' + task.priority}
            title={`Priorité ${priorityLabel(task.priority).toLowerCase()}`}
          >
            <span aria-hidden="true">{task.priority === 'high' ? '▲ ' : '▼ '}</span>
            {priorityLabel(task.priority)}
          </span>
        )}
        {task.due_date && (
          <span className={'due' + (late ? ' is-late' : '')} title={late ? 'En retard' : 'Échéance'}>
            <span aria-hidden="true">📅 </span>
            {dayLabel(task.due_date)}
          </span>
        )}
        {proposal && proposal.priority !== task.priority && (
          <span className={'priority is-proposed is-' + proposal.priority} title="Priorité proposée par l’IA, écrite à « Appliquer »">
            <span aria-hidden="true">✨ </span>
            {priorityLabel(proposal.priority)} proposée
          </span>
        )}
      </div>
      {proposal?.reason && <p className="ai-reason">{proposal.reason}</p>}
      {documentControls}
      {entryCreator}
      {aiContext && !creatingEntry && <AiContextDetails context={aiContext} excludedIds={excludedSourceIds} onExcludedChange={excludeSources} />}
      {procedureCreator}
      {draftError && <p className="error" role="alert">{draftError}</p>}
      {finder}
      {findError && <p className="error" role="alert">{findError}</p>}
      {!linking && !creatingEntry && !procedureDraft && !found && <div className="card-links">{linkButton}{entryButton}{aiMenu}</div>}
    </div>
  );
}

function isGoogleDocument(entry: EntrySummary) {
  return Boolean(entry.google_document_id || entry.google_tab_id);
}
