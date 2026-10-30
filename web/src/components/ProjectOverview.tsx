import { useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { api, dayLabel, isOverdue, overviewOrder, projectProgress, todayISO, type EntrySummary, type Project, type Task } from '../lib';

/** Au-delà, la piste déborde : les autres tâches ouvertes sont comptées (« +N »). */
export const LANE_NODES = 12;

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

/**
 * Vue d'ensemble des projets, au centre : une voie par projet, à la manière d'un git dont
 * l'historique est replié — les terminées comptées dans une pastille, un nœud par tâche
 * ouverte (plein pour celle en cours, le HEAD), une barre d'avancement et la dernière note.
 */
export function ProjectOverview({ projects, tasks, entries, onProject, onTask, onClose, onChanged, advice, missingOpen = 0, missingTasks = 0 }: {
  projects: Project[];
  tasks: Task[];
  entries: EntrySummary[];
  /** Le nom d'un projet le filtre. */
  onProject: (id: string) => void;
  /** Un nœud mène à sa carte dans le panneau Tâches. */
  onTask: (task: Task) => void;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  advice?: ReactNode;
  /** Nombre de tâches absentes de l’état global limité par le serveur. */
  missingOpen?: number;
  missingTasks?: number;
}) {
  const adviceRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<'todo' | 'doing' | 'open'>('todo');
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const today = todayISO();
  const lanes = projectProgress(projects, tasks, entries, today);
  const totals = lanes.reduce((sum, lane) => ({ open: sum.open + lane.open.length, done: sum.done + lane.done, late: sum.late + lane.late }), { open: 0, done: 0, late: 0 });
  const openTasks = overviewOrder(tasks.filter((task) => task.status !== 'done'));
  const shownTasks = filter === 'open' ? openTasks : openTasks.filter((task) => task.status === filter);
  const todoCount = openTasks.filter((task) => task.status === 'todo').length;
  const doingCount = openTasks.length - todoCount;
  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(key);
    setError('');
    try {
      await action();
      await onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message || 'Impossible de modifier la tâche.');
      return false;
    } finally {
      setBusy('');
    }
  };
  const addTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    if (await run('new', () => api.createTask({ title: value, project_id: projectId || null }))) {
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
        <h2>Vue d’ensemble</h2>
        <p className="ai-hint">
          {plural(projects.length, 'projet', 'projets')} · {plural(totals.open, 'tâche ouverte', 'tâches ouvertes')} · {plural(totals.done, 'terminée', 'terminées')}
          {totals.late > 0 && <> · <b className="late">{totals.late} en retard</b></>}
        </p>
        <button className="ghost no-print" type="button" aria-label="Fermer la vue d’ensemble" onClick={onClose}>
          Fermer
        </button>
      </div>
      {(missingOpen > 0 || missingTasks > 0) && <p className="notice" role="status">
        {missingOpen > 0 && <>{missingOpen} tâche{missingOpen > 1 ? 's' : ''} ouverte{missingOpen > 1 ? 's' : ''} manquante{missingOpen > 1 ? 's' : ''} : la liste est incomplète. </>}
        {missingTasks > 0 && <>L’avancement des projets est incomplet : {missingTasks} tâche{missingTasks > 1 ? 's' : ''} non chargée{missingTasks > 1 ? 's' : ''}.</>}
      </p>}
      <div className="overview-work no-print" aria-busy={Boolean(busy)}>
        <form className="overview-add" onSubmit={(event) => void addTask(event)}>
          <label className="overview-add-title">
            <span>Nouvelle tâche</span>
            <input aria-label="Nouvelle tâche dans la vue d’ensemble" placeholder="Que faut-il faire ?" disabled={Boolean(busy)} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="overview-add-project">
            <span>Projet</span>
            <select aria-label="Projet de la nouvelle tâche" disabled={Boolean(busy)} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">Sans projet</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <button className="task-primary" type="submit" disabled={Boolean(busy) || !title.trim()}>{busy === 'new' ? 'Ajout…' : 'Ajouter'}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="overview-list-head">
          <h3>Tâches ouvertes</h3>
          <div className="overview-filters" role="group" aria-label="Filtrer les tâches de la vue d’ensemble">
            {([['todo', 'À faire', todoCount], ['doing', 'En cours', doingCount], ['open', 'Toutes', openTasks.length]] as const).map(([value, label, count]) => (
              <button key={value} className={'chip' + (filter === value ? ' is-on' : '')} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span className="count">{count}</span></button>
            ))}
          </div>
          {advice && <button className="ghost overview-advice-jump" type="button" onClick={() => { adviceRef.current?.scrollIntoView?.({ block: 'start' }); adviceRef.current?.focus({ preventScroll: true }); }}>Conseils IA ↓</button>}
        </div>
        {shownTasks.length === 0 ? <p className="empty">{filter === 'todo' ? 'Aucune tâche à faire.' : filter === 'doing' ? 'Aucune tâche en cours.' : 'Aucune tâche ouverte.'}</p> : (
          <ul className="overview-tasks" aria-label="Liste des tâches de la vue d’ensemble">
            {shownTasks.map((task) => (
              <li className="overview-task" key={task.id}>
                <div className="overview-task-main">
                  <button className="overview-task-title" type="button" onClick={() => onTask(task)}>{task.title}</button>
                  <span className="overview-task-meta">{task.status === 'doing' ? 'En cours' : 'À faire'}{task.due_date ? ` · ${isOverdue(task, today) ? 'En retard · ' : 'Échéance '}${dayLabel(task.due_date)}` : ''}</span>
                </div>
                <div className="overview-task-project">
                  <select aria-label={`Projet de ${task.title}`} title={task.category_id ? 'Changer de projet retire la catégorie actuelle' : 'Affecter à un projet'} disabled={Boolean(busy)} value={task.project_id ?? ''} onChange={(event) => void run(task.id, () => api.updateTask(task.id, { project_id: event.target.value || null }))}>
                    <option value="">Sans projet</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </div>
                <button className="ghost overview-task-move" type="button" disabled={Boolean(busy)} aria-label={task.status === 'doing' ? `Remettre à faire ${task.title}` : `Mettre en cours ${task.title}`} onClick={() => void run(task.id, () => api.moveTask(task.id, task.status === 'doing' ? 'todo' : 'doing', Number.MAX_SAFE_INTEGER))}>
                  {task.status === 'doing' ? 'Remettre à faire' : '▶ En cours'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {advice && <div ref={adviceRef} tabIndex={-1} role="group" aria-label="Conseils IA">{advice}</div>}
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
