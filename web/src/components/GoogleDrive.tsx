import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, googleHelpUrl, type Entry, type GoogleBackup, type GoogleStatus } from '../lib';
import { GoogleDriveWeb } from './GoogleDriveWeb';

/** PWA statique : Drive direct navigateur, sans passer par `/api`. */
const isPwa = import.meta.env.VITE_PWA === '1';

/** Gestion Drive dans une fenêtre dédiée, sans route ni onglet supplémentaire. */
export function GoogleDrive({ onOpen, onRestored, onDocuments }: { onOpen: (entry: Entry) => void; onRestored?: () => void | Promise<void>; onDocuments?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [backups, setBackups] = useState<GoogleBackup[]>([]);
  const [error, setError] = useState('');
  const [helpUrl, setHelpUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [configure, setConfigure] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [outbox, setOutbox] = useState<GoogleBackup[]>([]);
  const [outboxMessage, setOutboxMessage] = useState('');
  const [attachmentStatus, setAttachmentStatus] = useState<{ total: number; onDrive: number; missingLocal: number } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const refreshBackups = async () => {
    const result = await api.googleBackups();
    setBackups(result.files);
  };
  const refreshOutbox = async () => {
    const result = await api.listOutbox();
    setOutbox(result.files);
  };
  const refreshAttachments = async () => {
    try {
      const next = await api.driveAttachmentStatus();
      setAttachmentStatus({ total: next.total, onDrive: next.onDrive, missingLocal: next.missingLocal });
    } catch {
      setAttachmentStatus(null);
    }
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
    // La PWA a son propre panneau (GoogleDriveWeb) : pas d'appels desktop ici.
    if (!expanded || isPwa) return;
    let alive = true;
    setError('');
    setHelpUrl('');
    setBusy(true);
    void api.googleStatus().then(async (next) => {
      if (!alive) return;
      setStatus(next);
      if (next.connected) {
        await refreshBackups();
        await refreshOutbox();
        await refreshAttachments();
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
            await refreshBackups();
            await refreshOutbox();
            await refreshAttachments();
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
      setConfigure(false);
    });
  };

  const saveBackup = async () => {
    await run(async () => {
      const saved = await api.exportGoogleBackup();
      setBackups(current => [saved, ...current.filter(backup => backup.id !== saved.id)]);
      setBackupMessage(saved.binaries
        ? `Sauvegarde enregistrée dans Google Drive : ${saved.name} (${saved.binaries} fichier(s) envoyé(s) avec).`
        : `Sauvegarde enregistrée dans Google Drive : ${saved.name}`);
      await refreshAttachments();
    });
  };
  const restore = async (backup: GoogleBackup) => {
    if (!confirm(`Restaurer « ${backup.name} » ? Les projets, entrées, tâches et associations locales seront remplacés. Les fichiers adossés à Drive sont retéléchargés automatiquement quand la connexion est active.`)) return;
    await run(async () => {
      const result = await api.importGoogleBackup(backup.id);
      setBackupMessage(result.binaries
        ? `Sauvegarde restaurée : ${backup.name} (${result.binaries} fichier(s) récupéré(s)).`
        : result.missingFiles
          ? `Sauvegarde restaurée : ${backup.name} (${result.missingFiles} fichier(s) encore sur Drive : ouvrez l’entrée et touchez Récupérer).`
          : `Sauvegarde restaurée : ${backup.name}`);
      await refreshAttachments();
      await onRestored?.();
    });
  };
  const importOutboxFile = async (box: GoogleBackup) => {
    await run(async () => {
      const result = await api.importOutbox(box.id);
      setOutboxMessage(
        `Boîte fusionnée : ${result.entries} entrée(s), ${result.tasks} tâche(s), ${result.updated} mise(s) à jour, ${result.conflicts} conflit(s) conservé(s) côté PC.`
      );
      await refreshOutbox();
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
            {isPwa ? <GoogleDriveWeb onOpen={onOpen} onRestored={onRestored} onDocuments={onDocuments} /> : (!status ? <p>Chargement…</p> : !status.available ? <p>La connexion Drive est disponible dans l’application desktop Linux.</p> : <>
              {status.pending
                ? <p>Termine la {status.connected ? 'sélection dans' : 'connexion dans'} ton navigateur, puis reviens ici.</p>
                : status.connected
                  ? <p className="drive-account" aria-label="Compte Google connecté">{status.account ? <>Connecté : <strong>{status.account.name || status.account.email}</strong>{status.account.name && <> · {status.account.email}</>}</> : 'Google Drive connecté'}</p>
                  : <p>Facultatif : connecte ton compte Google pour sauvegarder dans Drive et éditer tes documents Google dans WorkLogs. Sans connexion, tout reste sur cet appareil.</p>}
              {(!status.configured || configure) && <div className="drive-setup">
                <p>Première connexion : crée un client OAuth de type « Application de bureau » dans Google Cloud, puis importe son fichier JSON. Active les API Google Docs, Drive et Google Picker.</p>
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Ouvrir Google Cloud</a>
                <label className="ghost file-button">Importer la configuration Google<input type="file" aria-label="Configuration Google JSON" accept=".json,application/json" disabled={busy}
                  onChange={(e) => { void importConfig(e.target.files?.[0]); e.target.value = ''; }} /></label>
              </div>}
              {status.configured && <button type="button" className={status.connected ? undefined : 'primary google-signin'} disabled={busy || status.pending} onClick={() => void run(async () => { setStatus(await api.connectGoogle(status.connected)); })}>
                {status.connected ? 'Choisir des documents dans Drive' : 'Se connecter avec Google'}
              </button>}
              {status.configured && !status.connected && <p className="drive-hint">WorkLogs lit ton nom et ton e-mail pour les afficher, et n’accède qu’aux fichiers qu’il crée ou que tu choisis.</p>}
              {status.connected && !status.pending && <>
                <section className="drive-backups" aria-label="Sauvegardes WorkLogs">
                  <div className="drive-subheading"><div><h3>Sauvegardes WorkLogs</h3><p>Un fichier JSON lisible par WorkLogs sur un autre PC connecté au même compte. Les pièces jointes partent avec, automatiquement.</p></div><button className="primary" type="button" disabled={busy} onClick={() => void saveBackup()}>Sauvegarder dans Google Drive</button></div>
                  <div className="drive-backup-actions"><button type="button" disabled={busy} onClick={() => void run(() => refreshBackups())}>Actualiser les sauvegardes</button></div>
                  {backups.length > 0 ? <ul className="drive-backups-list">{backups.map(backup => <li key={backup.id}><div><strong>{backup.name}</strong><small>{backup.modifiedTime ? new Date(backup.modifiedTime).toLocaleString('fr-FR') : 'Date inconnue'}{backup.size ? ` · ${Math.round(backup.size / 1024)} Ko` : ''}</small></div><button className="ghost" type="button" disabled={busy} onClick={() => void restore(backup)}>Restaurer</button></li>)}</ul> : <p className="drive-hint">Aucune sauvegarde WorkLogs dans ce compte.</p>}
                  {backupMessage && <p className="drive-success" role="status">{backupMessage}</p>}
                </section>
                <section className="drive-backups" aria-label="Pièces jointes Drive">
                  <div className="drive-subheading"><div><h3>Pièces jointes</h3><p>{attachmentStatus ? `${attachmentStatus.onDrive}/${attachmentStatus.total} fichier(s) sur Drive${attachmentStatus.missingLocal ? ` · ${attachmentStatus.missingLocal} manquant(s) en local` : ' · tout est lisible ici'}.` : 'État des fichiers joints.'}</p></div><button type="button" disabled={busy} onClick={() => void run(refreshAttachments)}>Actualiser</button></div>
                  <p className="drive-hint">Sauvegarder envoie les nouveaux fichiers, Restaurer les récupère. Dans l’entrée, le badge ☁ Drive + ⬇ Récupérer répare un fichier isolé.</p>
                </section>
                <section className="drive-outbox" aria-label="Boîte mobile">
                  <div className="drive-subheading"><div><h3>Boîte mobile</h3><p>Créations du téléphone à fusionner, sans rien écraser.</p></div></div>
                  <div className="drive-backup-actions"><button type="button" disabled={busy} onClick={() => void run(refreshOutbox)}>Actualiser la boîte mobile</button></div>
                  {outbox.length > 0 ? <ul className="drive-backups-list">{outbox.map(box => <li key={box.id}><div><strong>{box.name}</strong><small>{box.modifiedTime ? new Date(box.modifiedTime).toLocaleString('fr-FR') : 'Date inconnue'}{box.size ? ` · ${Math.round(box.size / 1024)} Ko` : ''}</small></div><button className="ghost" type="button" disabled={busy} onClick={() => void importOutboxFile(box)}>Importer</button></li>)}</ul> : <p className="drive-hint">Aucune boîte mobile dans ce compte.</p>}
                  {outboxMessage && <p className="drive-success" role="status">{outboxMessage}</p>}
                </section>
                <section className="drive-backups" aria-label="Documents Google">
                  <div className="drive-subheading"><div><h3>Documents Google</h3><p>Ouvrir, ranger dans un projet, créer ou mettre à la corbeille : tout se fait dans leur propre fenêtre.</p></div>
                    {onDocuments && <button className="primary" type="button" disabled={busy} onClick={onDocuments}>Documents Google</button>}</div>
                </section>
                {busy && <p role="status">Opération Google en cours…</p>}
                <button className="ghost" type="button" disabled={busy} onClick={() => void run(async () => { setStatus(await api.disconnectGoogle()); setBackups([]); setOutbox([]); setAttachmentStatus(null); setBackupMessage(''); setOutboxMessage(''); })}>Se déconnecter de Google</button>
              </>}
              {status.configured && !status.pending && <button className="ghost" type="button" disabled={busy} onClick={() => setConfigure(!configure)}>{status.builtin ? 'Utiliser mon propre client OAuth' : 'Configuration Google'}</button>}
              {status.builtinAvailable && !status.builtin && !status.pending && <button className="ghost" type="button" disabled={busy} onClick={() => void run(async () => { setStatus(await api.useBuiltinGoogle()); setBackups([]); setOutbox([]); setConfigure(false); })}>Revenir au client intégré</button>}
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
