import { memo, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { COLUMNS, PRIORITIES, TASK_VIEWS, api, dayLabel, isOverdue, priorityLabel, subtasksMd, todayISO, type Category, type Entry, type EntrySummary, type Priority, type Project, type Status, type Task, type TaskView } from '../lib';
import { draftProcedure, MAX_SOURCE_DOCUMENTS, readAiSettings, suggestSearchTerms, suggestSubtasks, taskSuggestContext, type AiWorkContext, type DraftedProcedure } from '../ai-suggest';
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
type TaskEditForm = { title: string; due_date: string; priority: Priority; category_id: string; category_base: string };
const taskForm = (task: Task): TaskEditForm => ({ title: task.title, due_date: task.due_date ?? '', priority: task.priority ?? 'normal', category_id: task.category_id || '', category_base: task.category_id || '' });

/** Mémoïsé : la recherche de l'en-tête se redessine à chaque frappe, pas les cartes. */
export const TaskBoard = memo(function TaskBoard({
  tasks,
  entries,
  projectId,
  projects,
  categories = [],
  categoryId = '',
  grouped = false,
  view,
  onView,
  onOpenDocument,
  onOpenShared,
  onProcedureCreated,
  onChanged,
}: {
  tasks: Task[];
  entries: EntrySummary[];
  projectId: string;
  projects: Project[];
  categories?: Category[];
  categoryId?: string;
  grouped?: boolean;
  view: TaskView | null;
  onView: (view: TaskView | null) => void;
  /** `projectId` : projet connu d'un document absent de l'état filtré, que l'ouverture suit. */
  onOpenDocument: (entryId: string, projectId?: string | null) => void;
  onOpenShared: (path: string) => void;
  /** Procédure tirée d'une tâche par l'IA, créée : l'app l'ouvre. */
  onProcedureCreated: (procedure: Entry) => void;
  onChanged: () => void;
}) {
  const [over, setOver] = useState<Status | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
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
      </div>

      {/* Seule la liste défile : saisie et vues restent en tête, sans jamais passer
          devant les cartes (elles étaient collantes, et les cartes défilaient dessous). */}
      <div className="board-lists">
        {active && counts.get(active.id) === 0 && <p className="empty">{active.empty}</p>}
        {COLUMNS.map((column) => {
          const inColumn = tasks.filter((t) => t.status === column.id);
          const shown = active ? inColumn.filter((task) => active.match(task, today)) : inColumn;
          // Une vue ne garde que les colonnes où elle trouve quelque chose.
          if (active && shown.length === 0) return null;
          return (
            <div
              key={column.id}
              className={'column' + (over === column.id ? ' is-over' : '')}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(column.id);
              }}
              onDragLeave={() => setOver((c) => (c === column.id ? null : c))}
              onDrop={(e) => drop(e, column.id, Number.MAX_SAFE_INTEGER)}
            >
              <h2>
                {column.label} <span className="count">{shown.length}</span>
              </h2>
              <ul>
                {(grouped ? groupByCategory(shown, categories, projects) : [{ id: '', label: '', items: shown }]).map((group) => {
                  const cards = group.items.map((task) => (
                    <li key={task.id}>
                      <TaskCard
                        task={task}
                        tasks={tasks}
                        entries={entries}
                        projects={projects}
                        categories={categories}
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
                        onDrop={(e) => drop(e, column.id, task.position)}
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
              {inColumn.length === 0 && <p className="empty-column">Déposer ici</p>}
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
  editing: boolean;
  form: TaskEditForm;
  onFormChange: Dispatch<SetStateAction<TaskEditForm>>;

  onEdit: () => void;
  onEditDone: () => void;
  onOpenDocument: (entryId: string, projectId?: string | null) => void;
  onOpenShared: (path: string) => void;
  onProcedureCreated: (procedure: Entry) => void;
  onChanged: () => void;
  onDrop: (event: React.DragEvent) => void;
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
      await patch({ title: form.title.trim(), due_date: form.due_date || null, priority: form.priority, category_id: form.category_id || null });
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

  const contextForTask = async (version: number, title = task.title) => {
    const context = await loadAiContext({
      projectId: task.project_id,
      title,
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
      const settings = readAiSettings();
      if (!settings.key) throw new Error('Colle ta clé IA dans ⚙ Paramètres pour activer les suggestions.');
      const context = selectedAiContext(await contextForTask(version, entryTitle.trim() || task.title), excludedSourceIds);
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
      setSuggestError((e as Error).message);
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
      const settings = readAiSettings();
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
      setAiContext({ ...context, sources: [
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
      setDraftError((e as Error).message);
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
      const terms = await suggestSearchTerms(readAiSettings(), {
        title: task.title,
        status: COLUMNS.find((column) => column.id === task.status)?.label,
        project: suggestContext.project,
        projectBrief: readProjectAiBrief(task.project_id),
        vocabulary: suggestContext.vocabulary,
        linkedDocuments: linkedDocuments.map((document) => document.title),
      });
      setFound({ terms, ...(await findDocuments(terms, linkedIds)) });
    } catch (e) {
      setFindError((e as Error).message);
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
          className="ghost"
          type="button"
          disabled={suggesting || entryBusy}
          title="Remplace les sous-tâches par une nouvelle suggestion (envoie le titre et son contexte au service IA configuré en Paramètres)"
          onClick={() => void suggestForCreator()}
        >
          {suggesting ? 'Suggestion…' : '✨ Suggérer'}
        </button>
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
    <AiMenu label="Assistance IA de la tâche" className="card-link" busy={drafting ? 'Rédaction…' : finding ? 'Recherche…' : null}>
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
      draggable
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, task.id)}
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
      </div>
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
