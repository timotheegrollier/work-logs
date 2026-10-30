import type { CSSProperties } from 'react';
import { dayLabel, isOverdue, projectProgress, todayISO, type EntrySummary, type Project, type Task } from '../lib';

/** Au-delà, la piste déborde : les autres tâches ouvertes sont comptées (« +N »). */
export const LANE_NODES = 12;

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

/**
 * Vue d'ensemble des projets, au centre : une voie par projet, à la manière d'un git dont
 * l'historique est replié — les terminées comptées dans une pastille, un nœud par tâche
 * ouverte (plein pour celle en cours, le HEAD), une barre d'avancement et la dernière note.
 */
export function ProjectOverview({ projects, tasks, entries, onProject, onTask, onClose }: {
  projects: Project[];
  tasks: Task[];
  entries: EntrySummary[];
  /** Le nom d'un projet le filtre. */
  onProject: (id: string) => void;
  /** Un nœud mène à sa carte dans le panneau Tâches. */
  onTask: (task: Task) => void;
  onClose: () => void;
}) {
  const today = todayISO();
  const lanes = projectProgress(projects, tasks, entries, today);
  const totals = lanes.reduce((sum, lane) => ({ open: sum.open + lane.open.length, done: sum.done + lane.done, late: sum.late + lane.late }), { open: 0, done: 0, late: 0 });
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
      {lanes.length === 0 ? (
        <p className="empty">Aucun projet ni tâche : crée un projet dans « Gérer » ou une tâche dans le panneau Tâches.</p>
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
