import { useEffect, useState } from 'react';
import { api, type Entry, type EntryMergeRequest, type Task } from '../lib';
import { AiCancelled, mergeEntries, readAiSettings } from '../ai-suggest';
import { richToMarkdown } from '../rich-markdown';
// @ts-expect-error — mêmes clés de source que l'API, calculées sur ce qui a été lu.
import { entryMergeSourceKey, isRewritableNote, taskMergeSourceKey } from '../../../api/src/entry-merge.js';

type Proposal = Omit<EntryMergeRequest, 'request_id'>;

/**
 * Fusions d'entrées (§70) et de tâches (§73) : un appel IA propose un texte à
 * partir des sources choisies ; on le relit, puis « Valider » l'écrit et supprime
 * les anciennes. Rien n'est écrit avant. Le `key` du parent remonte le panneau
 * quand les sources changent.
 */
function MergeForm({ label, heading, reading, consequence, titleLabel, textLabel, load, save, onCancel, onMerged }: {
  label: string;
  heading: string;
  reading: string;
  consequence: string;
  titleLabel: string;
  textLabel: string;
  load: () => Promise<{ names: string[]; propose: (signal: AbortSignal) => Promise<Proposal> }>;
  save: (request: EntryMergeRequest) => Promise<Entry>;
  onCancel: () => void;
  onMerged: (entry: Entry) => void;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [proposal, setProposal] = useState<EntryMergeRequest | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setProposal(null);
    setError('');
    void (async () => {
      try {
        const loaded = await load();
        if (controller.signal.aborted) return;
        setNames(loaded.names);
        const proposed = await loaded.propose(controller.signal);
        if (controller.signal.aborted) return;
        // Un identifiant par proposition : revalider après une réponse perdue rend le même résultat.
        setProposal({ request_id: crypto.randomUUID(), ...proposed });
      } catch (e) {
        if (!controller.signal.aborted && !(e instanceof AiCancelled)) setError((e as Error).message);
      }
    })();
    return () => controller.abort();
    // `load` change à chaque rendu : seul « Réessayer » relance, le `key` couvre les sources.
  }, [attempt]);

  const edit = (patch: Partial<EntryMergeRequest>) => setProposal((current) => current && { ...current, ...patch });

  const validate = async () => {
    if (!proposal || saving) return;
    setSaving(true);
    setError('');
    try {
      onMerged(await save(proposal));
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <form
      className="editor proofread-preview entry-merge"
      aria-label={label}
      aria-busy={!proposal && !error}
      onSubmit={(event) => {
        event.preventDefault();
        void validate();
      }}
    >
      <strong>{heading}</strong>
      <small>
        {names.length ? names.join(' · ') : reading}
        {' — '}{consequence}
      </small>
      {!proposal && !error && <p role="status">✨ Fusion en cours…</p>}
      {proposal && (
        <>
          <label>
            Titre
            <input aria-label={titleLabel} value={proposal.title} disabled={saving} onChange={(event) => edit({ title: event.target.value })} />
          </label>
          <textarea aria-label={textLabel} rows={16} value={proposal.content_md} disabled={saving} onChange={(event) => edit({ content_md: event.target.value })} />
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="task-creator-actions">
        <button className="task-primary" type="submit" disabled={!proposal || saving || !proposal.title.trim() || !proposal.content_md.trim()}>
          {saving ? 'Fusion…' : 'Valider la fusion'}
        </button>
        {error && !proposal && <button className="ghost" type="button" onClick={() => setAttempt(attempt + 1)}>Réessayer</button>}
        <button className="ghost" type="button" disabled={saving} onClick={onCancel}>Annuler</button>
      </div>
    </form>
  );
}

export function EntryMerge({ ids, onCancel, onMerged }: {
  ids: string[];
  onCancel: () => void;
  onMerged: (entry: Entry) => void;
}) {
  return (
    <MergeForm
      label="Fusion d’entrées"
      heading={`Fusionner ${ids.length} entrées — relis avant de valider`}
      reading="Lecture des entrées…"
      consequence="elles seront remplacées par celle-ci ; leurs pièces jointes et tâches liées la suivent."
      titleLabel="Titre de l’entrée fusionnée"
      textLabel="Texte de l’entrée fusionnée"
      load={async () => {
        const entries = await Promise.all(ids.map((id) => api.entry(id)));
        return {
          names: entries.map((entry) => entry.title),
          propose: async (signal) => ({
            sources: entries.map((entry) => ({ id: entry.id, source_key: entryMergeSourceKey(entry) })),
            // Le texte plat d'une note riche perdrait liens et images, et les sources sont supprimées ensuite.
            ...await mergeEntries({ ...readAiSettings(), signal }, entries.map((entry) => ({ ...entry, content_md: entry.content_json ? richToMarkdown(entry.content_json) : entry.content_md }))),
          }),
        };
      }}
      save={(request) => api.mergeEntries(request)}
      onCancel={onCancel}
      onMerged={onMerged}
    />
  );
}

export function TaskMerge({ tasks, onCancel, onMerged }: {
  tasks: Task[];
  onCancel: () => void;
  onMerged: (entry: Entry) => void;
}) {
  return (
    <MergeForm
      label="Fusion de tâches"
      heading={`Fusionner ${tasks.length} tâches — relis avant de valider`}
      reading="Lecture des tâches…"
      consequence="une seule note de tâche réunira leur contenu et leurs pièces jointes. Les documents de référence resteront liés."
      titleLabel="Titre de la tâche fusionnée"
      textLabel="Note de la tâche fusionnée"
      load={async () => {
        const documents = await Promise.all(tasks.map((task) => Promise.all(task.documents.map((document) => api.entry(document.id)))));
        const seen = new Set<string>();
        const sources = tasks.map((task, index) => ({
          title: task.title,
          content_md: documents[index]
            // Une note liée à deux tâches choisies ne part qu'une fois chez le fournisseur IA.
            .filter((note) => note.id === task.entry_id && isRewritableNote(note) && !seen.has(note.id) && seen.add(note.id))
            .map((note) => `### ${note.title} (${note.entry_date})\n${note.content_json ? richToMarkdown(note.content_json) : note.content_md}`)
            .join('\n\n'),
        }));
        return {
          names: tasks.map((task) => task.title),
          propose: async (signal) => ({
            sources: tasks.map((task, index) => ({ id: task.id, source_key: taskMergeSourceKey(task, documents[index]) })),
            ...await mergeEntries({ ...readAiSettings(), signal }, sources, { tasks: true }),
          }),
        };
      }}
      save={(request) => api.mergeTasks(request)}
      onCancel={onCancel}
      onMerged={onMerged}
    />
  );
}
