import { useEffect, useMemo, useRef, useState } from 'react';
import { api, formatSize, googleHelpUrl, type Attachment, type Entry, type EntrySummary, type Project } from '../lib';
import { renderMarkdown } from '../markdown';
import { Autosave } from '../autosave';
import { RichEditor } from './RichEditor';
import { DocumentTabs } from './DocumentTabs';
import { GoogleDocsEditor } from './GoogleDocsEditor';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
const LABELS: Record<SaveState, string> = {
  saved: 'Enregistré',
  dirty: 'Modifications en cours…',
  saving: 'Enregistrement…',
  error: 'Échec de l’enregistrement',
};

/**
 * Éditeur d'une entrée. Rendu avec `key={entry.id}` par le parent : changer
 * d'entrée remonte le composant, donc aucun brouillon ne peut fuir d'une
 * entrée à l'autre.
 */
export function EntryEditor({
  tabs = [],
  onSelectTab = () => {},
  entry,
  projects,
  onChanged,
  onDeleted,
  autoFocusTitle = false,
}: {
  tabs?: EntrySummary[];
  onSelectTab?: (id: string) => void;
  entry: Entry;
  projects: Project[];
  onChanged: () => void;
  onDeleted: () => void;
  autoFocusTitle?: boolean;
}) {
  const [draft, setDraft] = useState({
    title: entry.title,
    content_md: entry.content_md,
    content_json: entry.content_json ?? null,
    entry_date: entry.entry_date,
    project_id: entry.project_id ?? '',
  });
  const [attachments, setAttachments] = useState<Attachment[]>(entry.attachments ?? []);
  const [save, setSave] = useState<SaveState>('saved');
  const [writing, setWriting] = useState(autoFocusTitle);
  const [error, setError] = useState('');
  const [googleSync, setGoogleSync] = useState(entry.google_sync);
  const integratedGoogle = Boolean(window.worklogsDesktop?.googleDocs);
  const [nativeGoogle, setNativeGoogle] = useState(Boolean(integratedGoogle && entry.google_sync && !entry.google_sync.dirty));
  const [syncing, setSyncing] = useState(false);
  const [richVersion, setRichVersion] = useState(0);
  const [syncMessage, setSyncMessage] = useState('');
  const [snapshotStale, setSnapshotStale] = useState(false);
  const [googleHelp, setGoogleHelp] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const [autosave] = useState(() => new Autosave<typeof draft>(async (body) => {
    if (!body.title.trim()) throw new Error('Le titre de l’entrée est requis.');
    await api.updateEntry(entry.id, { ...body, project_id: body.project_id || null });
    changedRef.current();
  }));

  const update = (patch: Partial<typeof draft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    autosave.update(next);
    if (patch.content_json) setGoogleSync(current => current ? { ...current, dirty: true } : current);
  };

  // L'aperçu Markdown (marked + DOMPurify) est le rendu le plus coûteux :
  // on ne le recalcule qu'à contenu changeant, pas à chaque changement
  // d'état de sauvegarde qui re-rend l'éditeur.
  const previewHtml = useMemo(() => renderMarkdown(draft.content_md), [draft.content_md]);

  const persist = async () => {
    await autosave.flush().catch(() => {});
  };

  // Changer d’entrée termine aussi l’écriture du brouillon précédent.
  useEffect(() => {
    autosave.onState = (state, message) => { setSave(state); setError(message || ''); };
    return () => {
      autosave.onState = () => {};
      void autosave.flush().catch(() => {});
    };
  }, [autosave]);

  // Ctrl+S enregistre tout de suite, par réflexe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        persist();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const added = await Promise.all(Array.from(files, (file) => api.upload(file, entry.id)));
      setAttachments((prev) => [...added, ...prev]);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeFile = async (file: Attachment) => {
    if (!confirm(`Supprimer « ${file.filename} » ?`)) return;
    await api.deleteAttachment(file.id);
    setAttachments((prev) => prev.filter((a) => a.id !== file.id));
    onChanged();
  };

  const remove = async () => {
    if (!confirm(`Supprimer l’entrée « ${draft.title} » et ses fichiers ?`)) return;
    await autosave.flush();
    await api.deleteEntry(entry.id);
    onDeleted();
  };

  const synchronize = async (pull = false) => {
    if (!draftRef.current.content_json) return;
    if (pull && !confirm('Remplacer le contenu local par la version Google ? Les modifications locales non synchronisées seront perdues.')) return;
    setSyncing(true); setError(''); setGoogleHelp(''); setSyncMessage('');
    try {
      await autosave.flush();
      const expected = draftRef.current.content_json;
      const updated = pull ? await api.pullGoogleDocument(entry.id, expected) : await api.pushGoogleDocument(entry.id);
      const changedDuringSync = draftRef.current.content_json !== expected;
      if (pull || (draftRef.current.content_json === expected && JSON.stringify(updated.content_json) !== JSON.stringify(expected))) {
        // Les frappes arrivées pendant le réseau restent prioritaires côté interface.
        if (draftRef.current.content_json !== expected) {
          autosave.update(draftRef.current);
          await autosave.flush();
          throw new Error('Ton brouillon a changé pendant le rechargement et a été conservé.');
        }
        const next = { ...draftRef.current, content_json: updated.content_json ?? null, content_md: updated.content_md };
        draftRef.current = next; setDraft(next); setRichVersion(v => v + 1);
      }
      setGoogleSync(updated.google_sync ? { ...updated.google_sync, dirty: updated.google_sync.dirty || (!pull && changedDuringSync) } : null);
      setSnapshotStale(false);
      onChanged();
      return !updated.google_sync?.dirty && !changedDuringSync;
    } catch (e) { setError((e as Error).message); setGoogleHelp(googleHelpUrl(e)); } finally { setSyncing(false); }
  };

  const keepCopy = async () => {
    try {
      await autosave.flush();
      await api.copyEntry(entry.id);
      setSyncMessage('Copie locale créée dans le journal, avec ses fichiers.');
      onChanged();
    } catch (e) { setError((e as Error).message); }
  };

  const googleUrl = googleSync ? `https://docs.google.com/document/d/${encodeURIComponent(googleSync.document_id)}/edit${googleSync.tab_id ? `?tab=${encodeURIComponent(googleSync.tab_id)}` : ''}` : '';
  const openIntegratedGoogle = async () => {
    setSyncing(true);
    try {
      await autosave.flush();
      if (googleSync?.dirty && !await synchronize()) return;
      setNativeGoogle(true);
    } catch (e) { setError((e as Error).message); }
    finally { setSyncing(false); }
  };
  const openLocalCopy = async () => {
    if (!googleSync || !draftRef.current.content_json) return;
    setSyncing(true);
    try {
    await autosave.flush();
    if (!await window.worklogsDesktop?.googleDocs?.close(googleSync.document_id)) return;
    try {
      const updated = await api.openGoogleDocument(googleSync.document_id, googleSync.tab_id || undefined);
      const next = { ...draftRef.current, content_json: updated.content_json ?? null, content_md: updated.content_md };
      draftRef.current = next; setDraft(next); setGoogleSync(updated.google_sync); setRichVersion(v => v + 1);
      setSnapshotStale(false);
      setSyncMessage(updated.google_sync?.dirty ? 'Ton brouillon local est conservé. Les autres onglets sont actualisés depuis Google.' : 'Copie locale et onglets actualisés depuis Google.');
      setError(''); onChanged();
    } catch (e) {
      setSnapshotStale(true);
      setError(`La copie locale n’a pas pu être actualisée : ${(e as Error).message}`);
    }
    // La copie reste un instantané local daté si le réseau ne répond plus.
    setNativeGoogle(false);
    } finally { setSyncing(false); }
  };
  const selectTab = async (id: string) => {
    try { await autosave.flush(); onSelectTab(id); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <section className={'editor' + (googleSync ? ' google-editor' : '') + (nativeGoogle ? ' has-google-native' : '')} aria-label="Entrée">
      {googleSync && <div className="document-heading no-print">
        <div><span className="document-eyebrow">Google Docs</span><h1>{googleSync.document_title || draft.title}</h1></div>
        {integratedGoogle ? !nativeGoogle && <button className="sync-primary" disabled={syncing} onClick={() => void openIntegratedGoogle()}>{googleSync.dirty ? 'Envoyer le brouillon et ouvrir l’éditeur complet' : 'Modifier dans WorkLogs'}</button> : <a className="ghost" href={googleUrl} target="_blank" rel="noopener noreferrer">Ouvrir dans Google Docs ↗</a>}
      </div>}
      <details className={'document-details no-print' + (googleSync ? '' : ' local-details')} open={googleSync ? undefined : true}>
      {googleSync && <summary>Détails du document</summary>}
      <div className="editor-bar no-print">
        <input
          className="title"
          aria-label="Titre de l’entrée"
          value={draft.title}
          disabled={syncing}
          autoFocus={autoFocusTitle}
          placeholder="Titre de l’entrée"
          onChange={(e) => update({ title: e.target.value })}
        />
        <span className={'save save-' + save}>{LABELS[save]}</span>
      </div>

      <div className="editor-meta no-print">
        <input
          type="date"
          aria-label="Date de l’entrée"
          value={draft.entry_date}
          disabled={syncing}
          onChange={(e) => e.target.value && update({ entry_date: e.target.value })}
        />
        <select
          aria-label="Projet de l’entrée"
          value={draft.project_id}
          disabled={syncing}
          onChange={(e) => update({ project_id: e.target.value })}
        >
          <option value="">Sans projet</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {!draft.content_json && <div className="modes" role="group" aria-label="Mode d’affichage">
          <button
            className={writing ? 'is-on' : ''}
            aria-pressed={writing}
            onClick={() => setWriting(true)}
          >
            Écrire
          </button>
          <button
            className={writing ? '' : 'is-on'}
            aria-pressed={!writing}
            onClick={() => setWriting(false)}
          >
            Lire
          </button>
        </div>}

        <span className="grow" />
        <button className="ghost" onClick={() => nativeGoogle ? void window.worklogsDesktop?.googleDocs?.print() : window.print()}>
          Imprimer
        </button>
        <button className="danger" disabled={syncing} onClick={remove}>
          Supprimer
        </button>
      </div>

      </details>
      {error && <p role="alert" className="error no-print">{error}</p>}
      {error && googleHelp && <a className="no-print" href={googleHelp} target="_blank" rel="noopener noreferrer">Activer l’API dans Google Cloud</a>}
      {syncMessage && <p className="rich-count no-print" role="status">{syncMessage}</p>}
      {!nativeGoogle && draft.content_json && <div className="google-sync no-print" aria-label="Synchronisation Google Drive">
        <div className="sync-status" role="status">
          <strong>{syncing ? 'Synchronisation…' : snapshotStale ? 'Copie locale à actualiser' : googleSync?.sync_blocked ? 'Ancien import à actualiser' : googleSync ? googleSync.dirty ? 'Prêt à synchroniser' : 'À jour sur Google Drive' : 'Enregistré sur cet appareil'}</strong>
          <span>{googleSync ? `${LABELS[save]} sur cet appareil${googleSync.dirty ? ' · modifications à envoyer' : ''}` : 'Sauvegarde locale automatique'}</span>
        </div>
        <button className="sync-primary" disabled={syncing} onClick={() => void synchronize()}>{googleSync ? 'Enregistrer sur Drive' : 'Synchroniser avec Drive'}</button>
        {googleSync && <>
          <button className="ghost" aria-label="Recharger depuis Google" disabled={syncing} onClick={() => void synchronize(true)}>Actualiser</button>
          <details className="document-actions"><summary aria-label="Autres actions du document">•••</summary><div>
            <button className="ghost" disabled={syncing} onClick={() => void keepCopy()}>Garder une copie locale</button>
          </div></details>
        </>}
      </div>}

      <h1 className="print-only print-title">{draft.title}</h1>

      {nativeGoogle && googleSync ? <GoogleDocsEditor documentId={googleSync.document_id} tabId={googleSync.tab_id || ''} onLocalCopy={openLocalCopy} /> : <div className={'document-workspace' + (googleSync && tabs.length ? ' has-tabs' : '')}>
        {googleSync && tabs.length > 0 && <DocumentTabs tabs={tabs} selectedId={entry.id} onSelect={id => { if (!syncing) void selectTab(id); }} />}
        <div className="document-page" id="document-tab-panel" role={googleSync && tabs.length ? 'tabpanel' : undefined} aria-labelledby={googleSync && tabs.length ? `tab-${entry.id}` : undefined}>
        {googleSync && <div className="document-page-heading no-print"><h2>{googleSync.tab_title || 'Document'}</h2><span>Édition</span></div>}
      {googleSync?.sync_blocked && (
        // Modifiable, mais non renvoyé : c'est un avertissement, pas une erreur.
        <p className="notice no-print">
          <b>Cet onglet utilise un ancien import simplifié.</b> Garde une copie locale si tu l’as modifié,
          puis utilise Actualiser pour retrouver les tableaux et la synchronisation.
        </p>
      )}
      {Boolean(googleSync?.preserved_elements) && <p className="google-preservation no-print">{integratedGoogle ? <>Cette copie locale conserve les éléments Google. <button className="ghost" disabled={syncing} onClick={() => void openIntegratedGoogle()}>Modifier les menus déroulants, pastilles et suggestions dans WorkLogs</button></> : <>Les éléments Google signalés restent conservés à l’envoi. Pour modifier un menu déroulant, une image ou une suggestion, <a href={googleUrl} target="_blank" rel="noopener noreferrer">ouvre cet onglet dans Google Docs</a>.</>}</p>}
      {draft.content_json ? <RichEditor key={richVersion} disabled={syncing} googleLinked={Boolean(googleSync)} entryId={entry.id} content={draft.content_json} onChange={(content_json) => update({ content_json })} /> : <div className={'sheet' + (writing ? ' is-split' : '')}>
        {writing && (
          <textarea
            className="source no-print"
            aria-label="Contenu en Markdown"
            placeholder={'## Ce que j’ai fait\n\n- …\n\n> Décision : …'}
            value={draft.content_md}
            onChange={(e) => update({ content_md: e.target.value })}
          />
        )}
        <article
          className="prose"
          aria-label="Aperçu"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      </div>}

      </div>
      </div>}
      {!nativeGoogle && <div className="files no-print">
        <label className="ghost file-button">
          📎 Joindre un fichier
          <input
            type="file"
            multiple
            disabled={syncing}
            aria-label="Joindre un fichier"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        {attachments.map((file) => (
          <span className="file" key={file.id}>
            <a href={api.fileUrl(file.stored)}>{file.filename}</a>
            <small>{formatSize(file.size)}</small>
            <button
              className="icon"
              aria-label={`Supprimer ${file.filename}`}
              onClick={() => removeFile(file)}
            >
              ✕
            </button>
          </span>
        ))}
      </div>}
    </section>
  );
}
