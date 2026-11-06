import type { AiWorkContext } from '../ai-suggest';
import { selectedAiContext } from '../ai-context';
import { priorityLabel } from '../lib';

interface Props {
  context: AiWorkContext;
  excludedIds: string[];
  showTaskPlanning?: boolean;
  onExcludedChange: (ids: string[]) => void;
}

/** Les documents complémentaires restent consultables et révocables avant l'envoi. */
export function AiContextDetails({ context, excludedIds, onExcludedChange, showTaskPlanning = false }: Props) {
  const vocabulary = selectedAiContext(context, excludedIds).vocabulary;
  const toggle = (id: string) => onExcludedChange(excludedIds.includes(id)
    ? excludedIds.filter((excluded) => excluded !== id)
    : [...excludedIds, id]);
  return (
    <details className="ai-context-details">
      <summary>Contexte utilisé par l’IA</summary>
      <p>Projet : {context.project || 'Sans projet'}</p>
      {context.projectBrief && <p className="ai-context-brief">Consignes du projet : {context.projectBrief}</p>}
      {!!context.sources?.length ? (
        <fieldset className="ai-context-sources">
          <legend>Documents pour les prochaines demandes</legend>
          <p>Les changements de sélection s’appliquent aux prochaines demandes, y compris aux affinements.</p>
          {context.sources.map((source) => (
            <div key={source.id}>
              <label>
                <input type="checkbox" checked={!excludedIds.includes(source.id)} onChange={() => toggle(source.id)} />
                {source.kind === 'procedure' ? 'Procédure' : 'Note'} : {source.title}
              </label>
              <details className="ai-context-excerpt">
                <summary>Lire l’extrait</summary>
                <pre>{source.text || 'Document vide.'}</pre>
              </details>
            </div>
          ))}
        </fieldset>
      ) : <p>Aucun document complémentaire pertinent.</p>}
      {!!context.relatedTasks?.length && <p>Tâches en cours : {context.relatedTasks.join(' · ')}</p>}
      {!!(showTaskPlanning && context.relatedTaskPlanning?.length) && <div>
        <p>Tâches voisines en cours : priorités et échéances enregistrées</p>
        <ul>{context.relatedTaskPlanning.map((task, index) => <li key={index}>{task.title} — priorité {priorityLabel(task.priority).toLowerCase()} ; échéance {task.due_date || 'non fixée'}</li>)}</ul>
      </div>}
      {!!vocabulary?.length && <p>Vocabulaire du projet : {vocabulary.join(', ')}</p>}
    </details>
  );
}
