import { useState } from 'react';
import { api, plainText, type Attachment, type EntrySummary, type Project } from '../lib';

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
  onCreate,
  onChanged,
}: {
  entries: EntrySummary[];
  attachments: (Attachment & { entry_title: string })[];
  projects: Project[];
  projectId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const colors = new Map(projects.map((p) => [p.id, p.color]));
  const project = projects.find((p) => p.id === projectId);
  const procedures = entries.filter(
    (entry) => entry.kind === 'procedure' && !entry.archived && (!projectId || entry.project_id === projectId)
  );
  const files = attachments.filter((file) => procedures.some((entry) => entry.id === file.entry_id));

  const attach = async (entryId: string, selected: FileList | null) => {
    if (!selected?.length) return;
    setError('');
    try {
      await Promise.all(Array.from(selected, (file) => api.upload(file, entryId)));
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <details className="procedures" role="group" aria-label="Procédures du projet" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Procédures{' '}
        <span className="count" title={`${procedures.length} procédure${procedures.length > 1 ? 's' : ''}`}>
          {procedures.length}
        </span>
        {project && <span className="procedure-project">{project.name}</span>}
      </summary>
      {open && (
        <>
          <button className="new-entry" onClick={onCreate}>
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
                    <label className="ghost file-button">
                      ＋ Fichier
                      <input
                        type="file"
                        multiple
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
                          <a href={api.fileUrl(file.stored)} download={file.filename}>
                            {file.filename}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </details>
  );
}
