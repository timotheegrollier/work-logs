import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { aiUsageLabel } from '../ai-budget';
import { applyChatProposal, askAssistant, MAX_CHAT_MESSAGE, type ChatHistoryItem, type ChatProposal, type ChatQuestion } from '../ai-chat';
import { chatAttachmentBytes, createChatLink, MAX_CHAT_ATTACHMENTS, MAX_CHAT_ATTACHMENT_BYTES, readChatAttachment, type ChatAttachment } from '../ai-chat-attachments';
import { AiCancelled, aiDailyDefault, readAiSettings, truncate } from '../ai-suggest';
import { COLUMNS, type Task } from '../lib';
import { readChatConversations, writeChatConversations, type ChatProposalItem, type ChatSession, type ChatTurn } from '../store/chat-conversations';
import { ColumnResizer } from './ColumnResizer';

const CHAT_PANEL_ID = 'worklogs-assistant-panel';
const CHAT_WIDTH_KEY = 'worklogs-assistant-width';
const CHAT_MIN_WIDTH = 500;
const CHAT_DEFAULT_WIDTH = 1460;
const CHAT_MAX_WIDTH = 2400;
const MAX_ACTIVITY_STEPS = 24;

function readChatWidth() {
  try {
    const width = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    if (Number.isInteger(width) && width >= CHAT_MIN_WIDTH && width <= CHAT_MAX_WIDTH) return width;
  } catch { /* Le stockage peut être désactivé dans le navigateur. */ }
  return CHAT_DEFAULT_WIDTH;
}

const newSession = (id: number): ChatSession => ({
  id, storageId: crypto.randomUUID?.() ?? `chat-${Date.now()}-${Math.random()}`,
  createdAt: Date.now(), draft: '', turns: [], allowSharedContent: false,
});
const hasContent = (session: ChatSession) => Boolean(session.turns.length || session.draft || session.draftAttachments?.length || session.allowSharedContent);
const isRunning = (session: ChatSession) => session.turns.some(({ answer, error, stopped }) => !answer && !error && !stopped);
const isApplying = (session: ChatSession) => session.turns.some(({ answer }) => answer?.proposals.some(({ status }) => status === 'applying'));
const conversationName = (id: number) => `Conversation ${id}`;
const conversationTitle = (session: ChatSession) => session.title
  || truncate(session.turns[0]?.question ?? '', 80)
  || truncate(session.turns[0]?.attachments?.[0]?.name ?? '', 80)
  || conversationName(session.id);
const conversationActivity = (session: ChatSession) => isRunning(session) ? 'Recherche en cours' : isApplying(session) ? 'Écriture en cours' : '';

const PROPOSAL_WORDS: Record<ChatProposalItem['status'], string> = { open: 'proposée', applying: 'en cours', applied: 'appliquée', ignored: 'ignorée', failed: 'échouée' };
/** Départs proposés dans une conversation vide : un clic remplit le champ, rien n'est envoyé. */
const QUICK_PROMPTS = [
  'Quelles tâches sont en retard ?',
  'Qu’est-ce qui est en cours ?',
  'Résume ma semaine de travail',
  'Quelles tâches n’ont pas encore de projet ?',
];
type ProposalTarget = { item: ChatProposalItem; index: number };
interface AttachmentFeedback { reading?: boolean; error?: string }
const attachmentCountError = `Tu peux joindre jusqu’à ${MAX_CHAT_ATTACHMENTS} fichiers ou liens par message.`;
interface ChatNavigation {
  onTask: (task: Task) => void;
  onAppliedTask?: (id: string, title: string) => void;
  onDocument: (id: string) => void;
  onSharedDocument: (path: string) => void;
}

/** Monté avec l'application pour laisser les conversations travailler quand le dialogue est fermé. */
export function AiChat({ open, projectId, categoryId, openTitle, openEntryId, compact, opener, onClose, onChanged, ...navigation }: {
  open: boolean;
  projectId: string;
  categoryId?: string | null;
  openTitle?: string;
  openEntryId?: string;
  compact: boolean;
  opener: { current: HTMLElement | null };
  onClose: () => void;
  onChanged: (proposals: ChatProposal[]) => void | Promise<void>;
} & ChatNavigation) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const focusNewPane = useRef(false);
  const requests = useRef(new Map<number, { controller: AbortController; turnId: number }>());
  const [progress, setProgress] = useState<Record<number, string>>({});
  const attachmentReads = useRef(new Set<number>());
  const [attachmentFeedback, setAttachmentFeedback] = useState<Record<number, AttachmentFeedback>>({});
  const pendingProposals = useRef(new Set<string>());
  const writeQueue = useRef<Promise<void> | null>(null);
  const lastTurnId = useRef(0);
  const lastSessionId = useRef(1);
  const [sessions, renderSessions] = useState(() => [newSession(1)]);
  const currentSessions = useRef(sessions);
  const historyAvailable = useRef(typeof indexedDB !== 'undefined');
  const [historyLoaded, setHistoryLoaded] = useState(!historyAvailable.current);
  const [historyError, setHistoryError] = useState('');
  const [activeId, setActiveId] = useState(1);
  const [showSidebar, setShowSidebar] = useState(false);
  const [width, setWidth] = useState(readChatWidth);
  const active = sessions.find(({ id }) => id === activeId) ?? sessions[0];
  const mobileSidebar = compact && showSidebar;
  const inProgress = sessions.filter(conversationActivity).length;
  const latestOnChanged = useRef(onChanged);
  latestOnChanged.current = onChanged;
  useEffect(() => {
    try {
      if (width === CHAT_DEFAULT_WIDTH) localStorage.removeItem(CHAT_WIDTH_KEY);
      else localStorage.setItem(CHAT_WIDTH_KEY, String(width));
    } catch { /* La largeur reste utilisable. */ }
  }, [width]);
  useEffect(() => {
    if (!historyAvailable.current) return;
    let disposed = false;
    void readChatConversations().then((restored) => {
      if (disposed) return;
      const last = restored.at(-1);
      if (last) {
        lastSessionId.current = last.id;
        lastTurnId.current = restored.reduce((latest, session) =>
          session.turns.reduce((id, turn) => Math.max(id, turn.id), latest), 0);
        currentSessions.current = restored;
        renderSessions(restored);
        setActiveId(last.id);
      }
      setHistoryLoaded(true);
    }, () => {
      if (disposed) return;
      historyAvailable.current = false;
      setHistoryError('Impossible de charger l’historique des conversations sur cet appareil.');
      setHistoryLoaded(true);
    });
    return () => { disposed = true; };
  }, []);
  const setSessions = (update: (current: ChatSession[]) => ChatSession[]) => {
    const before = currentSessions.current;
    const after = update(before);
    currentSessions.current = after;
    renderSessions(after);
    if (!historyAvailable.current) return;
    const previous = new Map(before.map((session) => [session.storageId, session]));
    const retained = new Map(after.filter(hasContent).map((session) => [session.storageId, session]));
    const upsert = [...retained.values()].filter((session) => previous.get(session.storageId) !== session);
    const remove = before.filter((session) => hasContent(session) && !retained.has(session.storageId)).map(({ storageId }) => storageId);
    if (!upsert.length && !remove.length) return;
    return writeChatConversations(upsert, remove).then(() => true, () => {
      setHistoryError('Certaines modifications de l’historique n’ont pas pu être enregistrées.');
      return false;
    });
  };
  const updateSession = (id: number, patch: (session: ChatSession) => ChatSession) =>
    setSessions((current) => current.map((session) => session.id === id ? patch(session) : session));
  const onTurns = (id: number, patch: (turns: ChatTurn[]) => ChatTurn[]) =>
    updateSession(id, (session) => ({ ...session, turns: patch(session.turns) }));
  const pane = (id: number) => columnsRef.current?.querySelector<HTMLElement>(`[data-conversation="${id}"]`);
  useEffect(() => {
    if (!open || !historyLoaded) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    }
    const field = pane(active.id)?.querySelector('textarea');
    if (compact) closeRef.current?.focus();
    else if (field) {
      field.focus();
      // Le brouillon gardé se reprend à sa suite, pas devant.
      field.setSelectionRange(field.value.length, field.value.length);
    }
    // Le dialogue retiré ne rend pas le focus de lui-même.
    return () => opener.current?.focus();
  }, [open, historyLoaded, opener]);
  useEffect(() => {
    if (!open || !historyLoaded) return;
    if (mobileSidebar) {
      focusNewPane.current = false;
      sidebarRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
      return;
    }
    const selected = pane(active.id);
    if (!focusNewPane.current) return;
    focusNewPane.current = false;
    if (compact) sidebarToggleRef.current?.focus();
    else selected?.querySelector('textarea')?.focus();
  }, [open, historyLoaded, active.id, compact, mobileSidebar]);
  useEffect(() => () => {
    const pending = [...requests.current.values()];
    requests.current.clear();
    pending.forEach(({ controller }) => controller.abort());
  }, []);
  const setFeedback = (sessionId: number, feedback: AttachmentFeedback) => {
    setAttachmentFeedback((current) => ({ ...current, [sessionId]: feedback }));
  };
  const appendAttachments = (session: ChatSession, incoming: ChatAttachment[]): string[] => {
    const attachments = [...(session.draftAttachments ?? [])];
    let bytes = attachments.reduce((total, attachment) => total + chatAttachmentBytes(attachment), 0);
    const errors: string[] = [];
    for (const attachment of incoming) {
      const size = chatAttachmentBytes(attachment);
      if (attachments.length >= MAX_CHAT_ATTACHMENTS) {
        errors.push(attachmentCountError);
        break;
      }
      if (bytes + size > MAX_CHAT_ATTACHMENT_BYTES) {
        errors.push(`« ${attachment.name} » dépasse la taille totale de 10 Mio par message.`);
        continue;
      }
      bytes += size;
      attachments.push(attachment);
    }
    if (attachments.length !== (session.draftAttachments?.length ?? 0)) {
      updateSession(session.id, (current) => ({ ...current, draftAttachments: attachments }));
    }
    return errors;
  };
  const attachFiles = async (sessionId: number, files: File[]) => {
    const session = currentSessions.current.find(({ id }) => id === sessionId);
    if (!session || !files.length || attachmentReads.current.has(sessionId)) return;
    const available = MAX_CHAT_ATTACHMENTS - (session.draftAttachments?.length ?? 0);
    if (available <= 0) {
      setFeedback(sessionId, { error: attachmentCountError });
      return;
    }
    attachmentReads.current.add(sessionId);
    setFeedback(sessionId, { reading: true });
    const results = await Promise.allSettled(files.slice(0, available).map((file) => readChatAttachment(file)));
    attachmentReads.current.delete(sessionId);
    const latest = currentSessions.current.find(({ id }) => id === sessionId);
    if (!latest) return;
    const readable: ChatAttachment[] = [];
    const errors = files.length > available ? [attachmentCountError] : [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') readable.push(result.value);
      else errors.push(`« ${files[index].name} » — ${(result.reason as Error).message}`);
    });
    errors.push(...appendAttachments(latest, readable));
    setFeedback(sessionId, { error: errors.join(' ') });
  };
  const attachLink = (sessionId: number, value: string) => {
    const session = currentSessions.current.find(({ id }) => id === sessionId);
    if (!session || attachmentReads.current.has(sessionId)) return false;
    try {
      const errors = appendAttachments(session, [createChatLink(value)]);
      setFeedback(sessionId, { error: errors.join(' ') });
      return errors.length === 0;
    } catch (cause) {
      setFeedback(sessionId, { error: (cause as Error).message });
      return false;
    }
  };
  const clearProgress = (turnId: number) => setProgress((current) => {
    if (!(turnId in current)) return current;
    const next = { ...current };
    delete next[turnId];
    return next;
  });
  const send = async (sessionId: number, choice?: string, retry?: ChatTurn) => {
    const session = currentSessions.current.find(({ id }) => id === sessionId);
    if (!session || requests.current.has(sessionId) || attachmentReads.current.has(sessionId)) return;
    const draft = retry?.question ?? choice ?? session.draft;
    const text = draft.trim() ? draft : '';
    const isDraft = choice === undefined && !retry;
    const attachments = retry?.attachments ?? (isDraft && session.draftAttachments?.length ? session.draftAttachments : undefined);
    if (!text && !attachments) return;
    const id = ++lastTurnId.current;
    const patch = (next: Partial<ChatTurn>) => onTurns(sessionId, (current) => current.map((turn) => (turn.id === id ? { ...turn, ...next } : turn)));
    // Seuls les échanges où le modèle a répondu : ni demande coupée, ni recherche locale.
    // Les actions et ce qui était affiché d'abord : « mets-la en priorité haute », « et la deuxième ? » les désignent.
    const history = session.turns.flatMap((turn): ChatHistoryItem[] => {
      if (!turn.answer?.usedAi || (turn.answer.usedSharedContent && !session.allowSharedContent)) return [];
      const { proposals, tasks, documents, sharedDocuments, reply, usedSharedContent, question, consultedLinks } = turn.answer;
      const actions = proposals.map(({ status, proposal }) => `[${PROPOSAL_WORDS[status]}] ${proposal.label}`);
      const shown = [...tasks, ...documents, ...(sharedDocuments ?? [])].map(({ title }) => `[affiché] « ${title} »`);
      const createdTasks = proposals.flatMap(({ result, proposal }) =>
        proposal.kind === 'create_task' && result?.taskId ? [{ id: result.taskId, title: proposal.title }] : []);
      return [{ role: 'user', text: turn.question, ...(turn.attachments?.length && { attachments: turn.attachments }) }, {
        role: 'assistant', text: [...actions, ...shown, reply].join('\n'), ...(usedSharedContent && { sharedContent: true }),
        ...(createdTasks.length > 0 && { createdTasks }),
        ...(question && { question }),
        ...(consultedLinks && { consultedLinks }),
      }];
    });
    updateSession(sessionId, (current) => ({
      ...current,
      ...(isDraft && { draft: '', draftAttachments: undefined }),
      turns: [...current.turns.filter((turn) => turn.id !== retry?.id), { id, question: text, ...(attachments && { attachments }) }],
    }));
    if (isDraft) setFeedback(sessionId, {});
    const controller = new AbortController();
    requests.current.set(sessionId, { controller, turnId: id });
    const isCurrent = () => requests.current.get(sessionId)?.controller === controller;
    const activity: string[] = [];
    try {
      const { proposals, conversationTitle: title, ...answer } = await askAssistant({ ...readAiSettings(), signal: controller.signal }, {
        text, history, projectId, categoryId, openTitle,
        ...(attachments && { attachments }),
        ...(openEntryId && { openEntryId }),
        ...(!session.title && { needsConversationTitle: true }),
        ...(session.allowSharedContent && { allowSharedContent: true }),
        onProgress: (label) => {
          const step = truncate(label, 180);
          if (!isCurrent() || !step || step === activity.at(-1)) return;
          if (activity.length === MAX_ACTIVITY_STEPS) activity.shift();
          activity.push(step);
          setProgress((current) => ({ ...current, [id]: step }));
        },
      });
      if (isCurrent()) {
        updateSession(sessionId, (current) => ({
          ...current,
          ...(!current.title && title && { title }),
          turns: current.turns.map((turn) => turn.id === id
            ? { ...turn, answer: { ...answer, ...(activity.length && { activity }), proposals: proposals.map((proposal) => ({ proposal, status: 'open' })) } }
            : turn),
        }));
      }
    } catch (cause) {
      if (isCurrent()) patch(cause instanceof AiCancelled ? { stopped: true } : { error: (cause as Error).message || 'La demande à l’assistant a échoué.' });
    } finally {
      if (isCurrent()) {
        requests.current.delete(sessionId);
        clearProgress(id);
      }
    }
  };
  const stop = (sessionId: number) => {
    const running = requests.current.get(sessionId);
    if (!running) return;
    requests.current.delete(sessionId);
    running.controller.abort();
    clearProgress(running.turnId);
    onTurns(sessionId, (current) => current.map((turn) => turn.id === running.turnId ? { ...turn, stopped: true } : turn));
  };
  const selectConversation = (id: number) => {
    if (id === active.id && !mobileSidebar) {
      if (compact) return;
      pane(id)?.querySelector('textarea')?.focus();
      return;
    }
    focusNewPane.current = true;
    setShowSidebar(false);
    setActiveId(id);
  };
  const addConversation = () => {
    const session = newSession(++lastSessionId.current);
    setSessions((current) => [...current, session]);
    selectConversation(session.id);
  };
  const removeConversation = (sessionId: number) => {
    const index = sessions.findIndex(({ id }) => id === sessionId);
    const remaining = sessions.filter(({ id }) => id !== sessionId);
    const next = remaining[Math.min(index, remaining.length - 1)] ?? newSession(++lastSessionId.current);
    stop(sessionId);
    setAttachmentFeedback((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setSessions(() => remaining.length ? remaining : [next]);
    if (active.id === sessionId) selectConversation(next.id);
  };

  const patchProposal = (sessionId: number, turnId: number, index: number, next: Partial<ChatProposalItem>) => onTurns(sessionId, (current) => current.map((turn) => (turn.id === turnId && turn.answer
    ? { ...turn, answer: { ...turn.answer, proposals: turn.answer.proposals.map((item, position) => (position === index ? { ...item, ...next } : item)) } }
    : turn)));
  const proposalKey = (turnId: number, index: number) => `${turnId}:${index}`;
  const apply = (sessionId: number, turnId: number, targets: ProposalTarget[]) => {
    const queued = targets.filter(({ index }) => !pendingProposals.current.has(proposalKey(turnId, index)));
    if (!queued.length) return;
    // Réserver avant le rendu : aucun autre clic ne peut doubler une écriture qui attend son tour.
    queued.forEach(({ index }) => {
      pendingProposals.current.add(proposalKey(turnId, index));
      patchProposal(sessionId, turnId, index, { status: 'applying', error: '' });
    });
    const run = async () => {
      for (const { item, index } of queued) {
        try {
          if (!item.since) {
            // Après un rechargement, une écriture déjà envoyée se reprend avec le même repère.
            const saved = patchProposal(sessionId, turnId, index, { since: new Date().toISOString() });
            if (saved && !await saved) {
              patchProposal(sessionId, turnId, index, { since: undefined });
              throw new Error('Impossible de préparer l’écriture de cette proposition. Réessaie.');
            }
          }
          const result = await applyChatProposal(item.proposal, item.since ? { since: item.since } : undefined);
          patchProposal(sessionId, turnId, index, { status: 'applied', result: result || undefined });
        } catch (cause) {
          patchProposal(sessionId, turnId, index, { status: 'failed', error: (cause as Error).message || 'Impossible d’appliquer cette proposition.' });
        } finally {
          pendingProposals.current.delete(proposalKey(turnId, index));
        }
      }
      // Une réponse perdue peut avoir été écrite : relire même après un échec.
      await latestOnChanged.current(queued.map(({ item }) => item.proposal));
    };
    // Les recherches restent parallèles. Les écritures validées prennent leur tour, toutes conversations confondues.
    const pending = writeQueue.current ? writeQueue.current.then(run, run) : run();
    writeQueue.current = pending;
    const release = () => { if (writeQueue.current === pending) writeQueue.current = null; };
    void pending.then(release, release);
  };

  if (!open || !historyLoaded) return null;
  const close = () => { setShowSidebar(false); onClose(); };
  const maxWidth = Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, window.innerWidth));
  return createPortal((
    <dialog id={CHAT_PANEL_ID} className="settings-dialog ai-chat-dialog no-print" aria-label="Assistant IA" aria-modal="true"
      style={{ '--ai-chat-width': `${width}px` } as CSSProperties} ref={dialogRef} onCancel={(event) => { event.preventDefault(); close(); }}>
      {!compact && <ColumnResizer side="right" area="ai-chat" label="Redimensionner le panneau de l’assistant"
        panelId={CHAT_PANEL_ID} min={CHAT_MIN_WIDTH} max={maxWidth} value={Math.min(width, maxWidth)} onChange={setWidth} />}
      <header className="ai-chat-header">
        <h2>Assistant IA</h2>
        <div className="ai-chat-header-actions">
          {compact && (
            <button className="ghost" type="button" ref={sidebarToggleRef} aria-expanded={mobileSidebar} onClick={() => {
              focusNewPane.current = true;
              setShowSidebar(!mobileSidebar);
            }}>{mobileSidebar ? 'Revenir au chat' : 'Conversations'}</button>
          )}
          <button className="ghost" type="button" aria-label="Fermer l’assistant" ref={closeRef} onClick={close}>Fermer</button>
        </div>
      </header>
      {historyError && <p className="ai-chat-storage-error error" role="alert">{historyError}</p>}

      <div className={'ai-chat-workspace' + (compact ? ' is-compact' : '')}>
        <nav className="ai-chat-sidebar" ref={sidebarRef} aria-label="Conversations" hidden={compact && !mobileSidebar}>
          <button className="ghost ai-chat-new" type="button" aria-label="Nouvelle conversation" onClick={addConversation}>
            <span aria-hidden="true">＋</span> Nouvelle conversation
          </button>
          <ul className="ai-chat-session-list">
            {sessions.map((session) => {
              const activity = conversationActivity(session);
              const title = conversationTitle(session);
              const name = conversationName(session.id);
              return (
                <li key={session.id}>
                  <button className="ghost ai-chat-session-button" type="button"
                    aria-current={session.id === active.id ? true : undefined}
                    aria-label={title === name ? name : `${name} · ${title}`}
                    aria-describedby={activity ? `ai-chat-session-activity-${session.id}` : undefined}
                    aria-controls={session.id === active.id ? `ai-chat-pane-${session.id}` : undefined}
                    title={title}
                    onClick={() => selectConversation(session.id)}
                  >
                    <span className="ai-chat-session-title">{title}</span>
                    {activity && <span className="ai-chat-session-activity" id={`ai-chat-session-activity-${session.id}`}><WorkingIcon />{activity}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="ai-chat-usage ai-hint">{aiUsageLabel(aiDailyDefault(readAiSettings()))}</p>
        </nav>

        <div className="ai-chat-columns" ref={columnsRef} hidden={mobileSidebar}>
          {sessions.map((session) => (
            <ChatPane
              key={session.id}
              session={session}
              hidden={session.id !== active.id}
              onFocus={() => setActiveId(session.id)}
              onSend={(choice) => void send(session.id, choice)}
              onRetry={(turn) => void send(session.id, undefined, turn)}
              progress={progress[session.turns.at(-1)?.id ?? 0]}
              onStop={() => stop(session.id)}
              onDraft={(draft) => updateSession(session.id, (current) => ({ ...current, draft }))}
              attachmentFeedback={attachmentFeedback[session.id]}
              onFiles={(files) => void attachFiles(session.id, files)}
              onLink={(value) => attachLink(session.id, value)}
              onForget={(id) => updateSession(session.id, (current) => ({
                ...current, draftAttachments: current.draftAttachments?.filter((attachment) => attachment.id !== id),
              }))}
              onAllowShared={(allowSharedContent) => updateSession(session.id, (current) => ({ ...current, allowSharedContent }))}
              onApply={(turnId, targets) => apply(session.id, turnId, targets)}
              onIgnore={(turnId, index) => {
                if (!pendingProposals.current.has(proposalKey(turnId, index))) patchProposal(session.id, turnId, index, { status: 'ignored' });
              }}
              onRemove={() => removeConversation(session.id)}
              canRemove={!isApplying(session) && (sessions.length > 1 || hasContent(session))}
              compact={compact}
              navigation={navigation}
            />
          ))}
        </div>
      </div>
      <p className="ai-chat-announcement" aria-live="polite">{inProgress > 0 && `${inProgress} conversation${inProgress > 1 ? 's' : ''} en cours`}</p>
    </dialog>
  ), document.body);
}

function WorkingIcon() {
  return <span className="ai-chat-working-icon" aria-hidden="true" />;
}

function ChatPane({
  session, hidden, onFocus, onSend, onRetry, progress, onStop, onDraft, attachmentFeedback, onFiles, onLink, onForget,
  onAllowShared, onApply, onIgnore, onRemove, canRemove, compact, navigation,
}: {
  session: ChatSession;
  hidden: boolean;
  onFocus: () => void;
  onSend: (choice?: string) => void;
  onRetry: (turn: ChatTurn) => void;
  progress?: string;
  onStop: () => void;
  onDraft: (text: string) => void;
  attachmentFeedback?: AttachmentFeedback;
  onFiles: (files: File[]) => void;
  onLink: (value: string) => boolean;
  onForget: (id: string) => void;
  onAllowShared: (allowed: boolean) => void;
  onApply: (turnId: number, targets: ProposalTarget[]) => void;
  onIgnore: (turnId: number, index: number) => void;
  onRemove: () => void;
  canRemove: boolean;
  compact: boolean;
  navigation: ChatNavigation;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const lastTurnRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const [showLink, setShowLink] = useState(false);
  const [link, setLink] = useState('');
  const { id, turns, draft, draftAttachments, allowSharedContent } = session;
  const linkFieldId = `ai-chat-link-${id}`;
  const busy = isRunning(session);
  const activity = conversationActivity(session);
  const focusField = () => { if (!compact && !hidden) fieldRef.current?.focus(); };
  const reading = Boolean(attachmentFeedback?.reading);
  const canSend = !busy && !reading && Boolean(draft.trim() || draftAttachments?.length);
  const addLink = () => {
    if (!onLink(link)) return;
    setShowLink(false);
    setLink('');
    focusField();
  };
  const submit = () => {
    if (canSend) onSend();
  };
  useEffect(() => {
    if (hidden) return;
    const log = logRef.current;
    const last = lastTurnRef.current;
    if (log && last) log.scrollTop += last.getBoundingClientRect().top - log.getBoundingClientRect().top - 16;
  }, [turns.length, busy, hidden]);

  return (
    <section className="ai-chat-pane" id={`ai-chat-pane-${id}`} data-conversation={id} hidden={hidden} aria-label={conversationName(id)} onFocusCapture={onFocus}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = reading ? 'none' : 'copy';
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        event.preventDefault();
        onFocus();
        onFiles(files);
      }}>
      <header className="ai-chat-pane-header">
        <div className="ai-chat-pane-heading">
          <h3 title={conversationTitle(session)}>{conversationTitle(session)}</h3>
          <span className="ai-chat-pane-activity" aria-live="polite">{activity && <><WorkingIcon />{activity}</>}</span>
        </div>
        <button className="ghost ai-chat-remove" type="button" aria-label="Effacer la conversation" disabled={!canRemove} onClick={onRemove}>Effacer</button>
      </header>
      <div className="ai-chat-log" role="log" aria-label="Conversation avec l’assistant" aria-busy={busy} ref={logRef}>
        <div className="ai-chat-log-content">
          {turns.length === 0 && (
            <div className="ai-chat-empty">
              <p className="ai-chat-empty-title"><span aria-hidden="true">✨</span> Par où commencer ?</p>
              <p>Cherche une tâche, une note ou une procédure. Demande un ajout, un classement ou un changement de statut. Rien n’est écrit sans ton clic.</p>
              <ul className="ai-chat-suggestions" aria-label="Demandes suggérées">
                {QUICK_PROMPTS.map((prompt) => (
                  <li key={prompt}>
                    <button className="ghost" type="button" onClick={() => { onDraft(prompt); fieldRef.current?.focus(); }}>{prompt}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {turns.map((turn) => {
            const { answer } = turn;
            const targets = (answer?.proposals ?? []).map((item, index) => ({ item, index })).filter(({ item }) => item.status === 'open' || item.status === 'failed');
            return (
              <div className="ai-chat-turn" key={turn.id} ref={turn === turns.at(-1) ? lastTurnRef : undefined}>
                {turn.question && <p className="ai-chat-bubble is-user">{turn.question}</p>}
                {turn.attachments?.length ? <ChatAttachments attachments={turn.attachments} unreadIds={answer?.unreadAttachmentIds} /> : null}
                {turn.stopped && <p className="ai-hint">Demande arrêtée.</p>}
                {turn.error && (
                  <div className="ai-chat-error">
                    <p className="error" role="alert">{turn.error}</p>
                    {turn === turns.at(-1) && !busy && (
                      <button className="ghost" type="button" disabled={reading} onClick={() => onRetry(turn)}>Réessayer la demande</button>
                    )}
                  </div>
                )}
                {answer && <>
                  {Boolean(answer.activity?.length) && (
                    <details className="ai-chat-activity">
                      <summary>Étapes de l’assistant</summary>
                      <ol>{answer.activity?.map((step, index) => <li key={index}>{step}</li>)}</ol>
                    </details>
                  )}
                  {answer.reply && answer.reply !== answer.question?.text && <p className="ai-chat-bubble">{answer.reply}</p>}
                  {answer.question && <ChatQuestionCard question={answer.question}
                    onReply={turn === turns.at(-1) && !busy && !reading ? (choice) => {
                      focusField();
                      onSend(choice);
                    } : undefined}
                    onFreeReply={() => fieldRef.current?.focus()}
                  />}
                  {answer.notice && <p className="notice">{answer.notice}</p>}
                  <ChatResults answer={answer} navigation={navigation} />
                  {answer.proposals.length > 0 && (
                    <ul className="ai-action-list ai-chat-proposals">
                      {answer.proposals.map((item, index) => (
                        <ChatProposalRow key={index} item={item} navigation={navigation}
                          onApply={() => { focusField(); onApply(turn.id, [{ item, index }]); }}
                          onIgnore={() => { focusField(); onIgnore(turn.id, index); }}
                        />
                      ))}
                    </ul>
                  )}
                  {targets.length >= 2 && <button className="task-primary ai-chat-apply-all" type="button" onClick={() => { focusField(); onApply(turn.id, targets); }}>Tout appliquer ({targets.length})</button>}
                </>}
              </div>
            );
          })}
        </div>
      </div>
      {busy && <div className="ai-chat-working" role="status"><WorkingIcon /><span>{progress ?? 'L’assistant cherche et prépare sa réponse…'}</span></div>}
      <footer className="ai-chat-footer">
        <form className="ai-chat-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <textarea
            ref={fieldRef}
            aria-label="Message pour l’assistant"
            placeholder={turns.at(-1)?.answer?.question ? 'Ta réponse…' : 'Ta demande…'}
            maxLength={MAX_CHAT_MESSAGE}
            enterKeyHint="send"
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (!files.length || reading) return;
              if (!event.clipboardData.getData('text/plain')) event.preventDefault();
              onFiles(files);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
          />
          {draftAttachments?.length ? <ChatAttachments attachments={draftAttachments} onForget={onForget} /> : null}
          {showLink && <div className="ai-chat-link" id={linkFieldId}>
            <input aria-label="Adresse du lien" inputMode="url" placeholder="https://…" value={link} autoFocus
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (link.trim() && !reading) addLink();
              }}
            />
            <button className="ghost" type="button" disabled={!link.trim() || reading} onClick={addLink}>Ajouter le lien</button>
          </div>}
          {reading && <p className="ai-hint ai-chat-attachment-feedback" role="status">Préparation des fichiers…</p>}
          {attachmentFeedback?.error && <p className="error ai-chat-attachment-feedback" role="alert">{attachmentFeedback.error}</p>}
          <div className="ai-chat-composer-actions">
            <input type="file" hidden multiple ref={filesRef} aria-label="Fichiers à joindre"
              onChange={(event) => {
                onFiles(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <button className="ghost" type="button" aria-label="Joindre des fichiers" disabled={reading}
              title="Joindre des fichiers Word, Excel, PDF, images, texte ou code" onClick={() => filesRef.current?.click()}>Fichiers</button>
            <button className="ghost" type="button" aria-label="Joindre un lien" aria-expanded={showLink}
              aria-controls={showLink ? linkFieldId : undefined} onClick={() => setShowLink(!showLink)}>Lien</button>
            <button className="task-primary" type="submit" disabled={!canSend}>Envoyer</button>
            {busy && <button className="ghost" type="button" aria-label="Arrêter la demande IA" onClick={() => { onStop(); focusField(); }}>Arrêter</button>}
          </div>
        </form>
        <details className="overview-ai-scope ai-chat-data">
          <summary>Données envoyées au service IA</summary>
          <p>Le service IA reçoit ta demande, les derniers échanges, ton profil, les repères du projet affiché, le nom des projets et catégories, les tâches pertinentes, le titre de la note ouverte et le début des notes utiles. Il peut lire le texte de notes et procédures locales dans une limite de taille. Pour un document Google, il reçoit le titre et la date seuls. Une recherche dans le dossier partagé lui transmet les chemins trouvés.</p>
          <p>Les pièces jointes sont utilisées à l’envoi et peuvent resservir dans cette conversation. WorkLogs extrait le texte des fichiers Word, Excel et texte. Avec le service gratuit, le Worker WorkLogs hébergé chez Cloudflare convertit les PDF en texte. Le modèle reçoit seulement l’extrait du PDF. Les images peuvent être envoyées telles quelles. Pour une pièce marquée « Non lu », le modèle ne reçoit que son nom et son type. Les liens GitHub peuvent être lus avec la connexion GitHub locale. Seul l’extrait lu est transmis au service IA.</p>
          <label className="ai-chat-content-setting">
            <input type="checkbox" checked={allowSharedContent} onChange={(event) => onAllowShared(event.target.checked)} />
            Autoriser l’envoi d’extraits des fichiers partagés dans cette conversation
          </label>
          <p>Ce réglage s’applique à l’envoi des prochains messages. L’historique et les brouillons sont enregistrés sur cet appareil.</p>
        </details>
      </footer>
    </section>
  );
}

function ChatAttachments({ attachments, unreadIds, onForget }: { attachments: ChatAttachment[]; unreadIds?: string[]; onForget?: (id: string) => void }) {
  return <ul className={`ai-chat-attachments${onForget ? '' : ' is-sent'}`} aria-label={onForget ? 'Pièces jointes du brouillon' : 'Pièces jointes envoyées'}>
    {attachments.map((attachment) => <li key={attachment.id} title={attachment.name}>
      <span>{attachment.name}</span>
      {(attachment.kind === 'file' || unreadIds?.includes(attachment.id)) && <small title="Le fichier reste dans la conversation ; l’assistant ne peut pas lire son contenu.">Non lu</small>}
      {'truncated' in attachment && attachment.truncated && <small>Extrait</small>}
      {onForget && <button type="button" className="ghost" aria-label={`Retirer ${attachment.name}`} onClick={() => onForget(attachment.id)}>×</button>}
    </li>)}
  </ul>;
}

function ChatQuestionCard({ question, onReply, onFreeReply }: { question: ChatQuestion; onReply?: (options: string) => void; onFreeReply: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  if (!onReply) {
    if (!question.options.length) return <p className="ai-chat-bubble ai-chat-question">{question.text}</p>;
    return <div className="ai-chat-bubble ai-chat-question">
      <p>{question.text}</p>
      <ul>{question.options.map((option) => <li key={option}>{option}</li>)}</ul>
    </div>;
  }
  return <fieldset className="ai-chat-question ai-chat-poll">
    <legend>{question.text}</legend>
    <div className="ai-chat-poll-options">
      {question.options.map((option) => question.multiple
        ? <label key={option}>
          <input type="checkbox" checked={selected.includes(option)} onChange={(event) => {
            setSelected(event.target.checked ? [...selected, option] : selected.filter((value) => value !== option));
          }} />
          {option}
        </label>
        : <button className="ghost" type="button" key={option} onClick={() => onReply(option)}>{option}</button>)}
    </div>
    {question.multiple && <button className="task-primary" type="button" disabled={!selected.length}
      onClick={() => onReply(question.options.filter((option) => selected.includes(option)).join('\n'))}>Répondre avec ces choix</button>}
    <button className="ghost" type="button" onClick={onFreeReply}>Répondre librement</button>
  </fieldset>;
}

function ChatResults({ answer, navigation }: { answer: NonNullable<ChatTurn['answer']>; navigation: ChatNavigation }) {
  if (!answer.tasks.length && !answer.documents.length && !answer.sharedDocuments?.length) return null;
  return (
    <ul className="ai-chat-found">
      {answer.tasks.map((task) => (
        <li key={task.id}>
          <button className="ghost" type="button" aria-label={`Ouvrir la tâche ${task.title}`} onClick={() => navigation.onTask(task)}>
            <span>{task.title}</span><small>{COLUMNS.find(({ id }) => id === task.status)?.label}</small>
          </button>
        </li>
      ))}
      {answer.documents.map((document) => {
        const kind = document.google_document_id || document.google_tab_id ? 'Document Google' : document.kind === 'procedure' ? 'Procédure' : 'Note';
        const status = document.status === 'done' ? 'Terminée' : document.status === 'doing' ? 'En cours' : undefined;
        return (
          <li key={document.id}>
            <button className="ghost" type="button" aria-label={`Ouvrir le document ${document.title}`} onClick={() => navigation.onDocument(document.id)}>
              <span>{document.title}</span><small>{status ? `${kind} · ${status}` : kind}</small>
            </button>
          </li>
        );
      })}
      {answer.sharedDocuments?.map(({ path, title }) => (
        <li key={path}>
          <button className="ghost" type="button" aria-label={`Ouvrir le fichier partagé ${path}`} onClick={() => navigation.onSharedDocument(path)}>
            <span>{title}</span><small>Partage</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ChatProposalRow({ item, navigation, onApply, onIgnore }: {
  item: ChatProposalItem;
  navigation: ChatNavigation;
  onApply: () => void;
  onIgnore: () => void;
}) {
  const { proposal, result } = item;
  const { label } = proposal;
  const body = proposal.kind === 'update_entry' ? proposal.preview ?? proposal.changes.content_md : 'content_md' in proposal ? proposal.content_md : undefined;
  const taskTitle = proposal.kind === 'update_task' ? proposal.changes.title ?? proposal.title
    : proposal.kind === 'create_task_note' ? proposal.taskTitle : proposal.title;
  const retry = item.status === 'failed';
  const taskId = result?.taskId;
  const entryId = result?.entryId;
  const sharedPath = result?.sharedPath;
  return (
    <li className={'ai-action-row' + (item.status === 'ignored' ? ' is-ignored' : '')}>
      <p className="ai-chat-proposal">{label}</p>
      {proposal.kind === 'update_entry' && proposal.warning && <p className="ai-hint ai-chat-warning">{proposal.warning}</p>}
      {body !== undefined && <details className="ai-chat-review">
        <summary>Relire le texte proposé</summary>
        <pre>{body || 'Texte vide'}</pre>
      </details>}
      {item.status === 'applying' && <p className="ai-hint" role="status">En cours…</p>}
      {item.status === 'applied' && <>
        <p className="task-message" role="status">✓ Appliqué</p>
        {(taskId || entryId || sharedPath) && <div className="ai-chat-open-results">
          {taskId && navigation.onAppliedTask && <button className="ghost" type="button" onClick={() => navigation.onAppliedTask?.(taskId, taskTitle)}>Ouvrir la tâche</button>}
          {entryId && <button className="ghost" type="button" onClick={() => navigation.onDocument(entryId)}>{proposal.kind === 'create_procedure' || proposal.kind === 'update_entry' ? 'Ouvrir le document' : 'Ouvrir la note'}</button>}
          {sharedPath && <button className="ghost" type="button" onClick={() => navigation.onSharedDocument(sharedPath)}>Ouvrir le fichier partagé</button>}
        </div>}
      </>}
      {item.status === 'ignored' && <p className="ai-hint">Ignorée</p>}
      {retry && <p className="error" role="alert">{item.error}</p>}
      {(item.status === 'open' || retry) && (
        <div className="task-creator-actions">
          <button className={retry ? 'ghost' : 'task-primary'} type="button" aria-label={`${retry ? 'Réessayer' : 'Appliquer'} : ${label}`} onClick={onApply}>{retry ? 'Réessayer' : 'Appliquer'}</button>
          <button className="ghost" type="button" aria-label={`Ignorer : ${label}`} onClick={onIgnore}>Ignorer</button>
        </div>
      )}
    </li>
  );
}
