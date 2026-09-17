import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, googleHelpUrl, type Entry, type GoogleBackup, type GoogleFile, type GoogleStatus } from '../lib';
import { GoogleDriveWeb } from './GoogleDriveWeb';

/** PWA statique : Drive direct navigateur, sans passer par `/api`. */
const isPwa = import.meta.env.VITE_PWA === '1';

/** Gestion Drive dans une fenêtre dédiée, sans route ni onglet supplémentaire. */
export function GoogleDrive({ onOpen, onRestored }: { onOpen: (entry: Entry) => void; onRestored?: () => void | Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [files, setFiles] = useState<GoogleFile[]>([]);
  const [backups, setBackups] = useState<GoogleBackup[]>([]);
  const [page, setPage] = useState('');
  const [error, setError] = useState('');
  const [helpUrl, setHelpUrl] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [configure, setConfigure] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  const refreshFiles = async (token = '') => {
    const result = await api.googleDocuments(token);
    setFiles(current => Array.from(new Map((token ? [...current, ...result.files] : result.files).map(file => [file.id, file])).values()));
    setPage(result.nextPageToken || '');
    setWarnings(result.warnings || []);
    setLoaded(true);
  };
  const refreshBackups = async () => {
    const result = await api.googleBackups();
    setBackups(result.files);
  };
  const showError = (e: unknown) => {
    setError((e as Error).message);
    setHelpUrl(googleHelpUrl(e));
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setHelpUrl('');
    try {
      await action();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    setError('');
    setHelpUrl('');
    setBusy(true);
    void api.googleStatus().then(async (next) => {
      if (!alive) return;
      setStatus(next);
      if (next.connected) {
        await refreshFiles();
        await refreshBackups();
      }
    }).catch(e => alive && showError(e)).finally(() => {
      if (alive) setBusy(false);
    });
    return () => { alive = false; };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    try { dialog.showModal(); }
    catch { dialog.setAttribute('open', ''); }
  }, [expanded]);

  useEffect(() => {
    if (!expanded || !status?.pending) return;
    let alive = true;
    const timer = setInterval(() => {
      void api.googleStatus().then(async next => {
        if (!alive) return;
        setStatus(next);
        if (!next.pending) {
          clearInterval(timer);
          if (next.connected) {
            await refreshFiles();
            await refreshBackups();
          }
          if (next.error) setError(next.error);
        }
      }).catch(e => { if (alive) showError(e); });
    }, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [expanded, status?.pending]);

  const importConfig = async (file?: File) => {
    if (!file) return;
    await run(async () => {
      if (file.size > 32_000) throw new Error('Le fichier de configuration Google est trop volumineux.');
      let config;
      try {
        config = JSON.parse(await file.text());
      } catch {
        throw new Error('Choisis le fichier JSON téléchargé depuis Google Cloud.');
      }
      setStatus(await api.configureGoogle(config));
      setFiles([]);
      setLoaded(false);
      setConfigure(false);
    });
  };

  const openFile = async (file: GoogleFile) => onOpen(await api.openGoogleDocument(file.id));
  const saveBackup = async () => {
    await run(async () => {
      const saved = await api.exportGoogleBackup();
      setBackups(current => [saved, ...current.filter(backup => backup.id !== saved.id)]);
      setBackupMessage(`Sauvegarde enregistrée dans Google Drive : ${saved.name}`);
    });
  };
  const restore = async (backup: GoogleBackup) => {
    if (!confirm(`Restaurer « ${backup.name} » ? Les projets, entrées, tâches et associations locales seront remplacés. Les fichiers joints locaux ne sont pas inclus dans le JSON.`)) return;
    await run(async () => {
      await api.importGoogleBackup(backup.id);
      setBackupMessage(`Sauvegarde restaurée : ${backup.name}`);
      await onRestored?.();
    });
  };

  return (
    <section className="drive-panel" aria-label="Google Drive">
      <button
        className="drive-open ghost"
        type="button"
        aria-expanded={expanded}
        aria-controls="google-drive-dialog"
        onClick={() => setExpanded(true)}
      >
        Gérer Google Drive
      </button>
      {expanded && createPortal((
        <dialog
          id="google-drive-dialog"
          className="drive-dialog"
          aria-label="Gestion Google Drive"
          aria-modal="true"
          ref={dialogRef}
          onCancel={(event) => {
            event.preventDefault();
            setExpanded(false);
          }}
        >
          <div className="drive-dialog-heading">
            <h2>Google Drive</h2>
            <button className="ghost" type="button" onClick={() => setExpanded(false)}>
              Fermer
            </button>
          </div>
          <div className="drive-content">
            {isPwa ? <GoogleDriveWeb onRestored={onRestored} /> : (!status ? <p>Chargement…</p> : !status.available ? <p>La connexion Drive est disponible dans l’application desktop Linux.</p> : <>
              <p>{status.connected ? 'Google Drive connecté' : status.pending ? 'Termine la connexion dans ton navigateur, puis reviens ici.' : 'Ouvre et édite tes documents Google dans WorkLogs.'}</p>
              {(!status.configured || configure) && <div className="drive-setup">
                <p>Première connexion : crée un client OAuth de type « Application de bureau » dans Google Cloud, puis importe son fichier JSON. Active les API Google Docs, Drive et Google Picker.</p>
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Ouvrir Google Cloud</a>
                <label className="ghost file-button">Importer la configuration Google<input type="file" aria-label="Configuration Google JSON" accept=".json,application/json" disabled={busy}
                  onChange={(e) => { void importConfig(e.target.files?.[0]); e.target.value = ''; }} /></label>
              </div>}
              {status.configured && <button type="button" disabled={busy || status.pending} onClick={() => void run(async () => { setStatus(await api.connectGoogle()); })}>
                {status.connected ? 'Choisir des documents dans Drive' : 'Connecter Google Drive'}
              </button>}
              {status.connected && <>
                <section className="drive-backups" aria-label="Sauvegardes WorkLogs">
                  <div className="drive-subheading"><div><h3>Sauvegardes WorkLogs</h3><p>Un fichier JSON lisible par WorkLogs sur un autre PC connecté au même compte.</p></div><button className="primary" type="button" disabled={busy} onClick={() => void saveBackup()}>Sauvegarder dans Google Drive</button></div>
                  <div className="drive-backup-actions"><button type="button" disabled={busy} onClick={() => void run(() => refreshBackups())}>Actualiser les sauvegardes</button></div>
                  {backups.length > 0 ? <ul className="drive-backups-list">{backups.map(backup => <li key={backup.id}><div><strong>{backup.name}</strong><small>{backup.modifiedTime ? new Date(backup.modifiedTime).toLocaleString('fr-FR') : 'Date inconnue'}{backup.size ? ` · ${Math.round(backup.size / 1024)} Ko` : ''}</small></div><button className="ghost" type="button" disabled={busy} onClick={() => void restore(backup)}>Restaurer</button></li>)}</ul> : <p className="drive-hint">Aucune sauvegarde WorkLogs dans ce compte.</p>}
                  {backupMessage && <p className="drive-success" role="status">{backupMessage}</p>}
                </section>
                <button className="primary" type="button" disabled={busy || status.pending} onClick={() => setCreating(!creating)}>Créer un Google Docs</button>
                {creating && <form className="drive-create" onSubmit={event => {
                  event.preventDefault();
                  void run(async () => {
                    const entry = await api.createGoogleDocument(title.trim());
                    setCreating(false);
                    setTitle('');
                    setFiles(current => [{ id: entry.google_sync!.document_id, name: entry.title, modifiedTime: entry.updated_at }, ...current]);
                    setLoaded(true);
                    onOpen(entry);
                  });
                }}>
                  <label>Titre du nouveau document<input autoFocus required maxLength={240} value={title} onChange={e => setTitle(e.target.value)} /></label>
                  <button type="submit" disabled={busy || !title.trim()}>Créer et ouvrir</button>
                  <button type="button" className="ghost" disabled={busy} onClick={() => setCreating(false)}>Annuler la création</button>
                </form>}
                <p className="drive-hint">Documents autorisés pour WorkLogs. La connexion et l’autorisation de nouveaux fichiers passent par Google dans le navigateur.</p>
                <button type="button" disabled={busy} onClick={() => void run(() => refreshFiles())}>Actualiser la liste</button>
                {files.length > 0 && <input type="search" aria-label="Filtrer les documents Drive" placeholder="Rechercher un document…" value={filter} onChange={e => setFilter(e.target.value)} />}
                <ul className="drive-files">{files.filter(file => file.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(file => <li key={file.id}>
                  <button type="button" disabled={busy} onClick={() => void run(() => openFile(file))}>{file.name}</button>
                  {status.selectedIds.includes(file.id) && <small>Dernière sélection Google</small>}
                </li>)}</ul>
                {busy && <p role="status">Opération Google en cours…</p>}
                {!busy && !error && loaded && !files.length && <p>Aucun document autorisé. Utilise « Choisir des documents dans Drive ».</p>}
                {warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
                {page && <button type="button" disabled={busy} onClick={() => void run(() => refreshFiles(page))}>Voir la suite</button>}
                <button className="ghost" type="button" disabled={busy} onClick={() => void run(async () => { setStatus(await api.disconnectGoogle()); setFiles([]); setBackups([]); setLoaded(false); setCreating(false); setWarnings([]); setBackupMessage(''); })}>Déconnecter Google Drive</button>
              </>}
              {status.configured && !status.pending && <button className="ghost" type="button" disabled={busy} onClick={() => setConfigure(!configure)}>Configuration Google</button>}
              {status.secureStorage === false && <p>Le trousseau Linux doit être déverrouillé pour conserver ta connexion Google.</p>}
            </>)}
            {(error || status?.error) && <p className="error" role="alert">{error || status?.error}</p>}
            {helpUrl && <a href={helpUrl} target="_blank" rel="noopener noreferrer">Activer l’API dans Google Cloud</a>}
          </div>
        </dialog>
      ), document.body)}
    </section>
  );
}
