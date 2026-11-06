import { useCallback, useMemo, useState } from 'react';
import { api, todayISO, type AppState, type EntrySummary } from '../lib';
import { mergeEntries, type MergeContext } from '../ai-suggest';

/** Fusion : séléctionner plusieurs entrées, l'IA propose une nouvelle entrée
 * qui réajuste leur contenu. Validation = suppression des anciennes, conservation
 * de la nouvelle. */
export function EntryMerge({ state, selectedIds = [], onDone }: {
  state: AppState | null;
  selectedIds: string[];
  onDone: () => void;
}) {
  const entries = useMemo(() => new Map(state?.entries ?? []).set(null, null), [state?.entries]);
  const selected = selectedIds
    .map((id) => entries.get(id))
    .filter((entry): entry is EntrySummary => Boolean(entry));
  const [proposal, setProposal] = useState<{ title: string; content_md: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [validating, setValidating] = useState(false);

  const selectedContexts = useMemo<MergeContext[]>(
    () => selected.map((entry) => ({
      id: entry.id,
      source_key: entry.source_key ?? '',
      title: entry.title,
      content_md: entry.content_md ?? '',
      entry_date: entry.entry_date,
      project_id: entry.project_id ?? null,
      category_id: entry.category_id ?? null,
      archived: entry.archived,
      kind: entry.kind,
      updated_at: entry.updated_at,
      follow_up: entry.follow_up ?? null,
      follow_up_key: entry.follow_up_key ?? '',
    })),
    [selected]
  );

  const propose = useCallback(async () => {
    if (selectedContexts.length < 2) return;
    setBusy(true);
    setError('');
    try {
      const merge = await mergeEntries({ endpoint: '', model: '', key: '', profile: '' }, selectedContexts, {
        today: todayISO(),
      });
      setProposal(merge);
    } catch (e) {
      setError((e as Error).message || 'Impossible de proposer la fusion.');
      setProposal(null);
    } finally {
      setBusy(false);
    }
  }, [selectedContexts]);

  const merge = useCallback(async () => {
    if (!proposal || !state) return;
    setValidating(true);
    setError('');
    try {
      const body: EntryMergeRequest = {
        request_id: 'en_merge_' + crypto.randomUUID(),
        sources: selected.map((entry) => ({ id: entry.id, source_key: entry.source_key ?? '' })),
        title: proposal.title,
        content_md: proposal.content_md,
      };
      const merged = await api.mergeEntries(body);
      setValidatedId(merged.id);
      onDone();
    } catch (e) {
      setError((e as Error).message || 'Impossible de créer la nouvelle entrée.');
    } finally {
      setValidating(false);
    }
  }, [proposal, state, selected]);

  const deselect = (id: string) => {
    onDone({ selectedIds: selectedIds.filter((item) => item !== id) });
  };

  return (
    <div className="entry-merge">
      <div className="entry-merge-head">
        <h3>Fusionner {selected.length} entrée{selected.length > 1 ? 's' : ''}</h3>
        {selected.length >= 2 && (
          <button className="task-primary" type="button" onClick={propose} disabled={busy}>
            {busy ? 'IA en cours…' : 'Proposer la fusion'}
          </button>
        )}
      </div>
      {selected.length < 2 && (
        <p className="notice">Sélectionnez au moins deux entrées pour les fusionner.</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {proposal && (
        <div className="entry-merge-proposal">
          <div className="entry-merge-fields">
            <label>Titre
              <input aria-label="Titre de la nouvelle entrée" value={proposal.title} onChange={(e) => setProposal({ ...proposal, title: e.target.value })} />
            </label>
            <div className="entry-merge-inline">
                            <span className="entry-merge-spacer" />
              <button className="task-primary" type="button" onClick={merge} disabled={validating}>
                {validating ? 'Création…' : 'Valider la fusion'}
              </button>
            </div>
          </div>
          <textarea
            aria-label="Contenu proposé"
            value={proposal.content_md}
            onChange={(e) => setProposal({ ...proposal, content_md: e.target.value })}
            rows={12}
            className="entry-merge-text"
          />
          <p className="ai-hint">L'IA a réuni les faits et les commandes des entrées sélectionnées. Relisez avant de valider : les anciennes entrées seront supprimées.</p>
          <div className="entry-merge-sources">
            {selected.map((entry) => (
              <div key={entry.id} className="entry-merge-source">
                <strong>{entry.title}</strong>
                <button className="link" type="button" onClick={() => deselect(entry.id)}>Retirer</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


