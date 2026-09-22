import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, googleHelpUrl, type Entry, type GoogleFile, type Project } from '../lib';

const isPwa = import.meta.env.VITE_PWA === '1';

/**
 * Documents Google dans leur propre fenêtre (ouverte depuis le menu du compte) :
 * ouvrir, ranger dans un projet, mettre à la corbeille Drive, créer. Le dialogue
 * Google Drive des Paramètres ne garde que la connexion et les sauvegardes.
 */
export function GoogleDocuments({ projects, onClose, onOpen, onChanged }: {
  projects: Project[];
  onClose: () => void;
  onOpen: (entry: Entry) => void;
  onChanged: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<GoogleFile[]>([]);
  const [page, setPage] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState('');
  const [error, setError] = useState('');
  const [helpUrl, setHelpUrl] = useState('');
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
  }, []);

  const run = async (action: () => Promise<void>, row = '') => {
    setBusy(true);
    setRowBusy(row);
    setError('');
    setHelpUrl('');
    setMessage('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      setHelpUrl(googleHelpUrl(e));
    } finally {
      setBusy(false);
      setRowBusy('');
    }
  };
  const refresh = async (token = '') => {
    const result = await api.googleDocuments(token);
    setFiles((current) => Array.from(new Map((token ? [...current, ...result.files] : result.files).map((file) => [file.id, file])).values()));
    setPage(result.nextPageToken || '');
    setWarnings(result.warnings || []);
    setLoaded(true);
  };
  useEffect(() => {
    void run(() => refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (id: string, next: Partial<GoogleFile>) =>
    setFiles((current) => current.map((file) => (file.id === id ? { ...file, ...next } : file)));

  const open = (file: GoogleFile) => run(async () => {
    const entry = await api.openGoogleDocument(file.id);
    patch(file.id, { linked: true });
    onOpen(entry);
    onClose();
  }, file.id);

  const assign = (file: GoogleFile, projectId: string) => run(async () => {
    // Jamais ouvert : la copie locale est créée d'abord, puis rangée.
    if (!file.linked) await api.openGoogleDocument(file.id);
    const result = await api.setGoogleDocumentProject(file.id, projectId || null);
    patch(file.id, { linked: true, project_id: result.project_id });
    const name = projects.find((project) => project.id === projectId)?.name;
    setMessage(name ? `« ${file.name} » rangé dans ${name}.` : `« ${file.name} » retiré de son projet.`);
    onChanged();
  }, file.id);

  const trash = (file: GoogleFile) => {
    if (!confirm(`Mettre « ${file.name} » à la corbeille Google Drive ? Il reste récupérable 30 jours dans Drive ; sa copie dans WorkLogs est retirée.`)) return;
    void run(async () => {
      await api.trashGoogleDocument(file.id);
      setFiles((current) => current.filter((candidate) => candidate.id !== file.id));
      setMessage(`« ${file.name} » est dans la corbeille Google Drive.`);
      onChanged();
    }, file.id);
  };

  const create = () => run(async () => {
    const entry = await api.createGoogleDocument(title.trim());
    setCreating(false);
    setTitle('');
    onChanged();
    onOpen(entry);
    onClose();
  });

  const visible = files.filter((file) => file.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  return createPortal((
    <dialog
      className="drive-dialog documents-dialog"
      aria-label="Documents Google"
      aria-modal="true"
      ref={dialogRef}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <div className="drive-dialog-heading">
        <h2>Documents Google</h2>
        <button className="ghost" type="button" onClick={onClose}>Fermer</button>
      </div>
      <div className="drive-content">
        <div className="documents-toolbar">
          <input type="search" aria-label="Filtrer les documents Drive" placeholder="Rechercher un document…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className="primary" disabled={busy} onClick={() => setCreating(!creating)}>＋ Nouveau Google Docs</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => refresh())}>Actualiser</button>
          {!isPwa && (
            <button type="button" className="ghost" disabled={busy} title="Accorder à WorkLogs l’accès à d’autres documents, dans le navigateur"
              onClick={() => void run(async () => { await api.connectGoogle(); setMessage('Choisis les documents dans ton navigateur, puis Actualiser.'); })}>
              Autoriser d’autres documents
            </button>
          )}
        </div>
        {creating && (
          <form className="drive-create" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            <label>Titre du nouveau document<input autoFocus required maxLength={240} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <button type="submit" disabled={busy || !title.trim()}>Créer et ouvrir</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setCreating(false)}>Annuler la création</button>
          </form>
        )}
        <ul className="documents-list" aria-label="Documents autorisés pour WorkLogs">
          {visible.map((file) => (
            <li key={file.id} aria-busy={rowBusy === file.id}>
              <button type="button" className="documents-name" disabled={busy} onClick={() => void open(file)} title="Ouvrir dans WorkLogs">
                <strong>{file.name}</strong>
                <small>{file.modifiedTime ? `Modifié le ${new Date(file.modifiedTime).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Date inconnue'}{file.linked ? ' · dans WorkLogs' : ''}</small>
              </button>
              <select aria-label={`Projet de ${file.name}`} value={file.project_id || ''} disabled={busy} onChange={(e) => void assign(file, e.target.value)}>
                <option value="">Sans projet</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <button type="button" className="ghost" disabled={busy} aria-label={`Ouvrir ${file.name}`} onClick={() => void open(file)}>Ouvrir</button>
              <button type="button" className="ghost danger-text" disabled={busy} aria-label={`Mettre ${file.name} à la corbeille`} title="Corbeille Google Drive (récupérable 30 jours)" onClick={() => trash(file)}>🗑</button>
            </li>
          ))}
        </ul>
        {busy && <p role="status">Opération Google en cours…</p>}
        {!busy && !error && loaded && !visible.length && (
          <p className="drive-hint">{filter ? 'Aucun document ne correspond.' : 'Aucun document autorisé pour WorkLogs. Crée-en un ou autorise-en d’autres.'}</p>
        )}
        {page && <button type="button" disabled={busy} onClick={() => void run(() => refresh(page))}>Voir la suite</button>}
        {warnings.map((warning) => <p key={warning} role="status">{warning}</p>)}
        {message && <p className="drive-success" role="status">{message}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {helpUrl && <a href={helpUrl} target="_blank" rel="noopener noreferrer">Activer l’API dans Google Cloud</a>}
      </div>
    </dialog>
  ), document.body);
}
