import { useEffect, useRef, useState } from 'react';
import { AiCancelled, MAX_ADVICE_TASKS, adviseTaskOrder, readAiSettings, type TaskAdvice as Advice } from '../ai-suggest';
import { prepareTaskAdvice } from '../task-advice-context';
import { readProjectAiBrief } from '../ai-context';
import type { Project, Task } from '../lib';
import { AiPending } from './AiMenu';

type Prepared = Awaited<ReturnType<typeof prepareTaskAdvice>>;

/** Les sources sont préparées localement, relues puis envoyées seulement sur demande. */
export function TaskAdvice({ tasks, projects, onTask, missingOpen = 0 }: {
  tasks: Task[]; projects: Project[]; onTask: (task: Task) => void; missingOpen?: number;
}) {
  const [scope, setScope] = useState('all');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<Advice[] | null>(null);
  const [busy, setBusy] = useState<'preparing' | 'advising' | null>(null);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const open = tasks.filter((task) => task.status !== 'done' && (scope === 'all' || (task.project_id ?? '') === scope));
  const needsSelection = open.length > MAX_ADVICE_TASKS;
  const selectedOpen = needsSelection ? open.filter((task) => selected.includes(task.id)) : open;
  // Une suggestion ne doit pas survivre à un contexte modifié dans l'application.
  const snapshot = JSON.stringify([
    open.map((task) => [task.id, task.updated_at, task.title, task.status, task.priority, task.due_date, task.pinned, task.project_id, task.documents?.map((doc) => [doc.id, doc.title, doc.updated_at, doc.kind, doc.project_id, doc.archived, doc.google_document_id, doc.google_tab_id])]),
    projects.map((project) => [project.id, project.name, readProjectAiBrief(project.id)]), readProjectAiBrief(null), readAiSettings().profile, scope, missingOpen, needsSelection ? selected : [],
  ]);
  useEffect(() => {
    // Un contexte effectivement modifié invalide les résultats, mais l'utilisateur
    // doit savoir pourquoi la préparation ou la réponse vient de disparaître.
    const wasActive = Boolean(controller.current || prepared || result);
    controller.current?.abort();
    controller.current = null;
    setBusy(null);
    setPrepared(null);
    setResult(null);
    setError(wasActive ? 'Les tâches ou leur contexte ont changé. Prépare à nouveau les conseils.' : '');
  }, [snapshot]);
  useEffect(() => () => controller.current?.abort(), []);
  const prepare = async () => {
    if (busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy('preparing'); setError(''); setResult(null); setPrepared(null);
    try {
      const value = await prepareTaskAdvice(selectedOpen, projects, request.signal);
      if (!request.signal.aborted) { setPrepared(value); setExcluded([]); }
    } catch (e) {
      if (!request.signal.aborted && !(e instanceof AiCancelled)) setError((e as Error).message);
    } finally {
      if (controller.current === request) { controller.current = null; setBusy(null); }
    }
  };
  const advise = async () => {
    if (!prepared || busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy('advising'); setError(''); setResult(null);
    try {
      const answer = await adviseTaskOrder({ ...readAiSettings(), signal: request.signal }, prepared.tasks.map((task) => ({ ...task, projectBrief: readProjectAiBrief(task.projectId ?? null) })), { excludedSourceIds: excluded });
      if (!request.signal.aborted) setResult(answer);
    } catch (e) {
      if (!request.signal.aborted && !(e instanceof AiCancelled)) setError((e as Error).message);
    } finally {
      if (controller.current === request) { controller.current = null; setBusy(null); }
    }
  };
  return (
    <section className="overview-advice" aria-label="Conseils IA pour les tâches">
      <div className="overview-advice-head">
        <div><h3>✨ Ordre et conseils IA</h3><p className="ai-hint">Propose un ordre et des conseils, sans modifier les tâches.</p></div>
        <label>Projet <select aria-label="Projet à analyser par l’IA" value={scope} disabled={Boolean(busy)} onChange={(event) => { setScope(event.target.value); setSelected([]); }}>
          <option value="all">Tous les projets</option><option value="">Sans projet</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select></label>
        <button className="ghost" type="button" disabled={Boolean(busy) || !selectedOpen.length || selectedOpen.length > MAX_ADVICE_TASKS || missingOpen > 0} onClick={() => void prepare()}>Préparer les conseils</button>
      </div>
      <p className="ai-hint">{open.length} tâche{open.length > 1 ? 's' : ''} ouverte{open.length > 1 ? 's' : ''} à analyser · {MAX_ADVICE_TASKS} au maximum. L’IA reçoit les champs des tâches, le profil et les repères des projets, ainsi que les extraits de notes et procédures liées sélectionnés ci-dessous : jusqu’à 3 documents par tâche, 40 documents et 600 caractères par extrait. Les fichiers Google et pièces jointes ne sont pas lus.</p>
      {missingOpen > 0 && <p className="error" role="alert">L’analyse est indisponible : {missingOpen} tâche{missingOpen > 1 ? "s" : ""} ouverte{missingOpen > 1 ? "s" : ""} manque{missingOpen > 1 ? "nt" : ""} dans la vue limitée à 500 tâches.</p>}
      {needsSelection && <details className="overview-advice-selection" open>
        <summary>Choisir les tâches à analyser ({selectedOpen.length}/{MAX_ADVICE_TASKS})</summary>
        <p className="ai-hint">Ce groupe dépasse la limite. Choisis au maximum {MAX_ADVICE_TASKS} tâches ; les autres ne seront pas analysées.</p>
        <button className="ghost" type="button" disabled={Boolean(busy)} onClick={() => setSelected(open.slice(0, MAX_ADVICE_TASKS).map((task) => task.id))}>Sélectionner les {MAX_ADVICE_TASKS} premières</button>{' '}
        <button className="ghost" type="button" disabled={Boolean(busy)} onClick={() => setSelected([])}>Effacer la sélection</button>
        <div className="overview-advice-choices">{open.map((task) => <label key={task.id}><input type="checkbox" checked={selected.includes(task.id)} disabled={Boolean(busy) || (!selected.includes(task.id) && selectedOpen.length >= MAX_ADVICE_TASKS)} onChange={(event) => { const checked = event.target.checked; setSelected((current) => checked ? [...current, task.id] : current.filter((id) => id !== task.id)); }} /> {task.title} · {projects.find((project) => project.id === task.project_id)?.name ?? 'Sans projet'}</label>)}</div>
      </details>}
      {busy && <><AiPending label={busy === 'preparing' ? 'Lecture des sources locales…' : 'L’IA prépare ses conseils…'} /><button className="ghost" type="button" onClick={() => { controller.current?.abort(); controller.current = null; setBusy(null); }}>Arrêter</button></>}
      {error && <p className="error" role="alert">{error}</p>}
      {prepared && <div className="overview-advice-sources">
        <p>{prepared.sources.length ? 'Vérifie les extraits et décoche ceux à exclure avant l’envoi :' : 'Aucun extrait de document local lié à envoyer.'}</p>
        {prepared.omitted > 0 && <p className="ai-hint">{prepared.omitted} document{prepared.omitted > 1 ? 's' : ''} lié{prepared.omitted > 1 ? 's' : ''} non lu{prepared.omitted > 1 ? 's' : ''} (Google, archivé, vide ou au-delà des limites).</p>}
        {prepared.sources.map((source) => <details key={source.id}>
          <summary><label><input type="checkbox" checked={!excluded.includes(source.id)} disabled={Boolean(busy)} onClick={(event) => event.stopPropagation()} onChange={(event) => { const checked = event.target.checked; setResult(null); setExcluded((current) => checked ? current.filter((id) => id !== source.id) : [...current, source.id]); }} /> {source.kind === 'procedure' ? 'Procédure' : 'Note'} : {source.title}</label></summary>
          <p>{source.text}</p>
        </details>)}
        <button className="task-primary" type="button" disabled={Boolean(busy)} onClick={() => void advise()}>Demander les conseils à l’IA</button>
      </div>}
      {result && <div className="overview-advice-result" role="region" aria-label="Ordre conseillé par l’IA">
        <h4>Ordre proposé</h4>
        {prepared && result.length < prepared.tasks.length && <p role="status">Réponse incomplète : {result.length} tâche{result.length > 1 ? 's' : ''} conseillée{result.length > 1 ? 's' : ''} sur {prepared.tasks.length}. Les autres ne sont pas classées.</p>}
        <ol>{result.map((item) => {
          const task = tasks.find((candidate) => candidate.id === item.id);
          if (!task) return null;
          return <li key={item.id}><button type="button" className="overview-task-title" onClick={() => onTask(task)}>{task.title}</button>{item.reason && <p>{item.reason}</p>}{item.advice && <p>{item.advice}</p>}</li>;
        })}</ol>
        <p className="ai-hint">Conseils à vérifier : aucune tâche n’a été modifiée.</p>
      </div>}
    </section>
  );
}
