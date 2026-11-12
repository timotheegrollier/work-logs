import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, dayLabel, isFollowed, isOverdue, projectProgress, todayISO, type EntrySummary, type Project, type Status, type Task } from '../lib';
import { flushPendingSaves } from '../autosave';
import { FollowUpPanel } from './FollowUpPanel';
import { OverviewAiActions } from './OverviewAiActions';
import { OverviewFollowUpPicker } from './OverviewFollowUpPicker';
import { OverviewEntryActions, OverviewTaskActions } from './OverviewItemActions';

/** Au-delà, les autres tâches ouvertes sont comptées (« +N ») : la piste tient sur une ligne jusqu'à 360 px. */
export const LANE_NODES = 10;

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

/**
 * Vue d'ensemble des projets, au centre : à gauche ce que l'IA a rédigé (bilan, suivis,
 * propositions) et les gestes qui s'y rattachent ; à droite une voie par projet, à la manière
 * d'un git dont l'historique est replié — les terminées comptées dans une pastille, un nœud
 * par tâche ouverte (plein pour celle en cours, le HEAD), une barre d'avancement et la dernière note.
 */
export function ProjectOverview({ projects, tasks, entries, onProject, onTask, onEntry, onClose, onChanged, advice, missingOpen = 0, missingTasks = 0, missingEntries = 0 }: {
  projects: Project[];
  tasks: Task[];
  entries: EntrySummary[];
  /** Le nom d'un projet le filtre. */
  onProject: (id: string) => void;
  /** Ouvre une entrée liée qui contient du contexte, sinon la carte de la tâche. */
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
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const submitting = useRef(false);
  const today = todayISO();
  const lanes = projectProgress(projects, tasks, entries, today);
  const totals = lanes.reduce((sum, lane) => ({ open: sum.open + lane.open.length, done: sum.done + lane.done, late: sum.late + lane.late }), { open: 0, done: 0, late: 0 });
  const followedTasks = tasks.filter(isFollowed);
  const followedEntries = entries.filter(isFollowed);
  const head = useRef<HTMLHeadingElement>(null);
  const followHead = useRef<HTMLHeadingElement>(null);
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
    const message = status === 'done' ? `« ${task.title} » validée.${task.documents.length ? ' Les documents liés sont archivés.' : ''}`
      : status === 'doing' ? `« ${task.title} » passée en cours.`
      : task.status === 'done' ? `« ${task.title} » rouverte.` : `« ${task.title} » remise à faire.`;
    void run('task:' + task.id, () => api.moveTask(task.id, status, Number.MAX_SAFE_INTEGER), message, followHead.current);
  };
  const changeEntryArchive = (entry: EntrySummary) => {
    void run('entry:' + entry.id, () => api.updateEntry(entry.id, { archived: entry.archived ? 0 : 1 }), `« ${entry.title} » ${entry.archived ? 'désarchivée' : 'archivée'}.`, followHead.current);
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
        <h2 ref={head} tabIndex={-1}>Vue d’ensemble</h2>
        <div className="overview-head-actions">
          <button className="ghost no-print" type="button" aria-label="Fermer la vue d’ensemble" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
      {(missingOpen > 0 || missingTasks > 0) && <p className="notice" role="status">
        {missingOpen > 0 && <>{missingOpen} tâche{missingOpen > 1 ? 's' : ''} ouverte{missingOpen > 1 ? 's' : ''} manquante{missingOpen > 1 ? 's' : ''} : la replanification est indisponible. </>}
        {missingTasks > 0 && <>L’avancement des projets est incomplet : {missingTasks} tâche{missingTasks > 1 ? 's' : ''} non chargée{missingTasks > 1 ? 's' : ''}.</>}
      </p>}
      <div className="overview-work no-print" aria-busy={Boolean(busy)}>
        <OverviewAiActions tasks={tasks} entries={entries} projects={projects} missingOpen={missingOpen} missingTasks={missingTasks} missingEntries={missingEntries} onChanged={onChanged} onTask={onTask}>
          <OverviewFollowUpPicker tasks={tasks} entries={entries} projects={projects} onChanged={onChanged} />
        </OverviewAiActions>
        <div className="overview-action-feedback">
          <span className={'overview-status' + (busy ? ' is-busy' : '')} role="status" aria-live="polite" aria-atomic="true">{busy ? 'Enregistrement…' : feedback}</span>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        {followCount > 0 && <section className="overview-follow-ups no-print" aria-label="Bilans et suivis IA">
          <div className="overview-section-head">
            <h3 ref={followHead} tabIndex={-1}>Suivis IA</h3>
            <span className="overview-section-count">{followCount}</span>
          </div>
          <ul>
            {followedTasks.map((task) => <li key={'task-' + task.id}>
              <div className="overview-follow-up-title"><span>Tâche</span><button className="overview-task-title" type="button" aria-label={`Ouvrir la tâche ${task.title}`} onClick={() => onTask(task)}>{task.title}</button></div>
              <FollowUpPanel kind="task" item={task} compact actions={<OverviewTaskActions task={task} disabled={Boolean(busy)} onStatus={changeTaskStatus} />} />
            </li>)}
            {followedEntries.map((entry) => <li key={'entry-' + entry.id}>
              <div className="overview-follow-up-title"><span>{entry.kind === 'procedure' ? 'Procédure' : 'Entrée'}{entry.archived ? ' · Archivée' : ''}</span><button className="overview-task-title" type="button" aria-label={`Ouvrir l’entrée ${entry.title}`} onClick={() => onEntry(entry)}>{entry.title}</button></div>
              <FollowUpPanel kind="entry" item={entry} compact actions={<OverviewEntryActions entry={entry} disabled={Boolean(busy)} onArchive={changeEntryArchive} />} />
            </li>)}
          </ul>
        </section>}
        {advice && <details className="overview-more-advice no-print"><summary>Conseils détaillés avec l’IA</summary><div role="group" aria-label="Conseils IA">{advice}</div></details>}
      </div>
      <div className="overview-progress">
        <div className="overview-section-head">
          <h3>Avancement des projets</h3>
          {lanes.length > 0 && <p className="overview-totals">{plural(totals.open, 'ouverte', 'ouvertes')} · {plural(totals.done, 'terminée', 'terminées')}{totals.late > 0 && <> · <b>{totals.late} en retard</b></>}</p>}
        </div>
        {lanes.length === 0 ? (
          <p className="empty">Aucun projet ni tâche : crée un projet dans « Gérer » ou ajoute une tâche dans le panneau Tâches.</p>
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
      </div>
    </section>
  );
}
