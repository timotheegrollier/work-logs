import { useEffect, useState } from 'react';
import { api, type Entry, type GoogleFile, type GoogleStatus } from '../lib';

/** Panneau repliable du journal, sans route ni onglet supplémentaire. */
export function GoogleDrive({ onOpen }: { onOpen: (entry: Entry) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [files, setFiles] = useState<GoogleFile[]>([]);
  const [page, setPage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [configure, setConfigure] = useState(false);

  const refreshFiles = async (token = '') => {
    const result = await api.googleDocuments(token);
    setFiles(current => token ? [...current, ...result.files] : result.files);
    setPage(result.nextPageToken || '');
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    void api.googleStatus().then(async (next) => {
      if (!alive) return;
      setStatus(next);
      if (next.connected) await refreshFiles();
    }).catch(e => alive && setError(e.message));
    return () => { alive = false; };
  }, [expanded]);
  useEffect(() => {
    if (!status?.pending) return;
    let alive = true;
    const timer = setInterval(() => {
      void api.googleStatus().then(async next => {
        if (!alive) return;
        setStatus(next);
        if (!next.pending) {
          clearInterval(timer);
          if (next.connected) await refreshFiles();
          if (next.error) setError(next.error);
        }
      }).catch(e => { if (alive) setError(e.message); });
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [status?.pending]);
  const importConfig = async (file?: File) => {
    if (!file) return;
    await run(async () => {
      if (file.size > 32_000) throw new Error('Le fichier de configuration Google est trop volumineux.');
      let config;
      try { config = JSON.parse(await file.text()); } catch { throw new Error('Choisis le fichier JSON téléchargé depuis Google Cloud.'); }
      setStatus(await api.configureGoogle(config)); setFiles([]); setConfigure(false);
    });
  };
  return <section className="drive-panel" aria-label="Google Drive">
    <button className="drive-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Google Drive <span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
    {expanded && <div className="drive-content">
      {!status ? <p>Chargement…</p> : !status.available ? <p>La connexion Drive est disponible dans l’application desktop Linux.</p> : <>
        <p>{status.connected ? 'Google Drive connecté' : status.pending ? 'Termine la connexion dans ton navigateur, puis reviens ici.' : 'Ouvre et édite tes documents Google dans WorkLogs.'}</p>
        {(!status.configured || configure) && <div className="drive-setup">
          <p>Première connexion : crée un client OAuth de type « Application de bureau » dans Google Cloud, puis importe son fichier JSON. Active les API Google Docs, Drive et Google Picker.</p>
          <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Ouvrir Google Cloud</a>
          <label className="ghost file-button">Importer la configuration Google<input type="file" aria-label="Configuration Google JSON" accept=".json,application/json" disabled={busy}
            onChange={(e) => { void importConfig(e.target.files?.[0]); e.target.value = ''; }} /></label>
        </div>}
        {status.configured && <button disabled={busy || status.pending} onClick={() => void run(async () => { setStatus(await api.connectGoogle()); })}>
          {status.connected ? 'Choisir des documents dans Drive' : 'Connecter Google Drive'}
        </button>}
        {status.connected && <>
          <p className="drive-hint">Documents autorisés pour WorkLogs. La connexion et l’autorisation de nouveaux fichiers passent par Google dans le navigateur.</p>
          <button disabled={busy} onClick={() => void run(() => refreshFiles())}>Actualiser la liste</button>
          <ul className="drive-files">{files.map(file => <li key={file.id}><button disabled={busy} onClick={() => void run(async () => onOpen(await api.openGoogleDocument(file.id)))}>{file.name}</button></li>)}</ul>
          {!files.length && <p>Aucun document autorisé. Utilise « Choisir des documents dans Drive ».</p>}
          {page && <button disabled={busy} onClick={() => void run(() => refreshFiles(page))}>Voir la suite</button>}
          <button className="ghost" disabled={busy} onClick={() => void run(async () => { setStatus(await api.disconnectGoogle()); setFiles([]); })}>Déconnecter Google Drive</button>
        </>}
        {status.configured && !status.pending && <button className="ghost" disabled={busy} onClick={() => setConfigure(!configure)}>Configuration Google</button>}
        {status.secureStorage === false && <p>Le trousseau Linux doit être déverrouillé pour conserver ta connexion Google.</p>}
      </>}
      {(error || status?.error) && <p className="error" role="alert">{error || status?.error}</p>}
    </div>}
  </section>;
}
