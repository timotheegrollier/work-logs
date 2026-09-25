import { useEffect, useState } from 'react';
import { googleHelpUrl, type Entry, type GoogleBackup } from '../lib';
import { clearLocalOutbox, exportLocalOutbox, fetchMissingDriveAttachments, importLocalBackup, listPendingUploads, markAttachmentUploaded, outboxSize } from '../store/localApi';
import {
  attachmentFolderId,
  beginWebLogin,
  clearWebClient,
  consumeRedirectCallback,
  disconnectWeb,
  downloadWebBackup,
  getWebClientId,
  getWebClientSecret,
  hasRedirectCallback,
  listWebBackups,
  setWebClientId,
  setWebClientSecret,
  uploadDriveFile,
  uploadOutbox,
  webGoogleStatus,
  webRedirectUri,
  builtinWebClientId,
} from '../store/google-web';
import { syncWebNow, webSyncStatus } from '../store/sync-web';

/**
 * Panneau Drive de la PWA (sans serveur) : OAuth Web en direct, liste des
 * sauvegardes du compte et chargement dans la base locale. Le client « Web »
 * doit vivre dans le même projet Google Cloud que le client desktop (voir
 * `docs/08-GOOGLE-DOCS.md`) : c'est ce qui rend les sauvegardes du PC visibles ici.
 */
export function GoogleDriveWeb({ onRestored, onDocuments }: { onOpen?: (entry: Entry) => void; onRestored?: () => void | Promise<void>; onDocuments?: () => void }) {
  const [clientId, setClientId] = useState(getWebClientId());
  const [clientSecret, setClientSecret] = useState(getWebClientSecret());
  const [savedClientId, setSavedClientId] = useState(getWebClientId());
  const [status, setStatus] = useState(webGoogleStatus);
  const connected = status.connected;
  const refreshStatus = () => setStatus(webGoogleStatus());
  const [backups, setBackups] = useState<GoogleBackup[]>([]);
  const [pending, setPending] = useState(outboxSize());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [helpUrl, setHelpUrl] = useState('');
  const [message, setMessage] = useState('');

  const showError = (e: unknown) => {
    setError((e as Error).message);
    setHelpUrl(googleHelpUrl(e));
    // Un ancien jeton sans renouvellement peut expirer pendant l'action : le bouton de reprise apparaît.
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

  // Retour de Google (`?code=…` ou ancien `#access_token=…`) : traité une fois, puis URL nettoyée.
  useEffect(() => {
    let alive = true;
    if (!hasRedirectCallback()) return;
    setBusy(true);
    void consumeRedirectCallback()
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

  // Sauvegardes : liste chargée dès que la session est établie (et valide) ; un
  // jeton refusé fait apparaître la reprise de session.
  useEffect(() => {
    if (!connected || status.expired) return;
    let alive = true;
    setBusy(true);
    setError('');
    setHelpUrl('');
    void refreshBackups()
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

  // Synchro active : « Sauvegarder » fusionne au lieu d'écraser ce que le PC a écrit.
  const saveBackup = async () => {
    await run(async () => {
      await syncWebNow();
      const sync = webSyncStatus();
      if (sync.state === 'error') throw new Error(sync.error);
      await refreshBackups();
      setMessage('Synchronisé avec Google Drive : WorkLogs backup.json est à jour.');
      await onRestored?.();
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
          appProperties: { worklogs_type: 'attachment', worklogs_version: '2', worklogs_attachment_id: row.id, worklogs_entry_id: row.entry_id },
          parent: await attachmentFolderId(),
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
      <p className="drive-hint">
        URI de redirection à autoriser dans Google Cloud (exacte, barre oblique comprise) :{' '}
        <code>{webRedirectUri()}</code>
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
        Secret client Web (facultatif : requis seulement par certains clients)
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
              <p>Session Google expirée. Google n’a pas fourni de renouvellement automatique pour cette autorisation. Tes notes restent sur cet appareil.</p>
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
                <p>Ouvrir, ranger dans un projet, créer ou mettre à la corbeille : tout se fait dans leur propre fenêtre.</p>
              </div>
              {onDocuments && (
                <button type="button" className="primary" disabled={busy} onClick={onDocuments}>
                  Documents Google
                </button>
              )}
            </div>
          </section>
          <button
            className="ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              disconnectWeb();
              refreshStatus();
              setBackups([]);
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
