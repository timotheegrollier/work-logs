import { useEffect, useMemo, useState } from 'react';
import { api, todayISO, type Entry } from '../lib';
import type { DraftedProcedure } from '../ai-suggest';
import { renderMarkdown } from '../markdown';
import { markdownToRich } from '../rich-markdown';

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
  onCreated,
  onClose,
}: {
  draft: DraftedProcedure;
  projectId: string | null;
  /** Une nouvelle rédaction est en cours (Rafraîchir). */
  busy: boolean;
  onRefresh: () => void;
  onCreated: (procedure: Entry) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  // Rafraîchir apporte un nouveau titre avec le nouveau texte.
  useEffect(() => setTitle(draft.title), [draft]);
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
      onCreated(created);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <form
      className="proofread-preview procedure-draft no-print"
      aria-label="Procédure rédigée"
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
        <input aria-label="Titre de la procédure" value={title} disabled={creating} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="task-creator-actions">
        <button className="task-primary" type="submit" disabled={creating || busy || !title.trim()}>
          {creating ? 'Création…' : 'Créer la procédure'}
        </button>
        <button className="ghost" type="button" disabled={creating || busy} onClick={onRefresh}>
          {busy ? 'Rédaction…' : 'Rafraîchir'}
        </button>
        {/* Pendant une rédaction, fermer ne l'arrêterait pas : sa réponse rouvrirait le panneau. */}
        <button className="ghost" type="button" disabled={creating || busy} onClick={onClose}>
          Ignorer
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
