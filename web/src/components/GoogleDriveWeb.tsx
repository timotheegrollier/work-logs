import { useEffect, useState } from 'react';
import { api, googleHelpUrl, type Entry, type GoogleBackup, type GoogleFile } from '../lib';
import { clearLocalOutbox, exportLocalOutbox, fetchMissingDriveAttachments, importLocalBackup, listPendingUploads, markAttachmentUploaded, outboxSize } from '../store/localApi';
import {
  beginWebLogin,
  clearWebClient,
  disconnectWeb,
  downloadWebBackup,
  getWebClientId,
  getWebClientSecret,
  handleRedirectCallback,
  hasRedirectCallback,
  listWebBackups,
  saveBackupJson,
  setWebClientId,
  setWebClientSecret,
  uploadDriveFile,
  uploadOutbox,
  webGoogleStatus,
  builtinWebClientId,
} from '../store/google-web';

/**
 * Panneau Drive de la PWA (sans serveur) : OAuth Web en direct, liste des
 * sauvegardes du compte et chargement dans la base locale. Le client « Web »
 * doit vivre dans le même projet Google Cloud que le client desktop (voir
 * `docs/08-GOOGLE-DOCS.md`) : c'est ce qui rend les sauvegardes du PC visibles ici.
 */
export function GoogleDriveWeb({ onOpen, onRestored }: { onOpen: (entry: Entry) => void; onRestored?: () => void | Promise<void> }) {
  const [clientId, setClientId] = useState(getWebClientId());
  const [clientSecret, setClientSecret] = useState(getWebClientSecret());
  const [savedClientId, setSavedClientId] = useState(getWebClientId());
  const [status, setStatus] = useState(webGoogleStatus);
  const connected = status.connected;
  const refreshStatus = () => setStatus(webGoogleStatus());
  const [backups, setBackups] = useState<GoogleBackup[]>([]);
  const [files, setFiles] = useState<GoogleFile[]>([]);
  const [page, setPage] = useState('');
  const [pending, setPending] = useState(outboxSize());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [helpUrl, setHelpUrl] = useState('');
  const [message, setMessage] = useState('');

  const showError = (e: unknown) => {
    setError((e as Error).message);
    setHelpUrl(googleHelpUrl(e));
    // Session « jeton » expirée pendant l'action : le bouton de reprise apparaît.
    refreshStatus();
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
      setPending(outboxSize());
      setBusy(false);
    }
  };

  // Retour de Google (`?code=…` ou `#access_token=…`) : traité une fois, puis URL nettoyée.
  useEffect(() => {
    let alive = true;
    if (!hasRedirectCallback()) return;
    setBusy(true);
    void handleRedirectCallback()
      .then(async (handled) => {
        if (!alive || !handled) return;
        history.replaceState(null, '', location.pathname);
        refreshStatus();
        setMessage('Google Drive connecté. Voici les sauvegardes de ce compte.');
        setBackups(await listWebBackups());
      })
      .catch((e) => {
        if (alive) {
          history.replaceState(null, '', location.pathname);
          showError(e);
        }
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Documents Drive : liste chargée dès que la session est établie (et valide).
  useEffect(() => {
    if (!connected || status.expired) return;
    let alive = true;
    setBusy(true);
    setError('');
    setHelpUrl('');
    void refreshFiles()
      .catch((e) => {
        if (alive) showError(e);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, status.expired]);

  const saveClient = () =>
    run(async () => {
      setSavedClientId(setWebClientId(clientId));
      setClientSecret(setWebClientSecret(clientSecret));
      setMessage('');
      refreshStatus();
    });
  const useBuiltinClient = () => {
    clearWebClient();
    setSavedClientId('');
    setClientId('');
    setClientSecret('');
    setMessage('');
    refreshStatus();
  };

  const refreshBackups = async () => {
    setBackups(await listWebBackups());
  };

  const saveBackup = async () => {
    await run(async () => {
      const { blob } = await api.exportBackup();
      const saved = await saveBackupJson(await blob.text());
      setBackups((current) => [
        { id: saved.id, name: saved.name, modifiedTime: new Date().toISOString(), size: blob.size },
        ...current.filter((backup) => backup.id !== saved.id),
      ]);
      setMessage(`Sauvegarde enregistrée dans Google Drive : ${saved.name}`);
    });
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    await run(async () => {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('Fichier de sauvegarde illisible (JSON attendu).');
      }
      const result = await importLocalBackup(data);
      let fetched = 0;
      try {
        fetched = (await fetchMissingDriveAttachments()).fetched;
      } catch {
        // Hors-ligne : l'import local est fait, les binaires suivront.
      }
      setMessage(`Sauvegarde importée : ${result.entries} entrée(s), ${result.tasks} tâche(s)` +
        (fetched ? `, ${fetched} fichier(s) récupéré(s).` : '.'));
      await onRestored?.();
    });
  };

  const refreshFiles = async (token = '') => {
    const result = await api.googleDocuments(token);
    setFiles((current) => Array.from(new Map((token ? [...current, ...result.files] : result.files).map((file) => [file.id, file])).values()));
    setPage(result.nextPageToken || '');
  };

  const openFile = async (file: GoogleFile) => onOpen(await api.openGoogleDocument(file.id));

  const charger = async (backup: GoogleBackup) => {
    if (
      !confirm(
        `Charger « ${backup.name} » ? Le contenu de cet appareil sera remplacé par la sauvegarde. Pense à exporter d’abord si tu as des notes uniquement ici.`
      )
    ) {
      return;
    }
    await run(async () => {
      const data = await downloadWebBackup(backup.id);
      const result = await importLocalBackup(data);
      // Les binaires adossés suivent : un clic les rapatrie, même sur mobile.
      const { fetched, missing } = await fetchMissingDriveAttachments();
      setMessage(fetched
        ? `Sauvegarde chargée : ${result.entries} entrée(s), ${result.tasks} tâche(s), ${fetched} fichier(s) récupéré(s).`
        : missing
          ? `Sauvegarde chargée : ${result.entries} entrée(s), ${result.tasks} tâche(s). ${missing} fichier(s) encore sur Drive : ouvrez l’entrée et touchez Récupérer.`
          : `Sauvegarde chargée : ${result.entries} entrée(s), ${result.tasks} tâche(s).`);
      setPending(outboxSize());
      await onRestored?.();
    });
  };

  const recupererFichiers = async () => {
    await run(async () => {
      const { fetched, missing } = await fetchMissingDriveAttachments();
      setMessage(fetched
        ? `${fetched} fichier(s) récupéré(s) depuis Google Drive.`
        : missing
          ? `${missing} fichier(s) encore indisponible(s) : vérifie la connexion puis réessaie.`
          : 'Tout est déjà lisible sur cet appareil.');
      await onRestored?.();
    });
  };

  const envoyer = async () => {
    await run(async () => {
      // 1. Binaires en attente (photos), un par un : le JSON les référence ensuite.
      for (const row of await listPendingUploads()) {
        if (!row.blob) continue;
        const uploaded = await uploadDriveFile({
          name: row.filename,
          mimeType: row.mime || 'application/octet-stream',
          data: row.blob,
          appProperties: { worklogs_type: 'attachment', worklogs_version: '1' },
        });
        await markAttachmentUploaded(row.stored, uploaded.id);
      }
      // 2. Boîte mobile : le PC la fusionnera sans rien écraser.
      const sent = await uploadOutbox(await exportLocalOutbox());
      clearLocalOutbox();
      setMessage(`Boîte envoyée dans Google Drive : ${sent.name}`);
    });
  };

  const ownClientForm = (
    <div className="drive-setup">
      <p>
        Première connexion : crée un client OAuth de type « Application Web » dans le <em>même</em> projet Google
        Cloud que le desktop, puis colle son identifiant ci-dessous. Active les API Google Drive et Google Docs.
      </p>
      <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">
        Ouvrir Google Cloud
      </a>
      <label>
        Identifiant client Web
        <input
          aria-label="Identifiant client Google Web"
          placeholder="…apps.googleusercontent.com"
          value={clientId}
          disabled={busy}
          onChange={(e) => setClientId(e.target.value)}
        />
      </label>
      <label>
        Secret client Web (facultatif : garde la session au-delà d’une heure)
        <input
          type="password"
          aria-label="Secret client Google Web"
          placeholder="Colle le secret affiché dans Google Cloud"
          value={clientSecret}
          disabled={busy}
          autoComplete="off"
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </label>
      <button type="button" className="primary" disabled={busy || !clientId.trim()} onClick={() => void saveClient()}>
        Enregistrer l’identifiant
      </button>
    </div>
  );
  const account = status.account;

  return (
    <div className="drive-content">
      {!connected && !status.configured ? (
        ownClientForm
      ) : !connected && !savedClientId ? (
        <div className="drive-setup">
          <p>Facultatif : connecte ton compte Google pour sauvegarder dans Drive et retrouver tes notes sur le PC. Sans connexion, tout reste sur cet appareil.</p>
          <button type="button" className="primary google-signin" disabled={busy} onClick={() => void run(() => beginWebLogin())}>
            Se connecter avec Google
          </button>
          <p className="drive-hint">WorkLogs lit ton nom et ton e-mail pour les afficher, et n’accède qu’aux fichiers qu’il crée ou que tu choisis.</p>
          <details className="drive-own-client">
            <summary>Utiliser mon propre client OAuth</summary>
            {ownClientForm}
          </details>
        </div>
      ) : !connected ? (
        <div className="drive-setup">
          <p>Connexion directe à Google depuis cet appareil, sans serveur, avec ton propre client OAuth.</p>
          <button type="button" className="primary google-signin" disabled={busy} onClick={() => void run(() => beginWebLogin())}>
            Se connecter avec Google
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => { setSavedClientId(''); setClientId(''); setClientSecret(''); setWebClientSecret(''); }}>
            Changer d’identifiant client
          </button>
          {builtinWebClientId() && (
            <button type="button" className="ghost" disabled={busy} onClick={useBuiltinClient}>
              Revenir au client intégré
            </button>
          )}
        </div>
      ) : (
        <section className="drive-backups" aria-label="Sauvegardes WorkLogs">
          <p className="drive-account" aria-label="Compte Google connecté">
            {account ? <>Connecté : <strong>{account.name || account.email}</strong>{account.name && <> · {account.email}</>}</> : 'Compte Google connecté.'}
          </p>
          {status.expired && (
            <div className="notice drive-reauth">
              <p>Session Google expirée (elle dure une heure sur mobile). Tes notes restent sur cet appareil.</p>
              <button type="button" className="primary" disabled={busy} onClick={() => void run(() => beginWebLogin())}>
                Reprendre la session Google
              </button>
            </div>
          )}
          <div className="drive-subheading">
            <div>
              <h3>Sauvegardes WorkLogs</h3>
              <p>Les mêmes fichiers que sur le PC, via ton compte Google.</p>
            </div>
          </div>
          <div className="drive-backup-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void saveBackup()}>
              Sauvegarder dans Google Drive
            </button>
            <button type="button" disabled={busy} onClick={() => void run(refreshBackups)}>
              Actualiser les sauvegardes
            </button>
            <label className="ghost file-button">
              Importer un fichier
              <input type="file" aria-label="Importer une sauvegarde JSON" accept=".json,application/json" disabled={busy}
                onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          {backups.length > 0 ? (
            <ul className="drive-backups-list">
              {backups.map((backup) => (
                <li key={backup.id}>
                  <div>
                    <strong>{backup.name}</strong>
                    <small>
                      {backup.modifiedTime ? new Date(backup.modifiedTime).toLocaleString('fr-FR') : 'Date inconnue'}
                      {backup.size ? ` · ${Math.round(backup.size / 1024)} Ko` : ''}
                    </small>
                  </div>
                  <button type="button" className="ghost" disabled={busy} onClick={() => void charger(backup)}>
                    Charger
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="drive-hint">Aucune sauvegarde WorkLogs dans ce compte.</p>
          )}
          <section className="drive-outbox" aria-label="Envoi vers le PC">
            <div className="drive-subheading">
              <div>
                <h3>Envoi vers le PC</h3>
                <p>{pending === 0 ? 'Rien à envoyer : tout est déjà sur Drive.' : `${pending} modification(s) en attente d’envoi.`}</p>
              </div>
              <button type="button" className="primary" disabled={busy || pending === 0} onClick={() => void envoyer()}>
                Envoyer vers Drive
              </button>
            </div>
            <p className="drive-hint">Les photos partent avec leurs binaires : le PC les retrouve après import, même après un rechargement complet.</p>
          </section>
          <section className="drive-outbox" aria-label="Pièces jointes Drive">
            <div className="drive-subheading">
              <div>
                <h3>Fichiers sur Drive</h3>
                <p>Charger rapatrie aussi les binaires ; sinon, ⬇ Récupérer dans l’entrée suffit.</p>
              </div>
              <button type="button" disabled={busy} onClick={() => void recupererFichiers()}>
                Récupérer les fichiers
              </button>
            </div>
          </section>
          <section className="drive-outbox" aria-label="Documents Google">
            <div className="drive-subheading">
              <div>
                <h3>Documents Google</h3>
                <p>Ouvre un document dans WorkLogs pour l’éditer et l’envoyer.</p>
              </div>
            </div>
            <div className="drive-backup-actions">
              <button type="button" disabled={busy} onClick={() => void run(() => refreshFiles())}>
                Actualiser la liste
              </button>
            </div>
            {files.length > 0 ? (
              <ul className="drive-backups-list">
                {files.map((file) => (
                  <li key={file.id}>
                    <div>
                      <strong>{file.name}</strong>
                      <small>{file.modifiedTime ? new Date(file.modifiedTime).toLocaleString('fr-FR') : 'Date inconnue'}</small>
                    </div>
                    <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => openFile(file))}>
                      Ouvrir
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="drive-hint">Aucun document Google dans ce compte.</p>
            )}
            {page !== '' && (
              <div className="drive-backup-actions">
                <button type="button" disabled={busy} onClick={() => void run(() => refreshFiles(page))}>
                  Voir la suite
                </button>
              </div>
            )}
          </section>
          <button
            className="ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              disconnectWeb();
              refreshStatus();
              setBackups([]);
              setFiles([]);
              setPage('');
              setMessage('');
            }}
          >
            Se déconnecter de Google
          </button>
        </section>
      )}
      {busy && <p role="status">Opération Google en cours…</p>}
      {message && <p className="drive-success" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {helpUrl && <a href={helpUrl} target="_blank" rel="noopener noreferrer">Activer l’API dans Google Cloud</a>}
    </div>
  );
}
