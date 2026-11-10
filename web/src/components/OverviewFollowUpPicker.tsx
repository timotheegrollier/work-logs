import { useContext, useRef, useState } from 'react';
import { flushPendingSaves } from '../autosave';
import { FollowUpContext } from '../follow-up-controller';
import { api, isFollowed, overviewOrder, todayISO, type EntrySummary, type Project, type Task } from '../lib';

/** Une sélection commune : suivre une tâche inclut déjà ses documents liés. */
export function OverviewFollowUpPicker({ tasks, entries, projects, onChanged }: {
  tasks: Task[]; entries: EntrySummary[]; projects: Project[]; onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const followUp = useContext(FollowUpContext);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
  const taskItems = overviewOrder(tasks.filter((task) => task.status !== 'done')).map((task) => ({ ...task, kind: 'task' as const }));
  const entryItems = [...entries].sort((a, b) => b.entry_date.localeCompare(a.entry_date)).map((entry) => ({ ...entry, kind: 'entry' as const }));
  const items = [...taskItems, ...entryItems].filter((item) => !isFollowed(item));
  const chosenTasks = tasks.filter((task) => isFollowed(task) || selected.includes('task:' + task.id));
  const visible = items.filter((item) => fold(item.title + ' ' + (projects.find((project) => project.id === item.project_id)?.name ?? '')).includes(fold(query.trim())));
  const close = () => { setOpen(false); setSelected([]); setQuery(''); trigger.current?.focus(); };
  const add = async () => {
    if (submitting.current) return;
    const chosen = items.filter((item) => selected.includes(item.kind + ':' + item.id));
    if (!chosen.length) return;
    submitting.current = true; setBusy(true); setError(''); setFeedback('');
    let count = 0;
    try {
      await flushPendingSaves();
      for (const item of chosen) {
        const latest = await api.followUp(item.kind, item.id);
        if (!isFollowed(latest)) {
          try {
            await api.saveFollowUp(item.kind, item.id, { enabled: true });
          } catch (cause) {
            // Une réponse perdue n'est pas forcément un refus : vérifier avant
            // de proposer une nouvelle activation qui redaterait le choix.
            const saved = await api.followUp(item.kind, item.id).catch(() => null);
            if (!saved?.follow_up?.enabled) throw cause;
          }
          // L'activation explicite demande son premier bilan ici : l'ordonnanceur
          // ne balaie plus les suivis au chargement.
          followUp?.refresh({ id: item.id, title: item.title, follow_up: latest.follow_up, follow_up_key: latest.source_key, kind: item.kind });
        }
        count++;
        setSelected((value) => value.filter((key) => key !== item.kind + ':' + item.id));
      }
      close();
    } catch (cause) {
      setError((cause as Error).message || 'Impossible d’activer le suivi.');
    } finally {
      if (count) {
        setFeedback(`${count} suivi${count > 1 ? 's' : ''} activé${count > 1 ? 's' : ''}.`);
      }
      try { await onChanged(); } catch (cause) { setError((cause as Error).message); }
      submitting.current = false; setBusy(false);
    }
  };
  return <div className="overview-follow-picker">
    <button ref={trigger} className="ghost" type="button" aria-label="Ajouter au suivi IA" aria-expanded={open} aria-controls="overview-follow-selection" disabled={busy} onClick={() => {
      if (open) close();
      else { setOpen(true); setError(''); requestAnimationFrame(() => search.current?.focus()); }
    }}>+ Ajouter au suivi IA</button>
    {feedback && <p role="status" className="ai-hint">{feedback}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {open && <section id="overview-follow-selection" className="overview-follow-selection" aria-label="Choisir les suivis IA">
      <div className="overview-follow-selection-head">
        <div><span className="overview-kicker">Suivis IA</span><h4>Choisir des éléments</h4></div>
        <span className="overview-follow-selection-count">{selected.length > 0 ? `${selected.length} sélectionné${selected.length > 1 ? 's' : ''}` : 'Aucune sélection'}</span>
      </div>
      <p>Choisis les tâches ou les entrées à suivre. Le suivi d’une tâche lit aussi ses documents liés.</p>
      <input ref={search} type="search" aria-label="Rechercher un élément à suivre" placeholder="Rechercher une tâche, une entrée, un projet…" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
      <p className="ai-hint">Les textes enregistrés des éléments choisis sont envoyés au service IA configuré dans les Paramètres.</p>
      <ul className="overview-follow-choices">
        {visible.map((item) => {
          const key = item.kind + ':' + item.id;
          const included = item.kind === 'entry' ? chosenTasks.find((task) => task.documents.some((doc) => doc.id === item.id)) : undefined;
          return <li key={key}><label>
            <input type="checkbox" disabled={busy} checked={selected.includes(key)} onChange={(event) => setSelected((value) => event.target.checked ? [...value, key] : value.filter((id) => id !== key))} />
            <span><strong>{item.title}</strong><small>{item.kind === 'task' ? 'Tâche' : 'entry_date' in item && item.entry_date === todayISO() ? 'Entrée du jour' : 'Entrée'} · {projects.find((project) => project.id === item.project_id)?.name ?? 'Sans projet'}{included && ` · Déjà incluse avec « ${included.title} »`}</small></span>
          </label></li>;
        })}
      </ul>
      {!visible.length && <p className="empty">{query ? 'Aucun élément trouvé.' : 'Tous les éléments disponibles sont déjà suivis.'}</p>}
      <div className="overview-follow-selection-actions">
        <button className="task-primary" type="button" disabled={busy || !selected.length} onClick={() => void add()}>{busy ? 'Activation…' : `Suivre la sélection${selected.length ? ` (${selected.length})` : ''}`}</button>
        <button className="ghost" type="button" disabled={busy} onClick={close}>Annuler</button>
      </div>
    </section>}
  </div>;
}
