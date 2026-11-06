import { useEffect, useState } from 'react';

export type UpdatePhase = 'download' | 'install' | 'done' | 'error' | 'idle';

export interface UpdateProgress {
  phase: UpdatePhase;
  /** 0–100 quand la progression est mesurée, sinon barre animée indéterminée. */
  percent?: number;
  label?: string;
}

/**
 * Fine barre de progression des mises à jour : téléchargement déterminé,
 * installation animée, disparition automatique. Pilotée par le main process
 * via `worklogsDesktop.onUpdateProgress` — sans bridge, rien ne s'affiche.
 */
export function UpdateBar() {
  const [state, setState] = useState<UpdateProgress>({ phase: 'idle' });

  useEffect(() => window.worklogsDesktop?.onUpdateProgress?.(setState), []);

  useEffect(() => {
    if (state.phase !== 'done' && state.phase !== 'error') return;
    const timer = setTimeout(() => setState({ phase: 'idle' }), 2500);
    return () => clearTimeout(timer);
  }, [state.phase]);

  if (state.phase === 'idle') return null;

  const measured = typeof state.percent === 'number';
  const label =
    state.label ??
    (state.phase === 'download'
      ? `Téléchargement${measured ? ` ${state.percent} %` : '…'}`
      : state.phase === 'install'
        ? 'Installation…'
        : state.phase === 'done'
          ? 'Mise à jour prête'
          : 'Échec de la mise à jour');

  return (
    <div className="update-progress" role="status" aria-label={label}>
      <div
        className={'update-progress-bar' + (measured ? '' : ' is-indeterminate')}
        style={measured ? { width: `${state.percent}%` } : undefined}
      />
      <span className="update-progress-label">{label}</span>
    </div>
  );
}
