import type { EntrySummary, Status, Task } from '../lib';

/** Les gestes d'une carte de suivi : le statut se lit et se change au même endroit. */
export function OverviewTaskActions({ task, disabled, onStatus }: {
  task: Task;
  disabled: boolean;
  onStatus: (task: Task, status: Status) => void;
}) {
  return <div className="overview-item-actions overview-task-actions" role="group" aria-label={`Actions de la tâche ${task.title}`}>
    <select aria-label={`Statut de ${task.title}`} disabled={disabled} value={task.status} onChange={(event) => onStatus(task, event.target.value as Status)}>
      <option value="todo">À faire</option><option value="doing">En cours</option><option value="done">Terminée</option>
    </select>
    {task.status === 'done'
      ? <button className="ghost overview-task-reopen" type="button" aria-label={`Rouvrir la tâche ${task.title}`} disabled={disabled} onClick={() => onStatus(task, 'todo')}>Rouvrir</button>
      : <button className="task-primary overview-task-validate" type="button" aria-label={`Valider la tâche ${task.title}`} title={task.documents.length ? 'Termine la tâche et archive ses documents liés' : 'Marquer la tâche comme terminée'} disabled={disabled} onClick={() => onStatus(task, 'done')}>✓ Valider</button>}
  </div>;
}

export function OverviewEntryActions({ entry, disabled, onArchive }: {
  entry: EntrySummary;
  disabled: boolean;
  onArchive: (entry: EntrySummary) => void;
}) {
  return <div className="overview-item-actions overview-entry-actions" role="group" aria-label={`Actions de l’entrée ${entry.title}`}>
    <button className="ghost" type="button" aria-label={`${entry.archived ? 'Désarchiver' : 'Archiver'} l’entrée ${entry.title}`} disabled={disabled} onClick={() => onArchive(entry)}>{entry.archived ? 'Désarchiver' : 'Archiver'}</button>
  </div>;
}
