import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { api, dayLabel, isFollowed, isOverdue, overviewOrder, priorityLabel, projectProgress, todayISO, type EntrySummary, type Project, type Status, type Task } from '../lib';
import { flushPendingSaves } from '../autosave';
import { FollowUpPanel } from './FollowUpPanel';
import { OverviewAiActions } from './OverviewAiActions';
import { OverviewFollowUpPicker } from './OverviewFollowUpPicker';
import { OverviewEntryActions, OverviewTaskActions } from './OverviewItemActions';

/** Au-delà, les autres tâches ouvertes sont comptées (« +N ») : la piste tient sur une ligne jusqu'à 360 px. */
export const LANE_NODES = 10;

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

/**
 * Vue d'ensemble des projets, au centre : une voie par projet, à la manière d'un git dont
 * l'historique est replié — les terminées comptées dans une pastille, un nœud par tâche
 * ouverte (plein pour celle en cours, le HEAD), une barre d'avancement et la dernière note.
 */
export function ProjectOverview({ projects, tasks, entries, onProject, onTask, onEntry, onClose, onChanged, advice, missingOpen = 0, missingTasks = 0, missingEntries = 0 }: {
  projects: Project[];
  tasks: Task[];
  entries: EntrySummary[];
  /** Le nom d'un projet le filtre. */
  onProject: (id: string) => void;
  /** Ouvre une entrée liée, ou la carte de la tâche s'il n'y a aucun lien. */
  onTask: (task: Task) => void;
  onEntry: (entry: EntrySummary) => void;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  advice?: ReactNode;
  /** Nombre de tâches absentes de l’état global limité par le serveur. */
  missingOpen?: number;
  missingTasks?: number;
  missingEntries?: number;
}) {
  const [filter, setFilter] = useState<'todo' | 'doing' | 'open' | 'done'>('todo');
  const [entryFilter, setEntryFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [entryQuery, setEntryQuery] = useState('');
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const submitting = useRef(false);
  const today = todayISO();
  const lanes = projectProgress(projects, tasks, entries, today);
  const totals = lanes.reduce((sum, lane) => ({ open: sum.open + lane.open.length, done: sum.done + lane.done, late: sum.late + lane.late }), { open: 0, done: 0, late: 0 });
  const openTasks = overviewOrder(tasks.filter((task) => task.status !== 'done'));
  const doneTasks = overviewOrder(tasks.filter((task) => task.status === 'done'));
  const shownTasks = filter === 'done' ? doneTasks : filter === 'open' ? openTasks : openTasks.filter((task) => task.status === filter);
  const todoCount = openTasks.filter((task) => task.status === 'todo').length;
  const doingCount = openTasks.length - todoCount;
  const followedTasks = tasks.filter(isFollowed);
  const followedEntries = entries.filter(isFollowed);
  const head = useRef<HTMLHeadingElement>(null);
  const followHead = useRef<HTMLHeadingElement>(null);
  const taskHead = useRef<HTMLHeadingElement>(null);
  const journalHead = useRef<HTMLElement>(null);
  const notes = entries.filter((entry) => entry.kind === 'note').sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.updated_at.localeCompare(a.updated_at));
  const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
  const shownEntries = notes.filter((entry) => (entryFilter === 'all' || Boolean(entry.archived) === (entryFilter === 'archived'))
    && fold(entry.title + ' ' + (projects.find((project) => project.id === entry.project_id)?.name ?? '')).includes(fold(entryQuery.trim())));
  const followCount = followedTasks.length + followedEntries.length;
  const lastFollowCount = useRef(followCount);
  useEffect(() => {
    // « Désactiver » retire la carte qui avait le focus : il revient au titre de la
    // liste, ou à celui de la vue si c'était le dernier suivi.
    if (followCount < lastFollowCount.current && document.activeElement === document.body) {
      (followCount > 0 ? followHead.current : head.current)?.focus({ preventScroll: true });
    }
    lastFollowCount.current = followCount;
  }, [followCount]);
  const run = async (key: string, action: () => Promise<unknown>, done: string, fallback?: HTMLElement | null) => {
    if (submitting.current) return false;
    submitting.current = true;
    const previousFocus = document.activeElement;
    let actionAttempted = false;
    let actionConfirmed = false;
    setBusy(key);
    setError('');
    setFeedback('');
    try {
      await flushPendingSaves();
      actionAttempted = true;
      await action();
      actionConfirmed = true;
      await onChanged();
      setFeedback(done);
      return true;
    } catch (e) {
      let message = (e as Error).message || 'Impossible d’enregistrer la modification.';
      // Une réponse perdue peut cacher une écriture réussie. Relire remet alors
      // le vrai statut et les archives à l'écran sans rejouer la mutation.
      if (actionAttempted && !actionConfirmed) {
        try { await onChanged(); } catch (cause) { message += ` ${(cause as Error).message || 'Impossible de relire les données.'}`; }
      }
      setError(message);
      return false;
    } finally {
      submitting.current = false;
      setBusy('');
      if (fallback && previousFocus instanceof HTMLElement) requestAnimationFrame(() => {
        if (document.activeElement === document.body && previousFocus !== document.body) fallback.focus({ preventScroll: true });
      });
    }
  };
  const changeTaskStatus = (task: Task, status: Status) => {
    if (status === task.status) return;
    const inList = document.activeElement?.closest('.overview-task');
    const message = status === 'done' ? `« ${task.title} » validée.${task.documents.length ? ' Les documents liés sont archivés.' : ''}`
      : status === 'doing' ? `« ${task.title} » passée en cours.`
      : task.status === 'done' ? `« ${task.title} » rouverte.` : `« ${task.title} » remise à faire.`;
    void run('task:' + task.id, () => api.moveTask(task.id, status, Number.MAX_SAFE_INTEGER), message, inList ? taskHead.current : followHead.current);
  };
  const changeEntryArchive = (entry: EntrySummary) => {
    const inJournal = document.activeElement?.closest('.overview-entry');
    void run('entry:' + entry.id, () => api.updateEntry(entry.id, { archived: entry.archived ? 0 : 1 }), `« ${entry.title} » ${entry.archived ? 'désarchivée' : 'archivée'}.`, inJournal ? journalHead.current : followHead.current);
  };
  const addTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    if (await run('new', () => api.createTask({ title: value, project_id: projectId || null }), 'Tâche ajoutée.')) {
      setTitle('');
      setFilter('todo');
    }
  };
  const nodeLabel = (task: Task) => {
    const late = isOverdue(task, today);
    const days = task.due_date ? Math.round((Date.parse(today) - Date.parse(task.due_date)) / 864e5) : 0;
    return `${task.title} — ${task.status === 'doing' ? 'en cours' : 'à faire'}`
      + (late ? ` · en retard de ${plural(days, 'jour', 'jours')}` : task.due_date ? ` · échéance ${dayLabel(task.due_date)}` : '')
      + (task.pinned ? ' · épinglée' : '');
  };

  return (
    <section className="editor overview" aria-label="Vue d’ensemble des projets">
      <div className="overview-head">
        <div className="overview-head-title">
          <h2 ref={head} tabIndex={-1}>Vue d’ensemble</h2>
          <p className="ai-hint">
            {plural(projects.length, 'projet', 'projets')} · {plural(totals.open, 'tâche ouverte', 'tâches ouvertes')} · {plural(totals.done, 'terminée', 'terminées')}
            {totals.late > 0 && <> · <b className="late">{totals.late} en retard</b></>}
          </p>
        </div>
        <div className="overview-head-actions">
          <button className="ghost no-print" type="button" aria-label="Fermer la vue d’ensemble" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
      {(missingOpen > 0 || missingTasks > 0) && <p className="notice" role="status">
        {missingOpen > 0 && <>{missingOpen} tâche{missingOpen > 1 ? 's' : ''} ouverte{missingOpen > 1 ? 's' : ''} manquante{missingOpen > 1 ? 's' : ''} : la liste est incomplète. </>}
        {missingTasks > 0 && <>L’avancement des projets est incomplet : {missingTasks} tâche{missingTasks > 1 ? 's' : ''} non chargée{missingTasks > 1 ? 's' : ''}.</>}
      </p>}
      <div className="overview-work no-print" aria-busy={Boolean(busy)}>
        <OverviewAiActions tasks={tasks} entries={entries} projects={projects} missingOpen={missingOpen} missingTasks={missingTasks} missingEntries={missingEntries} onChanged={onChanged} onTask={onTask} onShowFollowUps={() => {
          followHead.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
          followHead.current?.focus({ preventScroll: true });
        }} />
        <OverviewFollowUpPicker tasks={tasks} entries={entries} projects={projects} onChanged={onChanged} />
        <div className="overview-action-feedback">
          <span className={'overview-status' + (busy ? ' is-busy' : '')} role="status" aria-live="polite" aria-atomic="true">{busy ? 'Enregistrement…' : feedback}</span>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        {followCount > 0 && <section className="overview-follow-ups no-print" aria-label="Bilans et suivis IA">
          <div className="overview-section-head">
            <h3 ref={followHead} tabIndex={-1}>Suivis IA</h3>
            <span>{plural(followCount, 'élément suivi', 'éléments suivis')}</span>
          </div>
          <ul>
            {followedTasks.map((task) => <li key={'task-' + task.id}>
              <div className="overview-follow-up-title"><span>Tâche</span><button className="overview-task-title" type="button" aria-label={`Ouvrir la tâche ${task.title}`} onClick={() => onTask(task)}>{task.title}</button></div>
              <OverviewTaskActions task={task} disabled={Boolean(busy)} onStatus={changeTaskStatus} />
              <FollowUpPanel kind="task" item={task} compact />
            </li>)}
            {followedEntries.map((entry) => <li key={'entry-' + entry.id}>
              <div className="overview-follow-up-title"><span>{entry.kind === 'procedure' ? 'Procédure' : 'Entrée'}{entry.archived ? ' · Archivée' : ''}</span><button className="overview-task-title" type="button" aria-label={`Ouvrir l’entrée ${entry.title}`} onClick={() => onEntry(entry)}>{entry.title}</button></div>
              <OverviewEntryActions entry={entry} disabled={Boolean(busy)} onArchive={changeEntryArchive} />
              <FollowUpPanel kind="entry" item={entry} compact />
            </li>)}
          </ul>
        </section>}
        <form className="overview-add" onSubmit={(event) => void addTask(event)}>
          <input className="overview-add-title" aria-label="Nouvelle tâche dans la vue d’ensemble" placeholder="Ajouter une tâche…" disabled={Boolean(busy)} value={title} onChange={(event) => setTitle(event.target.value)} />
          <select aria-label="Projet de la nouvelle tâche" title="Projet de la nouvelle tâche" disabled={Boolean(busy)} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Sans projet</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <button className="task-primary" type="submit" disabled={Boolean(busy) || !title.trim()}>{busy === 'new' ? 'Ajout…' : 'Ajouter'}</button>
        </form>
        <div className="overview-list-head">
          <h3 ref={taskHead} tabIndex={-1}>Tâches</h3>
          <div className="overview-filters" role="group" aria-label="Filtrer les tâches de la vue d’ensemble">
            {([['todo', 'À faire', todoCount], ['doing', 'En cours', doingCount], ['open', 'Ouvertes', openTasks.length], ['done', 'Terminées', doneTasks.length]] as const).map(([value, label, count]) => (
              <button key={value} className={'chip' + (filter === value ? ' is-on' : '')} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span className="count">{count}</span></button>
            ))}
          </div>
        </div>
        {shownTasks.length === 0 ? <p className="empty">{filter === 'todo' ? 'Aucune tâche à faire.' : filter === 'doing' ? 'Aucune tâche en cours.' : filter === 'done' ? 'Aucune tâche terminée.' : 'Aucune tâche ouverte.'}</p> : (
          <ul className="overview-tasks" aria-label="Liste des tâches de la vue d’ensemble">
            {shownTasks.map((task) => {
              const late = isOverdue(task, today);
              return (
                <li className={'overview-task' + (task.status === 'doing' ? ' is-doing' : task.status === 'done' ? ' is-done' : '') + (late ? ' is-late' : '')} key={task.id} aria-busy={busy === 'task:' + task.id}>
                  <div className="overview-task-main">
                    <button className="overview-task-title" type="button" onClick={() => onTask(task)}>{task.title}</button>
                    <span className="overview-task-meta">
                      <span className="overview-task-project">{projects.find((project) => project.id === task.project_id)?.name ?? 'Sans projet'}</span>
                      <span className={'overview-task-status is-' + task.status}>{task.status === 'doing' ? 'En cours' : task.status === 'done' ? 'Terminée' : 'À faire'}</span>
                      <span className={'overview-task-priority is-' + task.priority}>{priorityLabel(task.priority)}</span>
                      {task.due_date && <span className={'overview-task-due' + (late ? ' is-late' : '')}>{late ? 'En retard' : `Échéance ${dayLabel(task.due_date)}`}</span>}
                      {task.pinned > 0 && <span className="overview-task-pin">Épinglée</span>}
                      {isFollowed(task) && <span className="overview-task-follow" title="Suivi IA actif">✦ Suivi IA</span>}
                    </span>
                  </div>
                  <OverviewTaskActions task={task} disabled={Boolean(busy)} onStatus={changeTaskStatus} />
                  <details className="overview-task-details"><summary aria-label={`Détails de ${task.title}`}>Détails</summary><label>Projet
                    <select aria-label={`Projet de ${task.title}`} title={task.category_id ? 'Changer de projet retire la catégorie actuelle' : 'Affecter à un projet'} disabled={Boolean(busy)} value={task.project_id ?? ''} onChange={(event) => {
                      const nextProject = event.target.value || null;
                      void run('task:' + task.id, () => api.updateTask(task.id, { project_id: nextProject }), 'Projet mis à jour.');
                    }}>
                      <option value="">Sans projet</option>
                      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                  </label></details>
                </li>
              );
            })}
          </ul>
        )}
        <details className="overview-journal">
          <summary ref={journalHead}>Entrées du journal ({notes.length})</summary>
          <section aria-label="Entrées du journal">
            <div className="overview-journal-head">
              <p className="ai-hint">Archive les entrées traitées pour les retirer du journal actif.</p>
              <div className="overview-journal-filters">
                <input type="search" aria-label="Rechercher dans les entrées du journal" placeholder="Rechercher une entrée, un projet…" value={entryQuery} onChange={(event) => setEntryQuery(event.target.value)} />
                <select aria-label="Afficher les entrées du journal" value={entryFilter} onChange={(event) => setEntryFilter(event.target.value as typeof entryFilter)}><option value="active">Actives</option><option value="archived">Archivées</option><option value="all">Toutes</option></select>
              </div>
            </div>
            {missingEntries > 0 && <p className="notice">Cette liste ne montre que les entrées chargées : {missingEntries} élément{missingEntries > 1 ? 's' : ''} manque{missingEntries > 1 ? 'nt' : ''} dans la vue.</p>}
            {shownEntries.length ? <ul className="overview-entries" aria-label="Liste des entrées du journal">{shownEntries.map((entry) => <li className="overview-entry" key={entry.id} aria-busy={busy === 'entry:' + entry.id}>
              <div className="overview-entry-main"><button className="overview-task-title" type="button" aria-label={`Ouvrir l’entrée ${entry.title}`} onClick={() => onEntry(entry)}>{entry.title}</button><span className="overview-entry-meta"><time dateTime={entry.entry_date}>{dayLabel(entry.entry_date)}</time><span>{projects.find((project) => project.id === entry.project_id)?.name ?? 'Sans projet'}</span>{entry.archived > 0 && <span>Archivée</span>}{isFollowed(entry) && <span className="overview-task-follow">✦ Suivi IA</span>}</span></div>
              <OverviewEntryActions entry={entry} disabled={Boolean(busy)} onArchive={changeEntryArchive} />
            </li>)}</ul> : <p className="empty">{entryQuery ? 'Aucune entrée trouvée.' : entryFilter === 'archived' ? 'Aucune entrée archivée.' : entryFilter === 'active' ? 'Aucune entrée active.' : 'Aucune entrée de journal.'}</p>}
          </section>
        </details>
        {advice && <details className="overview-more-advice no-print"><summary>Conseils détaillés avec l’IA</summary><div role="group" aria-label="Conseils IA">{advice}</div></details>}
      </div>
      <h3 className="overview-progress-title">Avancement des projets</h3>
      {lanes.length === 0 ? (
        <p className="empty">Aucun projet ni tâche : crée un projet dans « Gérer » ou ajoute une tâche ci-dessus.</p>
      ) : (
        <ol className="lanes">
          {lanes.map((lane) => {
            const name = lane.project?.name ?? 'Sans projet';
            const total = lane.open.length + lane.done;
            const percent = total ? Math.round((lane.done / total) * 100) : 0;
            const nodes = lane.open.slice(0, LANE_NODES);
            const more = lane.open.length - nodes.length;
            const heads = lane.open.filter((task) => task.status === 'doing');
            return (
              <li
                key={lane.project?.id ?? ''}
                className="lane"
                style={{ '--project': lane.project?.color ?? 'var(--muted)' } as CSSProperties}
                aria-label={`${name} : ${plural(lane.done, 'terminée', 'terminées')} sur ${total}, ${lane.doing} en cours, ${lane.todo} à faire`}
              >
                <div className="lane-id">
                  {lane.project ? (
                    <button className="lane-name" type="button" aria-label={`Filtrer sur ${name}`} onClick={() => onProject(lane.project!.id)}>
                      <span className="dot" aria-hidden="true" />
                      {name}
                    </button>
                  ) : (
                    <span className="lane-name is-static"><span className="dot" aria-hidden="true" />{name}</span>
                  )}
                  {lane.lastEntry && (
                    <span className={'lane-activity' + (lane.lastEntry === today ? ' is-today' : '')}>note {dayLabel(lane.lastEntry)}</span>
                  )}
                </div>
                <div className="lane-track" role="group" aria-label={`Tâches ouvertes de ${name}`}>
                  {lane.done > 0 && <span className="lane-done" title={plural(lane.done, 'terminée', 'terminées')}>{lane.done}</span>}
                  {nodes.map((task) => (
                    <button
                      key={task.id}
                      className={'lane-node is-' + task.status + (isOverdue(task, today) ? ' is-late' : '') + (task.pinned ? ' is-pinned' : '')}
                      type="button"
                      aria-label={nodeLabel(task)}
                      title={nodeLabel(task)}
                      onClick={() => onTask(task)}
                    />
                  ))}
                  {more > 0 && <span className="lane-more" title={`${more} autres à faire`}>+{more}</span>}
                </div>
                <p className="lane-heads">
                  {heads.length > 0 ? (
                    <>
                      En cours : {heads.slice(0, 2).map((task, index) => <span key={task.id}>{index > 0 && ' · '}<b>{task.title}</b></span>)}
                      {heads.length > 2 && ` (+${heads.length - 2})`}
                    </>
                  ) : total === 0 ? (
                    <span className="lane-empty">Aucune tâche</span>
                  ) : lane.open.length === 0 ? (
                    <span className="lane-complete">✓ Tout est terminé</span>
                  ) : (
                    <span className="lane-empty">Rien en cours</span>
                  )}
                </p>
                {total > 0 && (
                  <div className="lane-progress">
                    <span className="lane-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
                    <span className="lane-ratio">{lane.done}/{total} · {percent} %</span>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
