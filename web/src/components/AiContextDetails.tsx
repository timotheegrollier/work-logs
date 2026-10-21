import type { AiWorkContext } from '../ai-suggest';

interface Props {
  context: AiWorkContext;
  excludedIds: string[];
  onExcludedChange: (ids: string[]) => void;
}

/** Les documents complémentaires restent consultables et révocables avant l'envoi. */
export function AiContextDetails({ context, excludedIds, onExcludedChange }: Props) {
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
      {!!context.vocabulary?.length && <p>Vocabulaire du projet : {context.vocabulary.join(', ')}</p>}
    </details>
  );
}
