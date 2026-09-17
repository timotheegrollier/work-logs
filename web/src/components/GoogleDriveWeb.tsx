import { useEffect, useState } from 'react';
import { googleHelpUrl, type GoogleBackup } from '../lib';
import { importLocalBackup } from '../store/localApi';
import {
  beginWebLogin,
  disconnectWeb,
  downloadWebBackup,
  getWebClientId,
  handleRedirectCallback,
  listWebBackups,
  setWebClientId,
  webGoogleStatus,
} from '../store/google-web';

/**
 * Panneau Drive de la PWA (sans serveur) : OAuth Web en direct, liste des
 * sauvegardes du compte et chargement dans la base locale. Le client « Web »
 * doit vivre dans le même projet Google Cloud que le client desktop (voir
 * `docs/08-GOOGLE-DOCS.md`) : c'est ce qui rend les sauvegardes du PC visibles ici.
 */
export function GoogleDriveWeb({ onRestored }: { onRestored?: () => void | Promise<void> }) {
  const [clientId, setClientId] = useState(getWebClientId());
  const [savedClientId, setSavedClientId] = useState(getWebClientId());
  const [connected, setConnected] = useState(webGoogleStatus().connected);
  const [backups, setBackups] = useState<GoogleBackup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [helpUrl, setHelpUrl] = useState('');
  const [message, setMessage] = useState('');

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

  // Retour de Google (`?code=…`) : échange unique, puis URL nettoyée.
  useEffect(() => {
    let alive = true;
    if (!location.search.includes('code=') && !location.search.includes('error=')) return;
    setBusy(true);
    void handleRedirectCallback()
      .then(async (handled) => {
        if (!alive || !handled) return;
        history.replaceState(null, '', location.pathname);
        setConnected(true);
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

  const saveClient = () =>
    run(async () => {
      setSavedClientId(setWebClientId(clientId));
      setMessage('');
    });

  const refreshBackups = async () => {
    setBackups(await listWebBackups());
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
      setMessage(`Sauvegarde chargée : ${result.entries} entrée(s), ${result.tasks} tâche(s).`);
      await onRestored?.();
    });
  };

  return (
    <div className="drive-content">
      {!savedClientId ? (
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
          <button type="button" className="primary" disabled={busy || !clientId.trim()} onClick={() => void saveClient()}>
            Enregistrer l’identifiant
          </button>
        </div>
      ) : !connected ? (
        <div className="drive-setup">
          <p>Connexion directe à Google depuis cet appareil, sans serveur. La session reste conservée ici.</p>
          <button type="button" className="primary" disabled={busy} onClick={() => void beginWebLogin(savedClientId)}>
            Connecter Google Drive
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => { setSavedClientId(''); setClientId(''); }}>
            Changer d’identifiant client
          </button>
        </div>
      ) : (
        <section className="drive-backups" aria-label="Sauvegardes WorkLogs">
          <div className="drive-subheading">
            <div>
              <h3>Sauvegardes WorkLogs</h3>
              <p>Les mêmes fichiers que sur le PC, via ton compte Google.</p>
            </div>
          </div>
          <div className="drive-backup-actions">
            <button type="button" disabled={busy} onClick={() => void run(refreshBackups)}>
              Actualiser les sauvegardes
            </button>
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
          <button
            className="ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              disconnectWeb();
              setConnected(false);
              setBackups([]);
              setMessage('');
            }}
          >
            Déconnecter Google Drive
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
