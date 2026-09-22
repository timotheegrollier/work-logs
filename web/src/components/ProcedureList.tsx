import { useState } from 'react';
import { api, plainText, type Attachment, type EntrySummary, type Project } from '../lib';
import { flushPendingSaves } from '../autosave';
import { FileViewer } from './FileViewer';
import { downloadAttachment } from '../attachment-download';

/**
 * Panneau Procédures : les modes d'emploi d'un projet, avec leurs pièces
 * jointes rassemblées. Une procédure est une entrée comme une autre
 * (`kind: 'procedure'`) : même éditeur, mêmes pièces jointes, mêmes
 * sauvegardes — seul l'aiguillage diffère.
 */
export function ProcedureList({
  entries,
  attachments,
  projects,
  projectId,
  selectedId,
  onSelect,
  onEdit,
  onCreate,
  onChanged,
  onDeleted,
}: {
  entries: EntrySummary[];
  attachments: (Attachment & { entry_title: string })[];
  projects: Project[];
  projectId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onCreate: () => void;
  onChanged: () => void;
  onDeleted: (id: string) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const colors = new Map(projects.map((p) => [p.id, p.color]));
  const project = projects.find((p) => p.id === projectId);
  const procedures = entries.filter(
    (entry) => entry.kind === 'procedure' && !entry.archived && (!projectId || entry.project_id === projectId)
  );
  const files = attachments.filter((file) => procedures.some((entry) => entry.id === file.entry_id));

  const attach = async (entryId: string, selected: FileList | null) => {
    if (!selected?.length) return;
    setError('');
    setBusy(true);
    try {
      const results = await Promise.allSettled(Array.from(selected, (file) => api.upload(file, entryId)));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      onChanged();
      setBusy(false);
    }
  };

  const remove = async (entry: EntrySummary) => {
    if (!confirm(`Supprimer la procédure « ${entry.title} » et ses fichiers ?${entry.google_document_id ? ' Le document Google distant sera conservé.' : ''}`)) return;
    setError('');
    setBusy(true);
    try {
      // L'éditeur peut encore avoir une frappe à enregistrer, même masqué.
      await flushPendingSaves();
      await api.deleteEntry(entry.id);
      onDeleted(entry.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recover = async (file: Attachment) => {
    setFetching(true);
    setFetchError('');
    try {
      const updated = await api.fetchDriveAttachment(file.id);
      setPreviewing((current) => current?.id === file.id ? updated : current);
      setPreviewVersion((version) => version + 1);
      onChanged();
    } catch (e) {
      setFetchError((e as Error).message);
    } finally {
      setFetching(false);
    }
  };

  return (
    <section className="procedures" aria-label="Procédures du projet">
      <h2 className="procedures-head">
        Procédures{' '}
        <span className="count" title={`${procedures.length} procédure${procedures.length > 1 ? 's' : ''}`}>
          {procedures.length}
        </span>
        {project && <span className="procedure-project">{project.name}</span>}
      </h2>
      <button className="new-entry" disabled={busy} onClick={onCreate}>
        <span aria-hidden="true">＋</span> Nouvelle procédure
      </button>
      {procedures.length === 0 && (
        <p className="empty">
          {projectId ? `Aucune procédure pour ${project?.name ?? 'ce projet'}.` : 'Aucune procédure pour l’instant.'}
        </p>
      )}
      <ol className="procedure-items">
        {procedures.map((entry) => {
          const entryFiles = files.filter((file) => file.entry_id === entry.id);
          return (
            <li key={entry.id}>
              <button
                className={'entry' + (entry.id === selectedId ? ' is-selected' : '')}
                aria-current={entry.id === selectedId ? 'true' : undefined}
                disabled={busy}
                onClick={() => onSelect(entry.id)}
              >
                <span className="entry-title">
                  {entry.project_id && (
                    <span
                      className="dot"
                      style={{ background: colors.get(entry.project_id) }}
                      aria-hidden="true"
                    />
                  )}
                  {entry.title}
                </span>
                <span className="entry-excerpt">
                  {plainText(entry.excerpt) || 'Vide'}
                  {entry.attachments > 0 && (
                    <span className="clip" title={`${entry.attachments} fichier(s)`}>
                      {' '}📎 {entry.attachments}
                    </span>
                  )}
                </span>
              </button>
              <div className="procedure-row-actions">
                <button className="ghost" disabled={busy} aria-label={`Modifier la procédure ${entry.title}`} onClick={() => onEdit(entry.id)}>
                  Modifier
                </button>
                <button className="ghost danger" disabled={busy} aria-label={`Supprimer la procédure ${entry.title}`} onClick={() => void remove(entry)}>
                  Supprimer
                </button>
                <label className="ghost file-button">
                  ＋ Fichier
                  <input
                    type="file"
                    multiple
                    disabled={busy}
                    aria-label={`Joindre un fichier à ${entry.title}`}
                    onChange={(e) => {
                      void attach(entry.id, e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              {entryFiles.length > 0 && (
                <ul className="procedure-files" aria-label={`Pièces jointes de ${entry.title}`}>
                  {entryFiles.map((file) => (
                    <li key={file.id}>
                      <button
                        className="procedure-file-open"
                        aria-label={`Consulter ${file.filename}`}
                        onClick={() => { setFetchError(''); setPreviewing(file); }}
                      >
                        {file.filename}
                      </button>
                      <a
                        className="ghost"
                        href={api.fileUrl(file.stored)}
                        download={file.filename}
                        aria-label={`Télécharger ${file.filename}`}
                        onClick={(event) => {
                          // Pas de lien `download` direct : la PWA contournerait son service worker.
                          event.preventDefault();
                          setError('');
                          void downloadAttachment(file).catch((e: Error) => setError(e.message));
                        }}
                      >
                        ↓
                      </a>
                      {file.driveFileId
                        ? <small className="picker-source is-google" title="Conservé sur Google Drive">☁ Drive</small>
                        : <small className="picker-source" title="Uniquement sur cet appareil tant que Google Drive n’est pas connecté">local seul</small>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {error && <p role="alert" className="error">{error}</p>}
      {previewing && <FileViewer
        key={`${previewing.id}-${previewVersion}`}
        file={previewing}
        onClose={() => setPreviewing(null)}
        onFetch={() => void recover(previewing)}
        fetching={fetching}
        fetchError={fetchError}
      />}
    </section>
  );
}
