import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, formatSize, type Project, type ProjectFile } from '../lib';
import { deleteAttachmentQuestion, downloadAttachment } from '../attachment-download';
import { FileIcon } from './FileIcon';
import { FileViewer } from './FileViewer';

const UNASSIGNED = '__none__';
const groupKey = (file: ProjectFile) => file.project_id ?? UNASSIGNED;
const groupName = (file: ProjectFile) => file.project_name ?? 'Sans projet';

/**
 * Panneau « Fichiers des projets » (menu du compte) : toutes les pièces jointes
 * des entrées, rangées par projet. Chaque fichier s'ouvre dans la visionneuse
 * (les tableurs s'y modifient), se télécharge, s'ouvre dans son entrée ou se
 * supprime — sans quitter le panneau.
 */
export function ProjectFiles({ projects, onClose, onOpenEntry, onSharedFolder, onChanged }: {
  projects: Project[];
  onClose: () => void;
  onOpenEntry: (id: string, project: string | null) => void;
  /** Colonne Procédures ouverte sur ce projet, dossiers reliés visibles. */
  onSharedFolder?: (projectId: string) => void;
  onChanged: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [revision, setRevision] = useState(0);
  const [previewing, setPreviewing] = useState<ProjectFile | null>(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
  }, []);

  useEffect(() => {
    let alive = true;
    setError('');
    void api.projectFiles().then((next) => {
      if (!alive) return;
      setFiles(next);
      setLoaded(true);
    }).catch((e: Error) => {
      if (!alive) return;
      setError(e.message);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [revision]);

  const needle = filter.trim().toLocaleLowerCase();
  const groups = useMemo(() => {
    const visible = files.filter((file) => {
      if (projectFilter && groupKey(file) !== projectFilter) return false;
      if (!needle) return true;
      return [file.filename, file.entry_title, groupName(file)].some((text) => text.toLocaleLowerCase().includes(needle));
    });
    const map = new Map<string, ProjectFile[]>();
    for (const file of visible) {
      const key = groupKey(file);
      map.set(key, [...(map.get(key) ?? []), file]);
    }
    return [...map.entries()]
      .map(([id, items]) => ({ id, files: items, name: groupName(items[0]), project: projects.find((project) => project.id === id) ?? null }))
      .sort((a, b) => (a.id === UNASSIGNED ? 1 : b.id === UNASSIGNED ? -1 : a.name.localeCompare(b.name, 'fr')));
  }, [files, filter, needle, projectFilter, projects]);

  const chips = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const file of files) {
      const id = groupKey(file);
      const current = map.get(id);
      map.set(id, { id, name: groupName(file), count: (current?.count ?? 0) + 1 });
    }
    return [...map.values()].sort((a, b) => (a.id === UNASSIGNED ? 1 : b.id === UNASSIGNED ? -1 : a.name.localeCompare(b.name, 'fr')));
  }, [files]);

  const remove = async (file: ProjectFile) => {
    if (!confirm(deleteAttachmentQuestion(file))) return;
    setBusy(file.id);
    setError('');
    setNotice('');
    try {
      await api.deleteAttachment(file.id);
      setFiles((current) => current.filter((candidate) => candidate.id !== file.id));
      if (previewing?.id === file.id) setPreviewing(null);
      setNotice(`« ${file.filename} » supprimé.`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const total = files.length;
  return createPortal((
    <dialog
      className="drive-dialog files-dialog"
      aria-label="Fichiers des projets"
      aria-modal="true"
      ref={dialogRef}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <div className="drive-dialog-heading">
        <h2>Fichiers des projets</h2>
        <button className="ghost" type="button" onClick={onClose}>Fermer</button>
      </div>
      <div className="drive-content files-content">
        <div className="files-toolbar">
          <input
            type="search"
            aria-label="Filtrer les fichiers"
            placeholder="Rechercher un fichier, une entrée…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <span className="files-total">{total} fichier{total > 1 ? 's' : ''}</span>
        </div>
        <div className="files-chips" role="group" aria-label="Filtrer les fichiers par projet">
          <button type="button" className={'chip' + (projectFilter === '' ? ' is-on' : '')} aria-pressed={projectFilter === ''} onClick={() => setProjectFilter('')}>Tous</button>
          {chips.map((chip) => (
            <button key={chip.id} type="button" className={'chip' + (projectFilter === chip.id ? ' is-on' : '')}
              aria-pressed={projectFilter === chip.id} onClick={() => setProjectFilter(projectFilter === chip.id ? '' : chip.id)}>
              {chip.name}<span className="count">{chip.count}</span>
            </button>
          ))}
        </div>
        {!loaded && <p role="status">Chargement des fichiers…</p>}
        {loaded && !error && !groups.length && (
          <p className="files-empty">{files.length ? 'Aucun fichier ne correspond.' : 'Aucun fichier importé dans les projets.'}</p>
        )}
        {groups.map((group) => {
          const dirs = group.project?.shared_dirs?.filter(Boolean) ?? [];
          const size = group.files.reduce((sum, file) => sum + (file.size || 0), 0);
          return (
            <section className="project-files-group" key={group.id} aria-label={`Fichiers du projet ${group.name}`}>
              <header className="project-files-heading">
                <span className="dot" aria-hidden="true" style={group.project ? { background: group.project.color } : undefined} />
                <h3>{group.name}</h3>
                <small>{group.files.length} fichier{group.files.length > 1 ? 's' : ''} · {formatSize(size)}</small>
              </header>
              {dirs.length > 0 && onSharedFolder && group.project && (
                <p className="project-files-dirs">
                  <span>Dossier{dirs.length > 1 ? 's' : ''} partagé{dirs.length > 1 ? 's' : ''} :</span>
                  {dirs.map((dir) => (
                    <button key={dir} type="button" className="ghost"
                      aria-label={`Ouvrir le dossier partagé de ${group.project!.name} (${dir})`}
                      onClick={() => { onSharedFolder(group.project!.id); onClose(); }}>
                      {dir} ↗
                    </button>
                  ))}
                </p>
              )}
              <ul className="project-files-list">
                {group.files.map((file) => (
                  <li key={file.id} aria-busy={busy === file.id}>
                    <button type="button" className="project-file-name" aria-label={`Ouvrir ${file.filename}`} onClick={() => setPreviewing(file)}>
                      <FileIcon name={file.filename} />
                      <span>
                        <strong>{file.filename}</strong>
                        <small>{formatSize(file.size)} · {new Date(file.created_at).toLocaleDateString('fr-FR')}</small>
                      </span>
                    </button>
                    <button type="button" className="ghost project-file-entry" title="Ouvrir l’entrée"
                      aria-label={`Ouvrir l’entrée ${file.entry_title}`}
                      onClick={() => { onOpenEntry(file.entry_id, file.project_id); onClose(); }}>
                      {file.entry_title}
                    </button>
                    <small className={'picker-source' + (file.driveFileId ? ' is-google' : '')}
                      title={file.driveFileId ? 'Conservé sur Google Drive' : 'Uniquement sur cet appareil'}>
                      {file.driveFileId ? '☁ Drive' : 'local seul'}
                    </small>
                    <span className="project-file-actions">
                      <button type="button" className="ghost" disabled={busy === file.id}
                        aria-label={`Télécharger ${file.filename}`} title="Télécharger"
                        onClick={() => { setError(''); void downloadAttachment(file).catch((e: Error) => setError(e.message)); }}>↓</button>
                      <button type="button" className="icon" disabled={busy === file.id}
                        aria-label={`Supprimer ${file.filename}`} title="Supprimer la pièce jointe"
                        onClick={() => void remove(file)}>✕</button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {notice && <p className="drive-success" role="status">{notice}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      {previewing && createPortal(
        <FileViewer
          key={previewing.id}
          file={previewing}
          onClose={() => setPreviewing(null)}
          onSaved={(updated) => { setPreviewing((current) => current ? { ...current, ...updated } : current); setRevision((value) => value + 1); onChanged(); }}
        />,
        document.body,
      )}
    </dialog>
  ), document.body);
}
