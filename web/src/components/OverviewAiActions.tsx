import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AiCancelled, MAX_DAILY_FOLLOW_UPS, MAX_REPLANNED_TASKS, generateDailyReview, readAiSettings, replanTasks, type DailyFollowUpInput, type DailyReview, type TaskScheduleProposal } from '../ai-suggest';
import { readProjectAiBrief } from '../ai-context';
import { flushPendingSaves } from '../autosave';
import { api, dayLabel, isFollowed, PRIORITIES, priorityLabel, todayISO, type EntrySummary, type Project, type Task } from '../lib';
import { AiPending } from './AiMenu';

type Choice = TaskScheduleProposal & { selected: boolean; applied: boolean; previousDueDate: string | null };
type Work = 'daily' | 'schedule' | 'applying' | null;
const changedMessage = 'Les tâches ou les suivis ont changé. Relance la replanification.';
const openTasks = (tasks: Task[]) => tasks.filter((task) => task.status !== 'done');
const projectKey = (projects: Project[]) => projects.map((project) => [project.id, project.name, readProjectAiBrief(project.id)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
const planningContext = (projects: Project[]) => [projectKey(projects), readProjectAiBrief(null), readAiSettings().profile, todayISO()];
const planningKey = (tasks: Task[], projects: Project[], context = planningContext(projects)) => JSON.stringify([
  openTasks(tasks).map((task) => [task.id, task.title, task.status, task.priority, task.due_date, task.project_id, task.pinned, task.created_at, task.documents.length, task.follow_up_key, task.follow_up]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  context,
]);
const followedItems = (tasks: Task[], entries: EntrySummary[]): DailyFollowUpInput[] => [
  ...tasks.filter(isFollowed).map((task) => ({ id: task.id, kind: 'task' as const, title: task.title, follow_up: task.follow_up, follow_up_key: task.follow_up_key })),
  ...entries.filter(isFollowed).map((entry) => ({ id: entry.id, kind: 'entry' as const, title: entry.title, date: entry.entry_date, follow_up: entry.follow_up, follow_up_key: entry.follow_up_key })),
];
const dailyKey = (items: DailyFollowUpInput[], missingEntries: number, missingTasks: number) => JSON.stringify([items, readAiSettings().profile, todayISO(), missingEntries, missingTasks]);
const validDate = (value: string, today: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value && value >= today;

/** Deux demandes directes ; seules les dates et priorités explicitement relues sont écrites. */
export function OverviewAiActions({ tasks, entries, projects, missingOpen = 0, missingEntries = 0, missingTasks = 0, onChanged, onTask, onShowFollowUps, children }: {
  tasks: Task[];
  entries: EntrySummary[];
  projects: Project[];
  missingOpen?: number;
  missingEntries?: number;
  missingTasks?: number;
  onChanged: () => void | Promise<void>;
  onTask: (task: Task) => void;
  onShowFollowUps: () => void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState<Work>(null);
  const work = useRef<Work>(null);
  const controller = useRef<AbortController | null>(null);
  const [daily, setDaily] = useState<DailyReview | null>(null);
  const [dailyDate, setDailyDate] = useState(todayISO);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const expected = useRef<Task[] | null>(null);
  const scheduleInput = useRef<string | null>(null);
  const scheduleContext = useRef<ReturnType<typeof planningContext> | null>(null);
  const dailyInput = useRef<string | null>(null);
  const dailyHead = useRef<HTMLHeadingElement>(null);
  const scheduleHead = useRef<HTMLHeadingElement>(null);
  const currentPlanning = planningKey(tasks, projects);
  const open = openTasks(tasks);
  const followed = followedItems(tasks, entries);
  // Le bilan du jour lit la totalité des tâches non terminées, pas seulement les suivies.
  const dailyItems = [...followed, ...open.filter((task) => !isFollowed(task)).map((task) => ({ id: task.id, kind: 'task' as const, title: task.title, follow_up: task.follow_up, follow_up_key: task.follow_up_key, status: task.status }))];
  // La clé de détection de changement ne porte que sur les suivis : le statut d'une
  // tâche ouverte ne doit pas invalider un bilan déjà demandé.
  const currentDaily = dailyKey(followed, missingEntries, missingTasks);
  const today = todayISO();
  const hasReports = dailyItems.some((item) => item.follow_up?.report) || open.length > 0;
  const selected = choices?.filter((choice) => choice.selected && !choice.applied) ?? [];
  const invalidDates = selected.some((choice) => !validDate(choice.due_date, today));
  const hasSchedule = choices !== null;
  const choiceChanged = (choice: Choice) => {
    const task = tasks.find((candidate) => candidate.id === choice.id);
    return Boolean(task && (task.priority !== choice.priority || task.due_date !== choice.due_date));
  };
  const changedCount = choices?.filter((choice) => !choice.applied && choiceChanged(choice)).length ?? 0;

  const finish = (request: AbortController) => {
    if (controller.current === request) { controller.current = null; work.current = null; setBusy(null); }
  };
  useEffect(() => {
    if (work.current !== 'applying' && scheduleInput.current && currentPlanning !== scheduleInput.current) {
      if (work.current === 'schedule') { controller.current?.abort(); controller.current = null; work.current = null; setBusy(null); }
      scheduleInput.current = null;
      expected.current = null;
      setChoices(null);
      setError(changedMessage);
    }
    if (dailyInput.current && currentDaily !== dailyInput.current) {
      if (work.current === 'daily') { controller.current?.abort(); controller.current = null; work.current = null; setBusy(null); }
      dailyInput.current = null;
      setDaily(null);
      if (work.current !== 'applying') setError('La journée ou les suivis ont changé. Relance le bilan du jour pour les prendre en compte.');
    }
  }, [currentPlanning, currentDaily]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (daily) dailyHead.current?.focus({ preventScroll: true }); }, [daily]);
  useEffect(() => { if (hasSchedule) scheduleHead.current?.focus({ preventScroll: true }); }, [hasSchedule]);

  const generate = async (kind: 'daily' | 'schedule') => {
    if (work.current) return;
    const request = new AbortController();
    const date = todayISO();
    controller.current = request;
    work.current = kind; setBusy(kind); setError(''); setFeedback('');
    if (kind === 'daily') { dailyInput.current = dailyKey(followed, missingEntries, missingTasks); setDaily(null); }
    else { scheduleContext.current = planningContext(projects); scheduleInput.current = planningKey(tasks, projects, scheduleContext.current); expected.current = open; setChoices(null); }
    try {
      await flushPendingSaves();
      if (request.signal.aborted) return;
      const settings = { ...readAiSettings(), signal: request.signal };
      if (kind === 'daily') {
        const result = await generateDailyReview(settings, dailyItems, { today: date });
        if (!request.signal.aborted) { setDailyDate(date); setDaily(result); }
      } else {
        const result = await replanTasks(settings, open.map((task) => ({
          ...task, project: projects.find((project) => project.id === task.project_id)?.name,
          projectId: task.project_id ?? undefined, projectBrief: readProjectAiBrief(task.project_id), documents: task.documents.length,
        })), { today: date });
        if (!request.signal.aborted) setChoices(result.map((choice) => ({ ...choice, selected: true, applied: false, previousDueDate: open.find((task) => task.id === choice.id)?.due_date ?? null })));
      }
    } catch (cause) {
      if (!request.signal.aborted && !(cause instanceof AiCancelled)) setError((cause as Error).message || 'La demande IA a échoué.');
    } finally { finish(request); }
  };
  const edit = (id: string, update: Partial<Choice>) => setChoices((current) => current?.map((choice) => choice.id === id ? { ...choice, ...update } : choice) ?? null);
  const apply = async () => {
    if (work.current || !selected.length || invalidDates || !expected.current || !scheduleInput.current) return;
    work.current = 'applying'; setBusy('applying'); setError(''); setFeedback('');
    let written = 0;
    try {
      await flushPendingSaves();
      const state = await api.state();
      const missing = state.stats.tasks.todo + state.stats.tasks.doing - openTasks(state.tasks).length;
      if (missing > 0 || planningKey(state.tasks, state.projects) !== scheduleInput.current) {
        setChoices(null); expected.current = null; scheduleInput.current = null;
        throw new Error(changedMessage);
      }
      // Les réussites sont retirées de la sélection au fur et à mesure : après un
      // refus, Réessayer ne renvoie pas les écritures déjà confirmées.
      for (const choice of selected) {
        const task = expected.current.find((candidate) => candidate.id === choice.id);
        if (!task || task.status === 'done') throw new Error(changedMessage);
        if (task.priority !== choice.priority || task.due_date !== choice.due_date) {
          const updated = await api.updateTask(choice.id, { priority: choice.priority, due_date: choice.due_date, expected_planning: {
            title: task.title, status: task.status, priority: task.priority, due_date: task.due_date,
            project_id: task.project_id, pinned: task.pinned, follow_up_key: task.follow_up_key ?? null,
          } });
          expected.current = expected.current.map((candidate) => candidate.id === updated.id ? updated : candidate);
          written += 1;
        }
        edit(choice.id, { applied: true, selected: false });
      }
      setFeedback(`${selected.length} tâche${selected.length > 1 ? 's' : ''} replanifiée${selected.length > 1 ? 's' : ''}.`);
      // Toutes les tâches sélectionnées ont été écrites : la proposition se referme.
      setChoices(null); expected.current = null; scheduleInput.current = null;
    } catch (cause) {
      setError((written ? `${written} tâche${written > 1 ? 's' : ''} enregistrée${written > 1 ? 's' : ''}. ` : '') + ((cause as Error).message || 'Impossible d’appliquer les dates.'));
    } finally {
      work.current = null;
      setBusy(null);
      if (expected.current && scheduleContext.current) scheduleInput.current = planningKey(expected.current, projects, scheduleContext.current);
      // Une réponse perdue peut avoir été écrite : relire même après un refus.
      try { await onChanged(); } catch (cause) { setError((cause as Error).message || 'Impossible de relire les tâches.'); }
    }
  };
  const list = (title: string, values: string[]) => values.length > 0 && <div><h4>{title}</h4><ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul></div>;

  return <section className="overview-ai no-print" aria-label="Bilan du jour et planification IA" aria-busy={Boolean(busy)}>
    <div className="overview-ai-head">
      <div className="overview-ai-title">
        <span className="overview-kicker">Assistant</span>
        <h3>Bilan et planification</h3>
      </div>
      {followed.length > 0 && <button className="ghost overview-ai-follow-link" type="button" onClick={onShowFollowUps}>Voir les suivis ({followed.length})</button>}
    </div>
    <div className="overview-ai-actions">
      <button className="task-primary overview-ai-action" type="button" aria-label="Bilan du jour" disabled={Boolean(busy) || !hasReports || dailyItems.length > MAX_DAILY_FOLLOW_UPS} onClick={() => void generate('daily')}>
        <span className="overview-ai-action-icon" aria-hidden="true">✨</span>
        <span className="overview-ai-action-copy"><strong>Bilan du jour</strong><small>{dailyItems.length > 0 ? `${dailyItems.length} source${dailyItems.length > 1 ? 's' : ''} à synthétiser` : 'Aucune source suivie'}</small></span>
      </button>
      <button className="ghost overview-ai-action" type="button" aria-label="Replanifier avec l’IA" disabled={Boolean(busy) || !open.length || missingOpen > 0 || open.length > MAX_REPLANNED_TASKS} onClick={() => void generate('schedule')}>
        <span className="overview-ai-action-icon" aria-hidden="true">↻</span>
        <span className="overview-ai-action-copy"><strong>Replanifier</strong><small>{open.length > 0 ? `${open.length} tâche${open.length > 1 ? 's' : ''} ouverte${open.length > 1 ? 's' : ''}` : 'Aucune tâche ouverte'}</small></span>
      </button>
    </div>
    <p className="ai-hint overview-ai-note">{hasReports ? 'Le bilan rassemble les avancées, blocages et prochaines actions de tes suivis IA.' : 'Ajoute une tâche ou une entrée aux suivis IA pour préparer ton bilan du jour.'}</p>
    <details className="overview-ai-scope">
      <summary>Données envoyées au service IA</summary>
      <p>Le service IA reçoit les bilans de suivi et, pour replanifier, les champs des tâches et les repères des projets.</p>
    </details>
    {children}
    {(missingEntries > 0 || missingTasks > 0) && <p className="notice">Le bilan couvre uniquement {dailyItems.length} source{dailyItems.length > 1 ? 's' : ''} chargée{dailyItems.length > 1 ? 's' : ''}. Éléments non chargés : {missingEntries > 0 ? `${missingEntries} entrée${missingEntries > 1 ? 's' : ''}` : ''}{missingEntries > 0 && missingTasks > 0 ? ' et ' : ''}{missingTasks > 0 ? `${missingTasks} tâche${missingTasks > 1 ? 's' : ''}` : ''}. D’autres sources peuvent manquer.</p>}
    {(dailyItems.length > MAX_DAILY_FOLLOW_UPS || open.length > MAX_REPLANNED_TASKS) && <p className="notice">{dailyItems.length > MAX_DAILY_FOLLOW_UPS ? `Le bilan accepte ${MAX_DAILY_FOLLOW_UPS} sources au maximum. ` : ''}{open.length > MAX_REPLANNED_TASKS ? `La replanification accepte ${MAX_REPLANNED_TASKS} tâches ouvertes au maximum ; termine les tâches devenues inutiles.` : ''}</p>}
    {busy && <div className="overview-ai-pending"><AiPending label={busy === 'daily' ? 'L’IA rassemble les bilans de suivi…' : busy === 'schedule' ? 'L’IA propose les priorités et les dates…' : 'Enregistrement des dates et priorités…'} />{busy !== 'applying' && <button className="ghost" type="button" onClick={() => { controller.current?.abort(); controller.current = null; work.current = null; setBusy(null); }}>Arrêter</button>}</div>}
    {error && <p className="error" role="alert">{error}</p>}
    {feedback && <p className="overview-ai-feedback" role="status">{feedback}</p>}
    {daily && <section className="overview-daily" aria-label="Bilan IA du jour">
      <div className="overview-ai-result-head"><div className="overview-result-heading"><span className="overview-result-kicker">Synthèse</span><h3 ref={dailyHead} tabIndex={-1}>Bilan du {new Date(dailyDate + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</h3></div><button className="ghost" type="button" aria-label="Fermer le bilan du jour" onClick={() => setDaily(null)}>Fermer</button></div>
      <p>{daily.summary}</p>
      <div className="overview-daily-lists">{list('Avancées attestées', daily.completed)}{list('Prochaines actions', daily.next_steps)}{list('Blocages', daily.blockers)}</div>
      {daily.warnings.length > 0 && <details className="overview-daily-limits"><summary>Sources et limites du bilan ({daily.warnings.length})</summary><ul>{daily.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <p className="ai-hint">Synthèse des bilans enregistrés ; leur date de génération ne prouve pas la date des avancées.</p>
    </section>}
    {choices && <section className="overview-schedule" aria-label="Dates et priorités proposées par l’IA">
      <div className="overview-ai-result-head">
        <div className="overview-result-heading"><span className="overview-result-kicker">Proposition</span><h3 ref={scheduleHead} tabIndex={-1}>Replanification</h3></div>
        <div className="overview-result-actions">
          <span className="overview-result-count">{choices.length} tâche{choices.length > 1 ? 's' : ''}{changedCount > 0 ? ` · ${changedCount} changement${changedCount > 1 ? 's' : ''}` : ' · aucun changement'}</span>
          <button className="ghost" type="button" disabled={Boolean(busy)} onClick={() => { setChoices(null); expected.current = null; scheduleInput.current = null; }}>Ignorer</button>
        </div>
      </div>
      <p className="ai-hint">Dates de travail estimées d’après l’importance, les échéances et les suivis. Corrige-les puis applique les tâches cochées.</p>
      {choices.length < open.length && <p className="notice" role="status">Réponse incomplète : {choices.length} tâche{choices.length > 1 ? 's' : ''} sur {open.length}. Les autres gardent leur date et leur priorité.</p>}
      <ul className="overview-schedule-list">{choices.map((choice) => {
        const task = tasks.find((candidate) => candidate.id === choice.id);
        if (!task) return null;
        const changed = !choice.applied && choiceChanged(choice);
        return <li key={choice.id} className={'overview-schedule-item' + (choice.applied ? ' is-applied' : '') + (changed ? ' is-changed' : '')}>
          <div className="overview-schedule-check"><input type="checkbox" aria-label={`Replanifier ${task.title}`} checked={choice.selected} disabled={Boolean(busy) || choice.applied} onChange={(event) => edit(choice.id, { selected: event.target.checked })} /></div>
          <div className="overview-schedule-body">
            <div className="overview-schedule-task">
              <button className="overview-task-title" type="button" disabled={Boolean(busy)} onClick={() => onTask(task)}>{task.title}</button>
              {choice.applied
                ? <span className="overview-schedule-badge is-applied">✓ Enregistrée</span>
                : <span className={'overview-schedule-badge' + (changed ? ' is-changed' : '')}>{changed ? 'À modifier' : 'Inchangée'}</span>}
            </div>
            <div className="overview-schedule-compare">
              <span>Actuel : <b>{priorityLabel(task.priority)}</b>{task.due_date ? ` · ${dayLabel(task.due_date)}` : ' · sans date'}</span>
              <span>Proposé : <b>{priorityLabel(choice.priority)}</b> · {dayLabel(choice.due_date)}</span>
            </div>
            <div className="overview-schedule-fields"><label>Priorité <select aria-label={`Priorité proposée pour ${task.title}`} disabled={Boolean(busy) || choice.applied} value={choice.priority} onChange={(event) => edit(choice.id, { priority: event.target.value as Task['priority'] })}>{PRIORITIES.map((priority) => <option key={priority.id} value={priority.id}>{priority.label}</option>)}</select></label><label>Date proposée <input type="date" aria-label={`Date proposée pour ${task.title}`} min={today} value={choice.due_date} disabled={Boolean(busy) || choice.applied} onChange={(event) => edit(choice.id, { due_date: event.target.value })} /></label></div>
            {choice.reason && <p className="overview-schedule-reason">{choice.reason}</p>}
          </div>
        </li>;
      })}</ul>
      {invalidDates && <p className="error" role="alert">Choisis pour chaque tâche cochée une date valide, à partir d’aujourd’hui.</p>}
      <div className="overview-schedule-apply">
        <span>{selected.length > 0 ? `${selected.length} tâche${selected.length > 1 ? 's' : ''} sélectionnée${selected.length > 1 ? 's' : ''}` : 'Aucune tâche sélectionnée'}</span>
        <button className="task-primary" type="button" disabled={Boolean(busy) || !selected.length || invalidDates} onClick={() => void apply()}>Appliquer {selected.length} tâche{selected.length > 1 ? 's' : ''}</button>
      </div>
    </section>}
  </section>;
}
