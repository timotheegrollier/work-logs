import { useEffect, useState } from 'react';
import { api, googleHelpUrl, type Entry, type GoogleFile, type GoogleStatus, type GoogleTab } from '../lib';

/** Panneau repliable du journal, sans route ni onglet supplémentaire. */
export function GoogleDrive({ onOpen }: { onOpen: (entry: Entry) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [files, setFiles] = useState<GoogleFile[]>([]);
  const [page, setPage] = useState('');
  const [error, setError] = useState('');
  const [helpUrl, setHelpUrl] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [filter, setFilter] = useState('');
  const [tabChoice, setTabChoice] = useState<{ file: GoogleFile; tabs: GoogleTab[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [configure, setConfigure] = useState(false);

  const refreshFiles = async (token = '') => {
    const result = await api.googleDocuments(token);
    setFiles(current => Array.from(new Map((token ? [...current, ...result.files] : result.files).map(file => [file.id, file])).values()));
    setPage(result.nextPageToken || '');
    setWarnings(result.warnings || []); setLoaded(true);
  };
  const showError = (e: unknown) => {
    setError((e as Error).message);
    setHelpUrl(googleHelpUrl(e));
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setHelpUrl('');
    try { await action(); } catch (e) { showError(e); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    setError(''); setHelpUrl(''); setBusy(true);
    void api.googleStatus().then(async (next) => {
      if (!alive) return;
      setStatus(next);
      if (next.connected) await refreshFiles();
    }).catch(e => alive && showError(e)).finally(() => { if (alive) setBusy(false); });
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
      }).catch(e => { if (alive) showError(e); });
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [status?.pending]);
  const importConfig = async (file?: File) => {
    if (!file) return;
    await run(async () => {
      if (file.size > 32_000) throw new Error('Le fichier de configuration Google est trop volumineux.');
      let config;
      try { config = JSON.parse(await file.text()); } catch { throw new Error('Choisis le fichier JSON téléchargé depuis Google Cloud.'); }
      setStatus(await api.configureGoogle(config)); setFiles([]); setLoaded(false); setConfigure(false);
    });
  };
  const openFile = async (file: GoogleFile) => {
    const { tabs } = await api.googleDocumentTabs(file.id);
    if (tabs.length > 1) { setTabChoice({ file, tabs }); return; }
    setTabChoice(null); onOpen(await api.openGoogleDocument(file.id));
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
          <button className="primary" disabled={busy || status.pending} onClick={() => setCreating(!creating)}>Créer un Google Docs</button>
          {creating && <form className="drive-create" onSubmit={event => {
            event.preventDefault();
            void run(async () => {
              const entry = await api.createGoogleDocument(title.trim());
              setCreating(false); setTitle('');
              setFiles(current => [{ id: entry.google_sync!.document_id, name: entry.title, modifiedTime: entry.updated_at }, ...current]);
              setLoaded(true); onOpen(entry);
            });
          }}>
            <label>Titre du nouveau document<input autoFocus required maxLength={240} value={title} onChange={e => setTitle(e.target.value)} /></label>
            <button type="submit" disabled={busy || !title.trim()}>Créer et ouvrir</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setCreating(false)}>Annuler la création</button>
          </form>}
          <p className="drive-hint">Documents autorisés pour WorkLogs. La connexion et l’autorisation de nouveaux fichiers passent par Google dans le navigateur.</p>
          <button disabled={busy} onClick={() => void run(() => refreshFiles())}>Actualiser la liste</button>
          {files.length > 0 && <input type="search" aria-label="Filtrer les documents Drive" placeholder="Rechercher un document…" value={filter} onChange={e => setFilter(e.target.value)} />}
          <ul className="drive-files">{files.filter(file => file.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(file => <li key={file.id}>
            <button disabled={busy} onClick={() => void run(() => openFile(file))}>{file.name}</button>
            {status.selectedIds.includes(file.id) && <small>Dernière sélection Google</small>}
          </li>)}</ul>
          {tabChoice && <div className="drive-tab-choice" role="group" aria-label="Choisir un onglet Google">
            <p>Onglet à éditer dans « {tabChoice.file.name} » :</p>
            {tabChoice.tabs.map(tab => <div key={tab.id}><button disabled={busy || tab.editable === false} onClick={() => void run(async () => {
              onOpen(await api.openGoogleDocument(tabChoice.file.id, tab.id)); setTabChoice(null);
            })}>{'↳ '.repeat(tab.depth)}{tab.title}</button>{tab.reason && <small>{tab.reason}</small>}</div>)}
            <p className="drive-hint">Chaque onglet ouvert a son propre brouillon dans le journal.</p>
            <a href={`https://docs.google.com/document/d/${tabChoice.file.id}/edit`} target="_blank" rel="noopener noreferrer">Ouvrir l’original dans Google Docs</a>
            <button className="ghost" onClick={() => setTabChoice(null)}>Fermer le choix d’onglet</button>
          </div>}
          {busy && <p role="status">Opération Google en cours…</p>}
          {!busy && !error && loaded && !files.length && <p>Aucun document autorisé. Utilise « Choisir des documents dans Drive ».</p>}
          {warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
          {page && <button disabled={busy} onClick={() => void run(() => refreshFiles(page))}>Voir la suite</button>}
          <button className="ghost" disabled={busy} onClick={() => void run(async () => { setStatus(await api.disconnectGoogle()); setFiles([]); setLoaded(false); setCreating(false); setWarnings([]); })}>Déconnecter Google Drive</button>
        </>}
        {status.configured && !status.pending && <button className="ghost" disabled={busy} onClick={() => setConfigure(!configure)}>Configuration Google</button>}
        {status.secureStorage === false && <p>Le trousseau Linux doit être déverrouillé pour conserver ta connexion Google.</p>}
      </>}
      {(error || status?.error) && <p className="error" role="alert">{error || status?.error}</p>}
      {helpUrl && <a href={helpUrl} target="_blank" rel="noopener noreferrer">Activer l’API dans Google Cloud</a>}
    </div>}
  </section>;
}
