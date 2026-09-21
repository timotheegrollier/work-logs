import { useEffect, useMemo, useRef, useState } from 'react';
import { api, formatSize, googleHelpUrl, subtasksMd, type Attachment, type Entry, type EntrySummary, type Project, type Status } from '../lib';
import { parseChecklist, proofreadEntry, readAiSettings, suggestSubtasks } from '../ai-suggest';
import { renderMarkdown, toggleChecklistItem } from '../markdown';
import { Autosave } from '../autosave';
import { RichEditor } from './RichEditor';
import { DocumentTabs } from './DocumentTabs';
import { GoogleDocsEditor } from './GoogleDocsEditor';
import { FileViewer } from './FileViewer';

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
  linkedTasks = [],
  onChanged,
  onDeleted,
  onTaskCreated,
  autoFocusTitle = false,
}: {
  tabs?: EntrySummary[];
  onSelectTab?: (id: string) => void;
  entry: Entry;
  projects: Project[];
  linkedTasks?: { title: string; status: Status }[];
  onChanged: () => void;
  onDeleted: () => void;
  onTaskCreated?: () => void;
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
  /** Pièce jointe dont l'aperçu est ouvert, sinon `null` (aucun dialogue). */
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [driveNotice, setDriveNotice] = useState('');
  // L'archivage est une action explicite, hors enregistrement automatique.
  const [archived, setArchived] = useState(entry.archived ?? 0);
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
  const [taskCreator, setTaskCreator] = useState(false);
  const [taskTitle, setTaskTitle] = useState(entry.title);
  const [taskDueDate, setTaskDueDate] = useState('');
  const [taskCreating, setTaskCreating] = useState(false);
  const [taskMessage, setTaskMessage] = useState('');
  useEffect(() => {
    setArchived(entry.archived ?? 0);
  }, [entry.id, entry.archived]);
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
  // d'état de sauvegarde qui re-rend l'éditeur. En mode Lire, les cases à
  // cocher restent actives : `marked` les rend `disabled`, on retire ce seul
  // attribut. En mode Écrire, le textearea fait foi et les cases restent
  // inertes, comme l'aperçu de relecture IA.
  const previewHtml = useMemo(
    () => renderMarkdown(draft.content_md, { interactiveCheckboxes: !writing && !draft.content_json }),
    [draft.content_md, writing, draft.content_json],
  );

  // Cocher une case en mode Lire inverse le statut dans le Markdown, qui est
  // enregistré comme une frappe : les cases du HTML rendu et celles du texte
  // restent synchronisées par le re-rendu. `onClick` sur l'article (et non
  // `onChange`) : React ne fait pas remonter le `change` synthétique depuis
  // un enfant injecté via `dangerouslySetInnerHTML`, alors que le clic
  // remonte. `preventDefault` évite la bascule visuelle du DOM avant le
  // re-rendu ; Espace au clavier déclenche aussi un clic sur une case.
  const onPreviewChecklistClick = (e: React.MouseEvent<HTMLElement>) => {
    if (writing || draft.content_json || syncing) return;
    const target = e.target as HTMLElement;
    if (target.tagName !== 'INPUT' || (target as HTMLInputElement).type !== 'checkbox') return;
    e.preventDefault();
    const index = Array.from(e.currentTarget.querySelectorAll('input[type="checkbox"]')).indexOf(target as HTMLInputElement);
    if (index < 0) return;
    update({ content_md: toggleChecklistItem(draftRef.current.content_md, index) });
  };

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

  // Fichier adossé à Drive mais absent en local (restauration, autre appareil) :
  // un clic le retélécharge, puis l'aperçu et le téléchargement refonctionnent.
  const fetchFromDrive = async (file: Attachment) => {
    setFetchingId(file.id);
    setDriveNotice('');
    setError('');
    try {
      const updated = await api.fetchDriveAttachment(file.id);
      setAttachments((prev) => prev.map((a) => (a.id === file.id ? { ...a, ...updated } : a)));
      setPreviewing((current) => (current?.id === file.id ? { ...current, ...updated } : current));
      setDriveNotice(`« ${file.filename} » récupéré depuis Google Drive.`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFetchingId(null);
    }
  };

  const remove = async () => {
    if (!confirm(`Supprimer l’entrée « ${draft.title} » et ses fichiers ?`)) return;
    await autosave.flush();
    await api.deleteEntry(entry.id);
    onDeleted();
  };

  // Archiver masque du journal sans rien détruire (associations et, pour
  // Google, fichier distant conservés) ; désarchiver restaure. La suppression
  // locale d'un document Google ne touche jamais le fichier distant.
  const toggleArchive = async () => {
    try {
      await autosave.flush();
      const updated = await api.updateEntry(entry.id, { archived: archived ? 0 : 1 });
      setArchived(updated.archived ?? 0);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
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

    const openTaskCreator = () => {
    setTaskTitle(draftRef.current.title);
    setTaskDueDate('');
    setTaskMessage('');
    setError('');
    setTaskCreator(true);
  };
  // Suggestion IA : un clic = un envoi du titre et du contenu de l'entrée au
  // service configuré en Paramètres. Markdown seul : les documents riches
  // n'ont pas de cases. Le bloc inséré est suivi pour pouvoir le régénérer
  // ou le retirer sans toucher au reste.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestedBlock, setSuggestedBlock] = useState<string | null>(null);
  const suggestForEntry = async () => {
    if (suggesting || draftRef.current.content_json) return;
    setSuggesting(true);
    setError('');
    try {
      await autosave.flush();
      const content = draftRef.current.content_md;
      const raw = await suggestSubtasks(readAiSettings(), draftRef.current.title, {
        context: {
          project: projects.find((project) => project.id === entry.project_id)?.name,
          entryText: content,
          existingSubtasks: parseChecklist(content),
          attachments: attachments.map((file) => file.filename),
          linkedTasks: linkedTasks
            .filter((task) => task.status !== 'done')
            .map((task) => task.title),
        },
      });
      const block = subtasksMd(raw);
      const current = content.trim();
      // Suggérer remplace le bloc suivi, sinon ajoute : un seul geste.
      if (suggestedBlock && content.includes(suggestedBlock)) {
        update({ content_md: content.replace(suggestedBlock, block) });
      } else {
        update({ content_md: (current ? current.replace(/\s+$/, '') + '\n' : '') + block });
      }
      setSuggestedBlock(block);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };
  const removeSuggestion = () => {
    if (!suggestedBlock) return;
    const content = draftRef.current.content_md;
    const withSeparator = '\n' + suggestedBlock;
    update({
      content_md: content.includes(withSeparator)
        ? content.replace(withSeparator, '')
        : content.replace(suggestedBlock, ''),
    });
    setSuggestedBlock(null);
  };
  // Mise en page IA : même transport que les suggestions, Markdown seul, mais la
  // version corrigée se relit avant application — jamais d'écrasement aveugle.
  const [proofreading, setProofreading] = useState(false);
  const [proofreadPreview, setProofreadPreview] = useState<{ source: string; fixed: string } | null>(null);
  const proofreadHtml = useMemo(() => (proofreadPreview ? renderMarkdown(proofreadPreview.fixed) : ''), [proofreadPreview]);
  const proofreadEntryText = async () => {
    if (proofreading || syncing || draftRef.current.content_json) return;
    setProofreading(true);
    setError('');
    setProofreadPreview(null);
    try {
      await autosave.flush();
      const source = draftRef.current.content_md;
      const fixed = await proofreadEntry(readAiSettings(), draftRef.current.title, source);
      setProofreadPreview({ source, fixed });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProofreading(false);
    }
  };
  const applyProofread = () => {
    if (!proofreadPreview) return;
    // Le texte a bougé pendant la relecture : appliquer effacerait ces frappes.
    if (draftRef.current.content_md !== proofreadPreview.source) {
      setProofreadPreview(null);
      setError('L’entrée a changé pendant la mise en page : relance-la pour ne rien perdre.');
      return;
    }
    update({ content_md: proofreadPreview.fixed });
    setProofreadPreview(null);
    setSuggestedBlock(null);
  };
  const createTask = async () => {
    const title = taskTitle.trim();
    if (!title) return;
    setTaskCreating(true);
    setError('');
    try {
      await autosave.flush();
      await api.createTaskFromEntry(entry.id, { title, due_date: taskDueDate || null });
      setTaskCreator(false);
      setTaskMessage('Tâche créée et liée à cette entrée.');
      onTaskCreated?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTaskCreating(false);
    }
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
      <div className="entry-task-action no-print">
        {!taskCreator ? <button className="task-primary" type="button" disabled={syncing} onClick={openTaskCreator}>Créer une tâche liée</button> : <form className="task-creator" onSubmit={(event) => { event.preventDefault(); void createTask(); }}>          <strong>Nouvelle tâche liée à cette entrée</strong>
          <label>Titre de la tâche<input aria-label="Titre de la tâche liée" autoFocus value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} /></label>
          <label>Échéance facultative<input aria-label="Échéance de la tâche liée" type="date" value={taskDueDate} onChange={(event) => setTaskDueDate(event.target.value)} /></label>
          <div className="task-creator-actions">
            <button className="task-primary" type="submit" disabled={taskCreating || !taskTitle.trim()}>{taskCreating ? 'Création…' : 'Créer et lier'}</button>
            <button className="ghost" type="button" disabled={taskCreating} onClick={() => setTaskCreator(false)}>Annuler</button>
          </div>
        </form>}
        {taskMessage && <p className="task-message" role="status">{taskMessage}</p>}
        {!draft.content_json && (
          <button
            className="ghost"
            type="button"
            disabled={suggesting || syncing}
            title="Remplace le bloc suggéré, ou l’ajoute (envoie le titre et le contenu de l’entrée au service IA configuré en Paramètres)"
            onClick={() => void suggestForEntry()}
          >
            {suggesting ? 'Suggestion…' : '✨ Suggérer des sous-tâches'}
          </button>
        )}
        {!draft.content_json && (
          <button
            className="ghost"
            type="button"
            disabled={suggesting || proofreading || syncing || !draft.content_md.trim()}
            title="Corrige les fautes et met en page (envoie le titre et le contenu de l’entrée au service IA configuré en Paramètres, à relire avant application)"
            onClick={() => void proofreadEntryText()}
          >
            {proofreading ? 'Mise en page…' : '✨ Mettre en page'}
          </button>
        )}
        {suggestedBlock && (
          <button
            className="ghost"
            type="button"
            disabled={suggesting || syncing}
            aria-label="Retirer la suggestion"
            title="Supprime le bloc suggéré sans toucher au reste"
            onClick={removeSuggestion}
          >
            Retirer
          </button>
        )}
      </div>
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
        <button className="ghost" disabled={syncing} onClick={() => void toggleArchive()}>
          {archived ? 'Désarchiver' : 'Archiver'}
        </button>
        <button
          className="danger"
          disabled={syncing}
          onClick={remove}
          title={googleSync ? 'Retire la copie locale (le fichier Google distant est conservé)' : 'Supprime définitivement l’entrée et ses fichiers'}
        >
          Supprimer
        </button>
      </div>

      </details>
      {error && <p role="alert" className="error no-print">{error}</p>}
      {error && googleHelp && <a className="no-print" href={googleHelp} target="_blank" rel="noopener noreferrer">Activer l’API dans Google Cloud</a>}
      {proofreadPreview && !draft.content_json && <div className="proofread-preview no-print" role="region" aria-label="Mise en page proposée">
        <strong>Mise en page proposée — relis avant d’appliquer</strong>
        <article className="prose" dangerouslySetInnerHTML={{ __html: proofreadHtml }} />
        <div className="task-creator-actions">
          <button className="task-primary" type="button" disabled={syncing} onClick={applyProofread}>Appliquer la mise en page</button>
          <button className="ghost" type="button" onClick={() => setProofreadPreview(null)}>Ignorer</button>
        </div>
      </div>}
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
          onClick={onPreviewChecklistClick}
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
            {file.driveFileId
              ? <small className="picker-source is-google" title="Binaire conservé sur Google Drive">☁ Drive</small>
              : <small className="picker-source" title="Fichier uniquement sur cet appareil">local seul</small>}
            <button
              className="ghost file-preview"
              type="button"
              aria-label={`Aperçu de ${file.filename}`}
              onClick={() => setPreviewing(file)}
            >
              👁 Aperçu
            </button>
            {file.driveFileId && <button
              className="ghost file-preview"
              type="button"
              disabled={fetchingId === file.id}
              title="Retélécharger le binaire depuis Google Drive"
              aria-label={`Récupérer ${file.filename} depuis Drive`}
              onClick={() => void fetchFromDrive(file)}
            >
              {fetchingId === file.id ? 'Récupération…' : '⬇ Récupérer'}
            </button>}
            <button
              className="icon"
              aria-label={`Supprimer ${file.filename}`}
              onClick={() => removeFile(file)}
            >
              ✕
            </button>
          </span>
        ))}
        {driveNotice && <p className="drive-success" role="status">{driveNotice}</p>}
      </div>}
      {previewing && <FileViewer key={previewing.id + (previewing.driveFileId || '')} file={previewing} onClose={() => setPreviewing(null)} onFetch={() => previewing && void fetchFromDrive(previewing)} fetching={fetchingId === previewing.id} />}
    </section>
  );
}
