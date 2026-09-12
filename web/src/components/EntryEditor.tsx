import { useEffect, useMemo, useRef, useState } from 'react';
import { api, formatSize, type Attachment, type Entry, type Project } from '../lib';
import { renderMarkdown } from '../markdown';
import { Autosave } from '../autosave';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
const LABELS: Record<SaveState, string> = {
  saved: 'Enregistré',
  dirty: 'Modifications en cours…',
  saving: 'Enregistrement…',
  error: 'Échec de l’enregistrement',
};

/**
 * Éditeur d'une entrée. Rendu avec `key={entry.id}` par le parent : changer
 * d'entrée remonte le composant, donc aucun brouillon ne peut fuir d'une
 * entrée à l'autre.
 */
export function EntryEditor({
  entry,
  projects,
  onChanged,
  onDeleted,
  autoFocusTitle = false,
}: {
  entry: Entry;
  projects: Project[];
  onChanged: () => void;
  onDeleted: () => void;
  autoFocusTitle?: boolean;
}) {
  const [draft, setDraft] = useState({
    title: entry.title,
    content_md: entry.content_md,
    entry_date: entry.entry_date,
    project_id: entry.project_id ?? '',
  });
  const [attachments, setAttachments] = useState<Attachment[]>(entry.attachments ?? []);
  const [save, setSave] = useState<SaveState>('saved');
  const [writing, setWriting] = useState(autoFocusTitle);
  const [error, setError] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const [autosave] = useState(() => new Autosave<typeof draft>(async (body) => {
    if (!body.title.trim()) throw new Error('Le titre de l’entrée est requis.');
    await api.updateEntry(entry.id, { ...body, project_id: body.project_id || null });
    changedRef.current();
  }));

  const update = (patch: Partial<typeof draft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    autosave.update(next);
  };

  // L'aperçu Markdown (marked + DOMPurify) est le rendu le plus coûteux :
  // on ne le recalcule qu'à contenu changeant, pas à chaque changement
  // d'état de sauvegarde qui re-rend l'éditeur.
  const previewHtml = useMemo(() => renderMarkdown(draft.content_md), [draft.content_md]);

  const persist = async () => {
    await autosave.flush().catch(() => {});
  };

  // Changer d’entrée termine aussi l’écriture du brouillon précédent.
  useEffect(() => {
    autosave.onState = (state, message) => { setSave(state); setError(message || ''); };
    return () => {
      autosave.onState = () => {};
      void autosave.flush().catch(() => {});
    };
  }, [autosave]);

  // Ctrl+S enregistre tout de suite, par réflexe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        persist();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const added = await Promise.all(Array.from(files, (file) => api.upload(file, entry.id)));
      setAttachments((prev) => [...added, ...prev]);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeFile = async (file: Attachment) => {
    if (!confirm(`Supprimer « ${file.filename} » ?`)) return;
    await api.deleteAttachment(file.id);
    setAttachments((prev) => prev.filter((a) => a.id !== file.id));
    onChanged();
  };

  const remove = async () => {
    if (!confirm(`Supprimer l’entrée « ${draft.title} » et ses fichiers ?`)) return;
    await autosave.flush();
    await api.deleteEntry(entry.id);
    onDeleted();
  };

  return (
    <section className="editor" aria-label="Entrée">
      <div className="editor-bar no-print">
        <input
          className="title"
          aria-label="Titre de l’entrée"
          value={draft.title}
          autoFocus={autoFocusTitle}
          placeholder="Titre de l’entrée"
          onChange={(e) => update({ title: e.target.value })}
        />
        <span className={'save save-' + save}>{LABELS[save]}</span>
      </div>

      <div className="editor-meta no-print">
        <input
          type="date"
          aria-label="Date de l’entrée"
          value={draft.entry_date}
          onChange={(e) => e.target.value && update({ entry_date: e.target.value })}
        />
        <select
          aria-label="Projet de l’entrée"
          value={draft.project_id}
          onChange={(e) => update({ project_id: e.target.value })}
        >
          <option value="">Sans projet</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <div className="modes" role="group" aria-label="Mode d’affichage">
          <button
            className={writing ? 'is-on' : ''}
            aria-pressed={writing}
            onClick={() => setWriting(true)}
          >
            Écrire
          </button>
          <button
            className={writing ? '' : 'is-on'}
            aria-pressed={!writing}
            onClick={() => setWriting(false)}
          >
            Lire
          </button>
        </div>

        <span className="grow" />
        <button className="ghost" onClick={() => window.print()}>
          Imprimer
        </button>
        <button className="danger" onClick={remove}>
          Supprimer
        </button>
      </div>

      {error && <p className="error no-print">{error}</p>}

      <h1 className="print-only print-title">{draft.title}</h1>

      <div className={'sheet' + (writing ? ' is-split' : '')}>
        {writing && (
          <textarea
            className="source no-print"
            aria-label="Contenu en Markdown"
            placeholder={'## Ce que j’ai fait\n\n- …\n\n> Décision : …'}
            value={draft.content_md}
            onChange={(e) => update({ content_md: e.target.value })}
          />
        )}
        <article
          className="prose"
          aria-label="Aperçu"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      </div>

      <div className="files no-print">
        <label className="ghost file-button">
          📎 Joindre un fichier
          <input
            type="file"
            multiple
            aria-label="Joindre un fichier"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        {attachments.map((file) => (
          <span className="file" key={file.id}>
            <a href={api.fileUrl(file.stored)}>{file.filename}</a>
            <small>{formatSize(file.size)}</small>
            <button
              className="icon"
              aria-label={`Supprimer ${file.filename}`}
              onClick={() => removeFile(file)}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
    </section>
  );
}
