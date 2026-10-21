import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, COLUMNS, formatSize, googleHelpUrl, subtasksMd, type Attachment, type Entry, type EntrySummary, type Project, type RichDocument, type Status } from '../lib';
import { draftProcedure, extractEntryActions, parseChecklist, proofreadEntry, readAiSettings, suggestProcedure, suggestSubtasks, type AiWorkContext, type DraftedProcedure, type ExtractedAction } from '../ai-suggest';
import { loadAiContext, selectedAiContext } from '../ai-context';
import { insertCodeFence, renderMarkdown, toggleChecklistItem } from '../markdown';
import { markdownToRich, richToMarkdown } from '../rich-markdown';
import { deleteAttachmentQuestion, downloadAttachment } from '../attachment-download';
import { Autosave } from '../autosave';
import { RichEditor } from './RichEditor';
import { DocumentTabs } from './DocumentTabs';
import { GoogleDocsEditor } from './GoogleDocsEditor';
import { FileViewer } from './FileViewer';
import { ProcedureDraft } from './ProcedureDraft';
import { AiContextDetails } from './AiContextDetails';
import { AiRefinement } from './AiRefinement';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
const LABELS: Record<SaveState, string> = {
  saved: 'Enregistré',
  dirty: 'Modifications en cours…',
  saving: 'Enregistrement…',
  error: 'Échec de l’enregistrement',
};

/** Proposition IA à relire : mise en page de l'entrée, ou étapes d'une procédure. */
type AiMode = 'layout' | 'procedure';
/** Empreinte du contenu : ce qui a changé entre la demande et l'application. */
const contentSnapshot = (draft: { content_md: string; content_json: RichDocument | null }) =>
  draft.content_json ? JSON.stringify(draft.content_json) : draft.content_md;
const actionTitleKey = (title: string) => title.normalize('NFKC').toLocaleLowerCase('fr').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
type ActionChoice = ExtractedAction & { selected: boolean; created: boolean };

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
  tasks = [],
  onChanged,
  onDeleted,
  onTaskCreated,
  onProcedureCreated,
  autoFocusTitle = false,
  editRequest = 0,
}: {
  tabs?: EntrySummary[];
  onSelectTab?: (id: string) => void;
  entry: Entry;
  projects: Project[];
  linkedTasks?: { id: string; title: string; status: Status }[];
  /** Toutes les tâches, pour lier l'entrée à des existantes (miroir du lieur de la carte). */
  tasks?: { id: string; title: string; status: Status }[];
  onChanged: () => void;
  onDeleted: () => void;
  onTaskCreated?: () => void;
  /** Procédure tirée de cette entrée par l'IA, créée : l'app l'ouvre. */
  onProcedureCreated?: (procedure: Entry) => void;
  autoFocusTitle?: boolean;
  editRequest?: number;
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
  useEffect(() => { if (editRequest) setWriting(true); }, [editRequest]);
  // Les fichiers peuvent aussi être ajoutés depuis la sidebar Procédures.
  useEffect(() => { setAttachments(entry.attachments ?? []); }, [entry.attachments]);
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
  // Lier à des tâches existantes : même geste que le lieur de documents de la
  // carte (recherche + sélection multiple), dans l'autre sens.
  const [linkingTasks, setLinkingTasks] = useState(false);
  const [taskFilter, setTaskFilter] = useState('');
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]);
  const [linkingBusy, setLinkingBusy] = useState(false);
  useEffect(() => {
    setArchived(entry.archived ?? 0);
  }, [entry.id, entry.archived]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const projectVersion = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const sameProject = (projectId: string) => mounted.current && draftRef.current.project_id === projectId;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  // Un titre vidé n'est pas envoyé : l'entrée garde le dernier (en filigrane du
  // champ) et le reste du brouillon s'enregistre. Le refuser laissait, une fois
  // l'entrée quittée, un brouillon en échec que la fermeture rejouait sans fin.
  const [savedTitle, setSavedTitle] = useState(entry.title);
  const [autosave] = useState(() => new Autosave<typeof draft>(async ({ title, ...body }) => {
    await api.updateEntry(entry.id, { ...body, ...(title.trim() ? { title } : {}), project_id: body.project_id || null });
    if (title.trim()) setSavedTitle(title);
    changedRef.current();
  }));

  const update = (patch: Partial<typeof draft>) => {
    if (patch.project_id !== undefined && patch.project_id !== draftRef.current.project_id) projectVersion.current += 1;
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

  // « Bloc de code » en mode Écrire : clôtures ``` autour des lignes
  // sélectionnées, ou bloc vide au curseur. La sélection n'est rendue au
  // textarea qu'une fois le texte affiché (sinon le curseur part en fin).
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const insertCodeBlock = () => {
    const source = sourceRef.current;
    if (!source) return;
    const next = insertCodeFence(draftRef.current.content_md, source.selectionStart, source.selectionEnd);
    flushSync(() => update({ content_md: next.text }));
    source.focus();
    source.setSelectionRange(next.start, next.end);
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
    if (!confirm(deleteAttachmentQuestion(file))) return;
    setError('');
    try {
      await api.deleteAttachment(file.id);
      setAttachments((prev) => prev.filter((a) => a.id !== file.id));
      if (previewing?.id === file.id) setPreviewing(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
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
    if (!confirm(`Supprimer l’entrée « ${draft.title.trim() ? draft.title : savedTitle} » et ses fichiers ?`)) return;
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
  const [aiContext, setAiContext] = useState<AiWorkContext | null>(null);
  const [excludedAiSources, setExcludedAiSources] = useState<string[]>([]);
  const excludedAiSourcesRef = useRef(excludedAiSources);
  const aiContextVersion = useRef(0);
  const suggestedContextVersion = useRef(-1);
  const excludeAiSources = (ids: string[]) => {
    aiContextVersion.current += 1;
    excludedAiSourcesRef.current = ids;
    setExcludedAiSources(ids);
    setAiProposal(null);
    setProcedureDraft(null);
  };
  const settingsForAi = (feature: string) => {
    const settings = readAiSettings();
    if (!settings.key) throw new Error(`Colle ta clé IA dans ⚙ Paramètres pour activer ${feature}.`);
    return settings;
  };
  const contextForAi = async (current: typeof draft, version: number, contextVersion: number) => {
    const context = await loadAiContext({ projectId: current.project_id || null, title: current.title, entryId: entry.id });
    if (!sameProject(current.project_id) || projectVersion.current !== version || aiContextVersion.current !== contextVersion) return null;
    setAiContext(context);
    return selectedAiContext(context, excludedAiSourcesRef.current);
  };
  const suggestForEntry = async (instruction?: string) => {
    if (aiWorking || draftRef.current.content_json) return;
    const projectId = draftRef.current.project_id;
    const version = projectVersion.current;
    const contextVersion = aiContextVersion.current;
    setSuggesting(true);
    setError('');
    try {
      const settings = settingsForAi('les suggestions');
      await autosave.flush();
      if (!mounted.current) return;
      const current = draftRef.current;
      const refinement = instruction && suggestedBlock && suggestedContextVersion.current === contextVersion ? { instruction, previous: suggestedBlock } : undefined;
      // Affiner retravaille le bloc suivi : il n'est pas une sous-tâche « déjà présente » à éviter.
      const content = refinement ? current.content_md.replace(refinement.previous, '') : current.content_md;
      const context = await contextForAi(current, version, contextVersion);
      if (!context) return;
      const raw = await suggestSubtasks(settings, current.title, {
        refinement,
        context: {
          ...context,
          entryText: content,
          existingSubtasks: parseChecklist(content),
          attachments: attachments.map((file) => file.filename),
          linkedTasks: linkedTasks
            .filter((task) => task.status !== 'done')
            .map((task) => task.title),
        },
      });
      if (!sameProject(current.project_id) || projectVersion.current !== version || aiContextVersion.current !== contextVersion) return;
      // Les frappes faites pendant l'appel restent prioritaires ; on ne remplace
      // que le bloc suivi, s'il existe toujours dans le brouillon actuel.
      const latest = draftRef.current.content_md;
      const outsideBlock = suggestedBlock && latest.includes(suggestedBlock) ? latest.replace(suggestedBlock, '') : latest;
      const existing = new Set(parseChecklist(outsideBlock).map((item) => actionTitleKey(item.text)));
      const freshLines = raw.split('\n').filter((line) => {
        const key = actionTitleKey(line);
        if (!key || existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      // Une case ajoutée pendant la demande compte elle aussi comme existante.
      if (!freshLines.length) return;
      const block = subtasksMd(freshLines.join('\n'));
      // Suggérer remplace le bloc suivi, sinon ajoute : un seul geste.
      if (suggestedBlock && latest.includes(suggestedBlock)) {
        update({ content_md: latest.replace(suggestedBlock, block) });
      } else {
        update({ content_md: (latest.trim() ? latest.replace(/\s+$/, '') + '\n' : '') + block });
      }
      suggestedContextVersion.current = contextVersion;
      setSuggestedBlock(block);
    } catch (e) {
      if (sameProject(projectId) && projectVersion.current === version && aiContextVersion.current === contextVersion) setError((e as Error).message);
    } finally {
      if (mounted.current) setSuggesting(false);
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
  // Propositions IA, même transport que les suggestions, à relire avant
  // application — jamais d'écrasement aveugle : mise en page de toute entrée
  // Markdown et, pour une procédure, suggestion des étapes. Une procédure riche
  // passe par le Markdown (`rich-markdown.ts`) ; un document Google reste exclu.
  const isProcedure = entry.kind === 'procedure';
  // Écrire / Lire : les entrées Markdown, et les procédures riches locales ; un
  // document Google garde son propre parcours d'édition.
  const hasModes = !draft.content_json || (isProcedure && !googleSync);
  const aiAvailable = !draft.content_json || (isProcedure && !googleSync);
  const aiText = useMemo(() => (draft.content_json ? richToMarkdown(draft.content_json) : draft.content_md), [draft.content_json, draft.content_md]);
  const [aiBusy, setAiBusy] = useState<AiMode | null>(null);
  const [aiProposal, setAiProposal] = useState<{ mode: AiMode; snapshot: string; projectId: string; version: number; source: string; title: string; fixed: string } | null>(null);
  const aiProposalHtml = useMemo(() => (aiProposal ? renderMarkdown(aiProposal.fixed) : ''), [aiProposal]);
  const requestAi = async (mode: AiMode, instruction?: string) => {
    if (aiWorking || syncing || !aiAvailable) return;
    const projectId = draftRef.current.project_id;
    const version = projectVersion.current;
    const contextVersion = aiContextVersion.current;
    setAiBusy(mode);
    setError('');
    try {
      const settings = settingsForAi(mode === 'layout' ? 'la mise en page' : 'les suggestions de procédure');
      await autosave.flush();
      if (!mounted.current) return;
      const current = draftRef.current;
      const previous = instruction ? aiProposal : null;
      const snapshot = previous?.snapshot ?? contentSnapshot(current);
      if (previous && (contentSnapshot(current) !== previous.snapshot || current.project_id !== previous.projectId)) {
        throw new Error('L’entrée a changé depuis la proposition : relance-la pour ne rien perdre.');
      }
      const source = previous?.source ?? (current.content_json ? richToMarkdown(current.content_json) : current.content_md);
      const title = previous?.title ?? current.title;
      const context = await contextForAi(current, version, contextVersion);
      if (!context) return;
      const refinement = previous && instruction ? { instruction, previous: previous.fixed } : undefined;
      const fixed = mode === 'layout'
        ? await proofreadEntry(settings, title, source, { procedure: isProcedure, context, refinement })
        : await suggestProcedure(settings, title, {
          refinement,
          context: {
            ...context,
            attachments: attachments.map((file) => file.filename),
            text: source,
          },
        });
      if (sameProject(current.project_id) && projectVersion.current === version && aiContextVersion.current === contextVersion) setAiProposal({ mode, snapshot, projectId: current.project_id, version, source, title, fixed });
    } catch (e) {
      if (sameProject(projectId) && projectVersion.current === version && aiContextVersion.current === contextVersion) setError((e as Error).message);
    } finally {
      if (mounted.current) setAiBusy(null);
    }
  };
  const applyAi = () => {
    if (!aiProposal) return;
    // Le contenu a bougé pendant l'appel : appliquer effacerait ces frappes.
    if (contentSnapshot(draftRef.current) !== aiProposal.snapshot || draftRef.current.project_id !== aiProposal.projectId || projectVersion.current !== aiProposal.version) {
      setAiProposal(null);
      setError(aiProposal.mode === 'layout'
        ? 'L’entrée a changé pendant la mise en page : relance-la pour ne rien perdre.'
        : 'La procédure a changé pendant la suggestion : relance-la pour ne rien perdre.');
      return;
    }
    if (draftRef.current.content_json) {
      let document: RichDocument;
      try {
        document = markdownToRich(aiProposal.fixed);
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      update({ content_json: document });
      // L'éditeur riche ne lit `content` qu'à son montage.
      setRichVersion((version) => version + 1);
    } else {
      update({ content_md: aiProposal.fixed });
    }
    setAiProposal(null);
    setSuggestedBlock(null);
  };
  // Procédure tirée de cette note par l'IA : relue dans « Procédure rédigée »,
  // puis créée à part — la note ne change pas. Riche ou Markdown, la note part
  // en Markdown ; un document Google ne transite pas (§23).
  const canDraftProcedure = !isProcedure && !googleSync;
  const [drafting, setDrafting] = useState(false);
  const [procedureDraft, setProcedureDraft] = useState<DraftedProcedure | null>(null);
  const draftFromEntry = async (instruction?: string) => {
    if (aiWorking || syncing || !canDraftProcedure) return;
    const projectId = draftRef.current.project_id;
    const version = projectVersion.current;
    const contextVersion = aiContextVersion.current;
    setDrafting(true);
    setError('');
    try {
      const settings = settingsForAi('la création de procédure');
      await autosave.flush();
      if (!mounted.current) return;
      const current = draftRef.current;
      const context = await contextForAi(current, version, contextVersion);
      if (!context) return;
      const drafted = await draftProcedure(settings, {
        origin: 'entry',
        title: current.title,
        project: projects.find((project) => project.id === current.project_id)?.name,
        text: current.content_json ? richToMarkdown(current.content_json) : current.content_md,
        attachments: attachments.map((file) => file.filename),
        linkedTasks: linkedTasks.map((task) => task.title),
      }, {
        context,
        refinement: instruction && procedureDraft ? { instruction, previous: procedureDraft.markdown } : undefined,
      });
      if (sameProject(current.project_id) && projectVersion.current === version && aiContextVersion.current === contextVersion) setProcedureDraft(drafted);
    } catch (e) {
      if (sameProject(projectId) && projectVersion.current === version && aiContextVersion.current === contextVersion) setError((e as Error).message);
    } finally {
      if (mounted.current) setDrafting(false);
    }
  };
  const [extracting, setExtracting] = useState(false);
  const [actionsCreating, setActionsCreating] = useState(false);
  const [actionsProposal, setActionsProposal] = useState<{ snapshot: string; projectId: string; version: number; items: ActionChoice[] } | null>(null);
  const [actionsMessage, setActionsMessage] = useState('');
  const createdActionTitles = useRef(new Set<string>());
  const aiWorking = suggesting || aiBusy !== null || drafting || extracting || actionsCreating;
  // Un projet changé invalide ses sources et ses propositions ; les réponses
  // encore en vol vérifient elles aussi le projet avant de revenir à l'écran.
  useEffect(() => {
    setAiContext(null);
    excludedAiSourcesRef.current = [];
    setExcludedAiSources([]);
    setAiProposal(null);
    setProcedureDraft(null);
    setActionsProposal(null);
    setActionsMessage('');
  }, [draft.project_id]);
  const extractActions = async () => {
    if (aiWorking || syncing || !canDraftProcedure) return;
    const projectId = draftRef.current.project_id;
    const version = projectVersion.current;
    const contextVersion = aiContextVersion.current;
    setExtracting(true);
    setError('');
    setActionsMessage('');
    try {
      const settings = settingsForAi('l’extraction d’actions');
      await autosave.flush();
      if (!mounted.current) return;
      const current = draftRef.current;
      const snapshot = contentSnapshot(current);
      const source = current.content_json ? richToMarkdown(current.content_json) : current.content_md;
      const context = await contextForAi(current, version, contextVersion);
      if (!context) return;
      const extracted = await extractEntryActions(settings, current.title, source, {
        context: {
          ...context,
          linkedTasks: linkedTasks.map((task) => task.title),
          existingSubtasks: parseChecklist(source),
          attachments: attachments.map((file) => file.filename),
        },
      });
      if (!sameProject(current.project_id) || projectVersion.current !== version || aiContextVersion.current !== contextVersion) return;
      if (contentSnapshot(draftRef.current) !== snapshot) throw new Error('La note a changé pendant l’extraction : relance-la pour utiliser le texte actuel.');
      const existing = new Set([...linkedTasks.map((task) => actionTitleKey(task.title)), ...createdActionTitles.current]);
      const items = extracted.filter((action) => {
        const key = actionTitleKey(action.title);
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      }).map((action) => ({ ...action, selected: true, created: false }));
      setActionsProposal({ snapshot, projectId: current.project_id, version, items });
    } catch (e) {
      if (sameProject(projectId) && projectVersion.current === version && aiContextVersion.current === contextVersion) setError((e as Error).message);
    } finally {
      if (mounted.current) setExtracting(false);
    }
  };
  const editAction = (index: number, patch: Partial<ActionChoice>) => {
    setActionsProposal((proposal) => proposal ? { ...proposal, items: proposal.items.map((item, position) => position === index ? { ...item, ...patch } : item) } : null);
  };
  const createSelectedActions = async () => {
    if (!actionsProposal || aiWorking) return;
    const proposal = actionsProposal;
    const sourceIsCurrent = () => sameProject(proposal.projectId) && projectVersion.current === proposal.version && contentSnapshot(draftRef.current) === proposal.snapshot;
    if (!sourceIsCurrent()) {
      setError('La note ou son projet a changé depuis l’extraction : relance-la avant de créer les tâches.');
      return;
    }
    setActionsCreating(true);
    setActionsMessage('');
    setError('');
    let created = 0;
    let reconciled = 0;
    const failures: string[] = [];
    try {
      await autosave.flush();
      // Une réponse peut se perdre après le commit serveur : le retry relit les
      // liens réels avant toute création, même si le dernier appel a échoué ici.
      const state = await api.state('', proposal.projectId).catch(() => {
        throw new Error('Impossible de vérifier les tâches déjà liées : aucune nouvelle tâche n’a été créée. Réessaie.');
      });
      const freshLinked = state.tasks.filter((task) => task.documents.some((document) => document.id === entry.id));
      const existing = new Set([...linkedTasks.map((task) => actionTitleKey(task.title)), ...freshLinked.map((task) => actionTitleKey(task.title)), ...createdActionTitles.current]);
      for (const [index, action] of proposal.items.entries()) {
        if (!action.selected || action.created || !action.title.trim()) continue;
        if (!mounted.current) return;
        if (!sourceIsCurrent()) throw new Error('La note ou son projet a changé : les tâches restantes n’ont pas été créées. Relance l’extraction.');
        const key = actionTitleKey(action.title);
        if (existing.has(key)) {
          createdActionTitles.current.add(key);
          editAction(index, { created: true, selected: false });
          reconciled += 1;
          continue;
        }
        try {
          await api.createTaskFromEntry(entry.id, { title: action.title.trim(), due_date: action.due_date || null });
          createdActionTitles.current.add(key);
          existing.add(key);
          created += 1;
          if (!mounted.current) return;
          editAction(index, { created: true, selected: false });
        } catch (e) {
          failures.push(`« ${action.title} » : ${(e as Error).message}`);
        }
      }
      if (mounted.current) {
        const messages = [];
        if (created) messages.push(`${created} tâche${created > 1 ? 's créées et liées' : ' créée et liée'} à cette note.`);
        if (reconciled) messages.push(`${reconciled} tâche${reconciled > 1 ? 's déjà créées et liées' : ' déjà créée et liée'} à cette note.`);
        if (messages.length) setActionsMessage(messages.join(' '));
        if (failures.length) setError(`Certaines tâches n’ont pas été créées : ${failures.join(' ; ')}`);
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) {
        setActionsCreating(false);
        if (created || reconciled) onTaskCreated?.();
      }
    }
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
  const linkedTaskIds = new Set(linkedTasks.map((task) => task.id));
  const availableTasks = tasks.filter((task) => !linkedTaskIds.has(task.id));
  const taskQuery = taskFilter.trim().toLowerCase();
  const visibleTasks = taskQuery
    ? availableTasks.filter((task) => task.title.toLowerCase().includes(taskQuery))
    : availableTasks;
  const statusLabel = (status: Status) => COLUMNS.find((column) => column.id === status)?.label ?? status;
  const startTaskLinking = () => {
    setTaskFilter('');
    setSelectedTasks([]);
    setLinkingTasks(true);
  };
  const toggleTaskSelected = (id: string) => {
    setSelectedTasks((prev) => (prev.includes(id) ? prev.filter((candidate) => candidate !== id) : [...prev, id]));
  };
  const linkSelectedTasks = async () => {
    if (selectedTasks.length === 0 || linkingBusy) return;
    setLinkingBusy(true);
    setError('');
    try {
      await autosave.flush();
      await Promise.all(selectedTasks.map((id) => api.linkTaskDocument(id, entry.id)));
      setLinkingTasks(false);
      setSelectedTasks([]);
      setTaskFilter('');
      setTaskMessage(selectedTasks.length > 1 ? `${selectedTasks.length} tâches liées à cette entrée.` : 'Tâche liée à cette entrée.');
      onTaskCreated?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinkingBusy(false);
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
      {/* Document Google : titre et réglages repliés sous le vrai titre Google.
          Entrée locale : pas de dépliant — un <details> sans <summary> affichait
          le libellé « Details » du navigateur au-dessus du titre. */}
      <DetailsWrapper google={Boolean(googleSync)}>
      <div className="editor-bar no-print">
        <input
          className="title"
          aria-label="Titre de l’entrée"
          value={draft.title}
          disabled={syncing}
          autoFocus={autoFocusTitle}
          placeholder={savedTitle || 'Titre de l’entrée'}
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

        {hasModes && <div className="modes" role="group" aria-label="Mode d’affichage">
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
        {/* Même symbole que dans la barre de l'éditeur riche. */}
        {!draft.content_json && writing && (
          <button
            className="ghost"
            type="button"
            aria-label="Bloc de code"
            title="Bloc de code : entoure de ``` les lignes sélectionnées, ou en insère un vide au curseur"
            onMouseDown={(event) => event.preventDefault()}
            onClick={insertCodeBlock}
          >
            {'{ }'}
          </button>
        )}

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

      </DetailsWrapper>
      <div className="entry-task-action no-print">
        {!taskCreator ? <button className="ghost" type="button" disabled={syncing} onClick={openTaskCreator}><span aria-hidden="true">＋ </span>Créer une tâche liée</button> : <form className="task-creator" onSubmit={(event) => { event.preventDefault(); void createTask(); }}>          <strong>Nouvelle tâche liée à cette entrée</strong>
          <label>Titre de la tâche<input aria-label="Titre de la tâche liée" autoFocus value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} /></label>
          <label>Échéance facultative<input aria-label="Échéance de la tâche liée" type="date" value={taskDueDate} onChange={(event) => setTaskDueDate(event.target.value)} /></label>
          <div className="task-creator-actions">
            <button className="task-primary" type="submit" disabled={taskCreating || !taskTitle.trim()}>{taskCreating ? 'Création…' : 'Créer et lier'}</button>
            <button className="ghost" type="button" disabled={taskCreating} onClick={() => setTaskCreator(false)}>Annuler</button>
          </div>
        </form>}
        {taskMessage && <p className="task-message" role="status">{taskMessage}</p>}
        {!linkingTasks ? (
          <button className="ghost" type="button" disabled={syncing} onClick={startTaskLinking}><span aria-hidden="true">＋ </span>Lier une tâche existante</button>
        ) : (
          <div className="document-linker" aria-label={`Lier « ${draft.title} » à des tâches existantes`}>
            <div className="document-linker-head">
              <strong>Lier à des tâches existantes</strong>
              <span className="document-linker-count">
                {selectedTasks.length > 0 ? `${selectedTasks.length} sélectionnée${selectedTasks.length > 1 ? 's' : ''}` : `${availableTasks.length} disponible${availableTasks.length > 1 ? 's' : ''}`}
              </span>
            </div>
            {availableTasks.length > 0 && (
              <input
                type="search"
                aria-label="Rechercher une tâche à lier à cette entrée"
                placeholder="Rechercher…"
                value={taskFilter}
                onChange={(event) => setTaskFilter(event.target.value)}
              />
            )}
            {availableTasks.length === 0 ? (
              <p className="empty">Toutes les tâches sont déjà liées.</p>
            ) : visibleTasks.length === 0 ? (
              <p className="empty">Aucune tâche ne correspond à « {taskFilter.trim()} ».</p>
            ) : (
              <ul className="document-picker">
                {visibleTasks.map((task) => {
                  const checked = selectedTasks.includes(task.id);
                  return (
                    <li key={task.id}>
                      <label className={'picker-row' + (checked ? ' is-checked' : '')}>
                        <input
                          type="checkbox"
                          checked={checked}
                          aria-label={`Lier ${task.title} à cette entrée`}
                          onChange={() => toggleTaskSelected(task.id)}
                        />
                        <span className="picker-title">{task.title}</span>
                        <span className="picker-source">{statusLabel(task.status)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="card-actions">
              <button
                className="ghost primary"
                type="button"
                disabled={selectedTasks.length === 0 || linkingBusy}
                onClick={() => void linkSelectedTasks()}
              >
                {linkingBusy ? 'Liaison…' : selectedTasks.length > 0 ? `Relier la sélection (${selectedTasks.length})` : 'Relier la sélection'}
              </button>
              <button className="ghost" type="button" disabled={linkingBusy} onClick={() => setLinkingTasks(false)}>
                Annuler
              </button>
            </div>
          </div>
        )}
        {!draft.content_json && !isProcedure && (
          <button
            className="ghost"
            type="button"
            disabled={aiWorking || syncing}
            title="Remplace le bloc suggéré, ou l’ajoute (envoie le titre, le contenu et le contexte du projet au service IA configuré en Paramètres)"
            onClick={() => void suggestForEntry()}
          >
            {suggesting ? 'Suggestion…' : '✨ Suggérer des sous-tâches'}
          </button>
        )}
        {aiAvailable && isProcedure && (
          <button
            className="ghost"
            type="button"
            disabled={aiWorking || syncing}
            title="Propose les étapes à partir du titre, de ce qui est déjà écrit et du contexte du projet (envoyés au service IA configuré en Paramètres, à relire avant application)"
            onClick={() => void requestAi('procedure')}
          >
            {aiBusy === 'procedure' ? 'Suggestion…' : '✨ Suggérer une procédure'}
          </button>
        )}
        {aiAvailable && (
          <button
            className="ghost"
            type="button"
            disabled={aiWorking || syncing || !aiText.trim()}
            title="Corrige les fautes et met en page (envoie le titre, le contenu et le contexte du projet au service IA configuré en Paramètres, à relire avant application)"
            onClick={() => void requestAi('layout')}
          >
            {aiBusy === 'layout' ? 'Mise en page…' : '✨ Mettre en page'}
          </button>
        )}
        {canDraftProcedure && (
          <button
            className="ghost"
            type="button"
            disabled={aiWorking || syncing}
            title="Rédige une procédure réutilisable à partir de cette entrée (titre, contenu, contexte du projet, noms des pièces jointes et tâches liées envoyés au service IA configuré en Paramètres) ; à relire avant de la créer"
            onClick={() => void draftFromEntry()}
          >
            {drafting ? 'Rédaction…' : '✨ Créer une procédure'}
          </button>
        )}
        {canDraftProcedure && (
          <button
            className="ghost"
            type="button"
            disabled={aiWorking || syncing || !aiText.trim()}
            title="Envoie la note et le contexte du projet au service IA configuré en Paramètres ; choisis les actions à créer comme tâches liées après relecture"
            onClick={() => void extractActions()}
          >
            {extracting ? 'Extraction…' : '✨ Extraire les actions'}
          </button>
        )}
        {suggestedBlock && (
          <button
            className="ghost"
            type="button"
            disabled={aiWorking || syncing}
            aria-label="Retirer la suggestion"
            title="Supprime le bloc suggéré sans toucher au reste"
            onClick={removeSuggestion}
          >
            Retirer
          </button>
        )}
      </div>
      {aiContext && <AiContextDetails context={aiContext} excludedIds={excludedAiSources} onExcludedChange={excludeAiSources} />}
      {error && <p role="alert" className="error no-print">{error}</p>}
      {error && googleHelp && <a className="no-print" href={googleHelp} target="_blank" rel="noopener noreferrer">Activer l’API dans Google Cloud</a>}
      {suggestedBlock && suggestedContextVersion.current === aiContextVersion.current && <div className="proofread-preview no-print" role="region" aria-label="Affiner les sous-tâches suggérées">
        <strong>Sous-tâches suggérées</strong>
        <AiRefinement busy={aiWorking || syncing} onRefine={(instruction) => void suggestForEntry(instruction)} />
      </div>}
      {aiProposal && aiAvailable && <div className="proofread-preview no-print" role="region" aria-label={aiProposal.mode === 'layout' ? 'Mise en page proposée' : 'Procédure proposée'}>
        <strong>{aiProposal.mode === 'layout' ? 'Mise en page proposée' : 'Procédure proposée'} — relis avant d’appliquer</strong>
        {draft.content_json && <small>Titres, listes, gras, liens, images et tableaux sont gardés ; surlignage, couleurs et alignements sont remis à plat.</small>}
        <article className="prose" dangerouslySetInnerHTML={{ __html: aiProposalHtml }} />
        <AiRefinement busy={aiWorking || syncing} onRefine={(instruction) => void requestAi(aiProposal.mode, instruction)} />
        <div className="task-creator-actions">
          <button className="task-primary" type="button" disabled={aiWorking || syncing} onClick={applyAi}>{aiProposal.mode === 'layout' ? 'Appliquer la mise en page' : 'Appliquer la procédure'}</button>
          <button className="ghost" type="button" disabled={aiWorking || syncing} onClick={() => void requestAi(aiProposal.mode)}>{aiBusy ? (aiBusy === 'layout' ? 'Mise en page…' : 'Suggestion…') : 'Rafraîchir'}</button>
          <button className="ghost" type="button" disabled={aiWorking} onClick={() => setAiProposal(null)}>Ignorer</button>
        </div>
      </div>}
      {actionsProposal && canDraftProcedure && <div className="proofread-preview ai-actions-proposal no-print" role="region" aria-label="Actions proposées">
        <strong>Actions proposées — choisis les tâches à créer</strong>
        <small>Chaque tâche sera liée à cette note, dans son projet. La note est conservée.</small>
        {actionsProposal.items.length === 0 ? <p>Aucune nouvelle action à créer dans cette note.</p> : <ul className="ai-action-list">
          {actionsProposal.items.map((action, index) => <li className="ai-action-row" key={index}>
            <label>
              <input
                type="checkbox"
                aria-label={`Créer l’action ${action.title}`}
                checked={action.selected}
                disabled={actionsCreating || action.created}
                onChange={(event) => editAction(index, { selected: event.target.checked })}
              />
              <span>{action.created ? 'Créée et liée' : `Action ${index + 1}`}</span>
            </label>
            <div className="ai-action-fields">
              <label>Titre<input aria-label={`Titre de l’action ${index + 1}`} value={action.title} disabled={actionsCreating || action.created} onChange={(event) => editAction(index, { title: event.target.value })} /></label>
              <label>Échéance facultative<input type="date" aria-label={`Échéance de l’action ${index + 1}`} value={action.due_date || ''} disabled={actionsCreating || action.created} onChange={(event) => editAction(index, { due_date: event.target.value || null })} /></label>
            </div>
            <blockquote className="ai-action-evidence">{action.evidence}</blockquote>
          </li>)}
        </ul>}
        <div className="task-creator-actions">
          {actionsProposal.items.length > 0 && <button className="task-primary" type="button" disabled={aiWorking || !actionsProposal.items.some((action) => action.selected && !action.created && action.title.trim())} onClick={() => void createSelectedActions()}>{actionsCreating ? 'Création…' : 'Créer les tâches sélectionnées'}</button>}
          <button className="ghost" type="button" disabled={aiWorking || syncing} onClick={() => void extractActions()}>Relancer l’extraction</button>
          <button className="ghost" type="button" disabled={actionsCreating || extracting} onClick={() => setActionsProposal(null)}>Fermer les actions</button>
        </div>
        {actionsMessage && <p role="status" className="task-message">{actionsMessage}</p>}
      </div>}
      {procedureDraft && canDraftProcedure && (
        <ProcedureDraft
          draft={procedureDraft}
          projectId={draft.project_id || null}
          busy={drafting}
          onRefresh={(instruction) => void draftFromEntry(instruction)}
          onCreated={(procedure) => {
            if (!mounted.current || (draftRef.current.project_id || null) !== procedure.project_id) return;
            setProcedureDraft(null);
            onProcedureCreated?.(procedure);
          }}
          onClose={() => setProcedureDraft(null)}
        />
      )}
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
      {draft.content_json ? <RichEditor key={richVersion} disabled={syncing} readOnly={hasModes && !writing} googleLinked={Boolean(googleSync)} entryId={entry.id} content={draft.content_json} onChange={(content_json) => update({ content_json })} /> : <div className={'sheet' + (writing ? ' is-split' : '')}>
        {writing && (
          <textarea
            ref={sourceRef}
            className="source no-print"
            aria-label="Contenu en Markdown"
            placeholder={'## Ce que j’ai fait\n\n- …\n\n> Décision : …'}
            value={draft.content_md}
            spellCheck
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
      {(!nativeGoogle || attachments.length > 0) && <div className="files no-print">
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
            <a
              href={api.fileUrl(file.stored)}
              onClick={(event) => {
                event.preventDefault();
                setError('');
                void downloadAttachment(file).catch((e: Error) => setError(e.message));
              }}
            >
              {file.filename}
            </a>
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

function DetailsWrapper({ google, children }: { google: boolean; children: React.ReactNode }) {
  return google ? (
    <details className="document-details no-print">
      <summary>Détails du document</summary>
      {children}
    </details>
  ) : (
    <div className="document-details local-details no-print">{children}</div>
  );
}
