import { useId, useState } from 'react';

/** Préciser une proposition sans appliquer le résultat à la source. */
export function AiRefinement({ busy, onRefine }: { busy: boolean; onRefine: (instruction: string) => void }) {
  const id = useId();
  const [instruction, setInstruction] = useState('');
  const refine = () => {
    if (busy || !instruction.trim()) return;
    onRefine(instruction.trim());
  };
  return (
    <div className="ai-refinement">
      <label htmlFor={id}>Ajuster la proposition</label>
      <div className="ai-refinement-input">
        <input
          id={id}
          value={instruction}
          disabled={busy}
          placeholder="Garder les commandes, détailler les vérifications…"
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); refine(); }
          }}
        />
        <button className="ghost" type="button" disabled={busy || !instruction.trim()} onClick={refine}>Affiner</button>
      </div>
      <div className="task-creator-actions">
        {['Plus court', 'Pour un collègue'].map((shortcut) => (
          <button className="ghost" type="button" disabled={busy} key={shortcut} onClick={() => onRefine(shortcut)}>{shortcut}</button>
        ))}
      </div>
    </div>
  );
}
