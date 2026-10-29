import { useEffect, useMemo, useRef, useState } from 'react';
import { api, todayISO, type Entry } from '../lib';
import type { DraftedProcedure } from '../ai-suggest';
import { renderMarkdown } from '../markdown';
import { markdownToRich } from '../rich-markdown';
import { AiRefinement } from './AiRefinement';

/**
 * Procédure rédigée par l'IA depuis une entrée ou une tâche : on la relit, on
 * ajuste son titre, puis on la crée — rien n'est enregistré avant. Elle naît à
 * part, dans le projet de sa source, sans lien vers elle (décision §31) : la
 * source ne change pas.
 */
export function ProcedureDraft({
  draft,
  projectId,
  busy,
  onRefresh,
  onCancel,
  onCreated,
  onClose,
}: {
  draft: DraftedProcedure;
  projectId: string | null;
  /** Une nouvelle rédaction est en cours (Rafraîchir). */
  busy: boolean;
  onRefresh: (instruction?: string) => void;
  /** Arrêter la rédaction en cours, là où le menu ✨ IA n'est pas à l'écran (carte de tâche). */
  onCancel?: () => void;
  onCreated: (procedure: Entry) => void;
  onClose: () => void;
}) {
  // Une nouvelle proposition renouvelle son titre dès le rendu. Une copie dans
  // useEffect pouvait se jouer après la première saisie et la remplacer.
  const [editedTitle, setEditedTitle] = useState({ draft, value: draft.title });
  const title = editedTitle.draft === draft ? editedTitle.value : draft.title;
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const html = useMemo(() => renderMarkdown(draft.markdown), [draft.markdown]);

  const create = async () => {
    const name = title.trim();
    if (!name || creating) return;
    setCreating(true);
    setError('');
    try {
      // Même pont que « Appliquer la procédure » : ce qui s'affiche ici s'enregistre.
      const created = await api.createEntry({
        title: name,
        entry_date: todayISO(),
        project_id: projectId,
        kind: 'procedure',
        content_json: markdownToRich(draft.markdown),
      });
      if (mounted.current) onCreated(created);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setCreating(false);
    }
  };

  return (
    <form
      className="proofread-preview procedure-draft no-print"
      aria-label="Procédure rédigée"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <strong>Procédure rédigée — relis avant de la créer</strong>
      <small>Elle rejoindra la colonne Procédures ; la source ne change pas.</small>
      {draft.truncated && <small>Source longue : l’IA n’en a lu que le début.</small>}
      <label>
        Titre de la procédure
        <input aria-label="Titre de la procédure" value={title} disabled={creating} onChange={(event) => setEditedTitle({ draft, value: event.target.value })} />
      </label>
      <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      <AiRefinement busy={busy || creating} onRefine={onRefresh} />
      <div className="task-creator-actions">
        <button className="task-primary" type="submit" disabled={creating || busy || !title.trim()}>
          {creating ? 'Création…' : 'Créer la procédure'}
        </button>
        <button className={'ghost' + (busy ? ' ai-busy' : '')} type="button" disabled={creating || busy} onClick={() => onRefresh()}>
          {busy ? 'Rédaction…' : 'Rafraîchir'}
        </button>
        {busy && onCancel && <button className="ghost" type="button" aria-label="Arrêter la demande IA" onClick={onCancel}>Arrêter</button>}
        {/* Pendant une rédaction, fermer ne l'arrêterait pas : sa réponse rouvrirait le panneau. */}
        <button className="ghost" type="button" disabled={creating || busy} onClick={onClose}>
          Ignorer
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
