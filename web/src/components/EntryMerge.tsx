import { useEffect, useState } from 'react';
import { api, type Entry, type EntryMergeRequest } from '../lib';
import { AiCancelled, mergeEntries, readAiSettings } from '../ai-suggest';
// @ts-expect-error — même clé de source que l'API, calculée sur l'entrée lue.
import { entryMergeSourceKey } from '../../../api/src/entry-merge.js';

/**
 * Fusion d'entrées (§70) : un appel IA propose une seule note à partir des
 * entrées choisies ; on la relit, puis « Valider » la crée et supprime les
 * anciennes. Rien n'est écrit avant.
 */
export function EntryMerge({ ids, onCancel, onMerged }: {
  ids: string[];
  onCancel: () => void;
  onMerged: (entry: Entry) => void;
}) {
  const [sources, setSources] = useState<Entry[]>([]);
  const [proposal, setProposal] = useState<{ request: EntryMergeRequest } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setProposal(null);
    setError('');
    void (async () => {
      try {
        const entries = await Promise.all(ids.map((id) => api.entry(id)));
        if (controller.signal.aborted) return;
        setSources(entries);
        const merged = await mergeEntries({ ...readAiSettings(), signal: controller.signal }, entries);
        if (controller.signal.aborted) return;
        // Un identifiant par proposition : revalider après une réponse perdue rend la même entrée.
        setProposal({ request: {
          request_id: crypto.randomUUID(),
          sources: entries.map((entry) => ({ id: entry.id, source_key: entryMergeSourceKey(entry) })),
          ...merged,
        } });
      } catch (e) {
        if (!controller.signal.aborted && !(e instanceof AiCancelled)) setError((e as Error).message);
      }
    })();
    return () => controller.abort();
  }, [ids, attempt]);

  const edit = (patch: Partial<EntryMergeRequest>) => setProposal((current) => current && { request: { ...current.request, ...patch } });

  const validate = async () => {
    if (!proposal || saving) return;
    setSaving(true);
    setError('');
    try {
      onMerged(await api.mergeEntries(proposal.request));
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <form
      className="editor proofread-preview entry-merge"
      aria-label="Fusion d’entrées"
      aria-busy={!proposal && !error}
      onSubmit={(event) => {
        event.preventDefault();
        void validate();
      }}
    >
      <strong>Fusionner {ids.length} entrées — relis avant de valider</strong>
      <small>
        {sources.length ? sources.map((entry) => entry.title).join(' · ') : 'Lecture des entrées…'}
        {' — '}elles seront remplacées par celle-ci ; leurs pièces jointes et tâches liées la suivent.
      </small>
      {!proposal && !error && <p role="status">✨ Fusion en cours…</p>}
      {proposal && (
        <>
          <label>
            Titre
            <input aria-label="Titre de l’entrée fusionnée" value={proposal.request.title} disabled={saving} onChange={(event) => edit({ title: event.target.value })} />
          </label>
          <textarea aria-label="Texte de l’entrée fusionnée" rows={16} value={proposal.request.content_md} disabled={saving} onChange={(event) => edit({ content_md: event.target.value })} />
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="task-creator-actions">
        <button className="task-primary" type="submit" disabled={!proposal || saving || !proposal.request.title.trim() || !proposal.request.content_md.trim()}>
          {saving ? 'Fusion…' : 'Valider la fusion'}
        </button>
        {error && !proposal && <button className="ghost" type="button" onClick={() => setAttempt(attempt + 1)}>Réessayer</button>}
        <button className="ghost" type="button" disabled={saving} onClick={onCancel}>Annuler</button>
      </div>
    </form>
  );
}
