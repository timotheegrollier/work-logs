import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { aiUsageLabel } from '../ai-budget';
import { applyChatProposal, askAssistant, type ChatAnswer, type ChatAppliedResult, type ChatHistoryItem, type ChatProposal } from '../ai-chat';
import { AiCancelled, readAiSettings } from '../ai-suggest';
import { COLUMNS, type Task } from '../lib';

interface ChatProposalItem {
  proposal: ChatProposal;
  status: 'open' | 'applying' | 'applied' | 'ignored' | 'failed';
  error?: string;
  result?: ChatAppliedResult;
  /** Horodatage du premier essai : un réessai ne recrée pas ce qui a abouti sans réponse. */
  since?: string;
}
interface ChatTurn {
  id: number;
  question: string;
  answer?: Omit<ChatAnswer, 'proposals'> & { proposals: ChatProposalItem[] };
  error?: string;
  stopped?: boolean;
}

interface ChatSession {
  id: number;
  draft: string;
  turns: ChatTurn[];
  allowSharedContent: boolean;
}

const newSession = (id: number): ChatSession => ({ id, draft: '', turns: [], allowSharedContent: false });
const isRunning = (session: ChatSession) => session.turns.some(({ answer, error, stopped }) => !answer && !error && !stopped);
const isApplying = (session: ChatSession) => session.turns.some(({ answer }) => answer?.proposals.some(({ status }) => status === 'applying'));
const conversationName = (id: number) => `Conversation ${id}`;
const conversationTitle = (session: ChatSession) => session.turns[0]?.question.replace(/\s+/g, ' ').trim() || conversationName(session.id);
const conversationActivity = (session: ChatSession) => isRunning(session) ? 'Recherche en cours' : isApplying(session) ? 'Écriture en cours' : '';

const PROPOSAL_WORDS: Record<ChatProposalItem['status'], string> = { open: 'proposée', applying: 'en cours', applied: 'appliquée', ignored: 'ignorée', failed: 'échouée' };
type ProposalTarget = { item: ChatProposalItem; index: number };
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
  const pendingProposals = useRef(new Set<string>());
  const writeQueue = useRef<Promise<void> | null>(null);
  const lastTurnId = useRef(0);
  const lastSessionId = useRef(1);
  const [sessions, setSessions] = useState(() => [newSession(1)]);
  const [activeId, setActiveId] = useState(1);
  const [showSidebar, setShowSidebar] = useState(false);
  const active = sessions.find(({ id }) => id === activeId) ?? sessions[0];
  const mobileSidebar = compact && showSidebar;
  const inProgress = sessions.filter(conversationActivity).length;
  const latestOnChanged = useRef(onChanged);
  latestOnChanged.current = onChanged;
  const updateSession = (id: number, patch: (session: ChatSession) => ChatSession) => {
    setSessions((current) => current.map((session) => session.id === id ? patch(session) : session));
  };
  const onTurns = (id: number, patch: (turns: ChatTurn[]) => ChatTurn[]) => {
    updateSession(id, (session) => ({ ...session, turns: patch(session.turns) }));
  };
  const pane = (id: number) => columnsRef.current?.querySelector<HTMLElement>(`[data-conversation="${id}"]`);
  useEffect(() => {
    if (!open) return;
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
  }, [open, opener]);
  useEffect(() => {
    if (!open) return;
    if (mobileSidebar) {
      focusNewPane.current = false;
      sidebarRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
      return;
    }
    const selected = pane(active.id);
    if (!compact) selected?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (!focusNewPane.current) return;
    focusNewPane.current = false;
    if (compact) sidebarToggleRef.current?.focus();
    else selected?.querySelector('textarea')?.focus();
  }, [open, active.id, compact, mobileSidebar]);
  useEffect(() => () => {
    const pending = [...requests.current.values()];
    requests.current.clear();
    pending.forEach(({ controller }) => controller.abort());
  }, []);
  const send = async (session: ChatSession) => {
    const text = session.draft.trim();
    const sessionId = session.id;
    if (!text || requests.current.has(sessionId)) return;
    const id = ++lastTurnId.current;
    const patch = (next: Partial<ChatTurn>) => onTurns(sessionId, (current) => current.map((turn) => (turn.id === id ? { ...turn, ...next } : turn)));
    // Seuls les échanges où le modèle a répondu : ni demande coupée, ni recherche locale.
    // Les actions et ce qui était affiché d'abord : « mets-la en priorité haute », « et la deuxième ? » les désignent. shortcut: le prompt coupe le dernier message à 900 caractères et les autres à 400, donc la fin d'une très longue liste et la réponse qui la suit, à revoir si le modèle en perd le fil.
    const history = session.turns.flatMap((turn): ChatHistoryItem[] => {
      if (!turn.answer?.usedAi || (turn.answer.usedSharedContent && !session.allowSharedContent)) return [];
      const { proposals, tasks, documents, sharedDocuments, reply, usedSharedContent } = turn.answer;
      const actions = proposals.map(({ status, proposal }) => `[${PROPOSAL_WORDS[status]}] ${proposal.label}`);
      const shown = [...tasks, ...documents, ...(sharedDocuments ?? [])].map(({ title }) => `[affiché] « ${title} »`);
      const createdTasks = proposals.flatMap(({ result, proposal }) =>
        proposal.kind === 'create_task' && result?.taskId ? [{ id: result.taskId, title: proposal.title }] : []);
      return [{ role: 'user', text: turn.question }, {
        role: 'assistant', text: [...actions, ...shown, reply].join('\n'), ...(usedSharedContent && { sharedContent: true }),
        ...(createdTasks.length > 0 && { createdTasks }),
      }];
    });
    updateSession(sessionId, (session) => ({ ...session, draft: '', turns: [...session.turns, { id, question: text }] }));
    const controller = new AbortController();
    requests.current.set(sessionId, { controller, turnId: id });
    const isCurrent = () => requests.current.get(sessionId)?.controller === controller;
    try {
      const { proposals, ...answer } = await askAssistant({ ...readAiSettings(), signal: controller.signal }, {
        text, history, projectId, categoryId, openTitle,
        ...(openEntryId && { openEntryId }),
        ...(session.allowSharedContent && { allowSharedContent: true }),
      });
      if (isCurrent()) patch({ answer: { ...answer, proposals: proposals.map((proposal) => ({ proposal, status: 'open' })) } });
    } catch (cause) {
      if (isCurrent()) patch(cause instanceof AiCancelled ? { stopped: true } : { error: (cause as Error).message || 'La demande à l’assistant a échoué.' });
    } finally {
      if (isCurrent()) requests.current.delete(sessionId);
    }
  };
  const stop = (sessionId: number) => {
    const running = requests.current.get(sessionId);
    if (!running) return;
    requests.current.delete(sessionId);
    running.controller.abort();
    onTurns(sessionId, (current) => current.map((turn) => turn.id === running.turnId ? { ...turn, stopped: true } : turn));
  };
  const selectConversation = (id: number) => {
    if (id === active.id && !mobileSidebar) {
      if (compact) return;
      pane(id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
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
    setSessions(remaining.length ? remaining : [next]);
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
        if (!item.since) patchProposal(sessionId, turnId, index, { since: new Date().toISOString() });
        try {
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

  if (!open) return null;
  const close = () => { setShowSidebar(false); onClose(); };
  return createPortal((
    <dialog className="settings-dialog ai-chat-dialog no-print" aria-label="Assistant IA" aria-modal="true" ref={dialogRef} onCancel={(event) => { event.preventDefault(); close(); }}>
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
                    aria-controls={!compact || session.id === active.id ? `ai-chat-pane-${session.id}` : undefined}
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
          <p className="ai-chat-usage ai-hint">{aiUsageLabel()}</p>
        </nav>

        <div className="ai-chat-columns" ref={columnsRef} hidden={mobileSidebar}>
          {(compact ? [active] : sessions).map((session) => (
            <ChatPane
              key={session.id}
              session={session}
              onFocus={() => setActiveId(session.id)}
              onSend={() => void send(session)}
              onStop={() => stop(session.id)}
              onDraft={(draft) => updateSession(session.id, (current) => ({ ...current, draft }))}
              onAllowShared={(allowSharedContent) => updateSession(session.id, (current) => ({ ...current, allowSharedContent }))}
              onApply={(turnId, targets) => apply(session.id, turnId, targets)}
              onIgnore={(turnId, index) => {
                if (!pendingProposals.current.has(proposalKey(turnId, index))) patchProposal(session.id, turnId, index, { status: 'ignored' });
              }}
              onRemove={() => removeConversation(session.id)}
              canRemove={!isApplying(session) && (sessions.length > 1 || Boolean(session.turns.length || session.draft || session.allowSharedContent))}
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

function ChatPane({ session, onFocus, onSend, onStop, onDraft, onAllowShared, onApply, onIgnore, onRemove, canRemove, compact, navigation }: {
  session: ChatSession;
  onFocus: () => void;
  onSend: () => void;
  onStop: () => void;
  onDraft: (text: string) => void;
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
  const { id, turns, draft, allowSharedContent } = session;
  const busy = isRunning(session);
  const activity = conversationActivity(session);
  const focusField = () => { if (!compact) fieldRef.current?.focus(); };
  useEffect(() => {
    const log = logRef.current;
    const last = lastTurnRef.current;
    if (log && last) log.scrollTop += last.getBoundingClientRect().top - log.getBoundingClientRect().top - 16;
  }, [turns.length, busy]);

  return (
    <section className="ai-chat-pane" id={`ai-chat-pane-${id}`} data-conversation={id} aria-label={conversationName(id)} onFocusCapture={onFocus}>
      <header className="ai-chat-pane-header">
        <div className="ai-chat-pane-heading">
          <h3 title={conversationTitle(session)}>{conversationTitle(session)}</h3>
          <span className="ai-chat-pane-activity" aria-live="polite">{activity && <><WorkingIcon />{activity}</>}</span>
        </div>
        <button className="ghost ai-chat-remove" type="button" aria-label="Effacer la conversation" disabled={!canRemove} onClick={onRemove}>Effacer</button>
      </header>
      <div className="ai-chat-log" role="log" aria-label="Conversation avec l’assistant" aria-busy={busy} ref={logRef}>
        <div className="ai-chat-log-content">
          {turns.length === 0 && <p className="ai-chat-empty">Cherche une tâche, une note ou une procédure. Demande un ajout, un classement ou un changement de statut. Rien n’est écrit sans ton clic.</p>}
          {turns.map((turn) => {
            const { answer } = turn;
            const targets = (answer?.proposals ?? []).map((item, index) => ({ item, index })).filter(({ item }) => item.status === 'open' || item.status === 'failed');
            return (
              <div className="ai-chat-turn" key={turn.id} ref={turn === turns.at(-1) ? lastTurnRef : undefined}>
                <p className="ai-chat-bubble is-user">{turn.question}</p>
                {turn.stopped && <p className="ai-hint">Demande arrêtée.</p>}
                {turn.error && <p className="error" role="alert">{turn.error}</p>}
                {answer && <>
                  <p className="ai-chat-bubble">{answer.reply}</p>
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
          {busy && <div className="ai-chat-working" role="status"><WorkingIcon />L’assistant cherche dans tes tâches, tes notes et tes procédures…</div>}
        </div>
      </div>
      <footer className="ai-chat-footer">
        <form className="ai-chat-composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
          <textarea
            ref={fieldRef}
            aria-label="Message pour l’assistant"
            placeholder="Ta demande…"
            maxLength={2000}
            enterKeyHint="send"
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              onSend();
            }}
          />
          {busy && <button className="ghost" type="button" aria-label="Arrêter la demande IA" onClick={() => { onStop(); focusField(); }}>Arrêter</button>}
          <button className="task-primary" type="submit" disabled={busy || !draft.trim()}>Envoyer</button>
        </form>
        <details className="overview-ai-scope ai-chat-data">
          <summary>Données envoyées au service IA</summary>
          <p>Le service IA reçoit ta demande, les derniers échanges, ton profil, les repères du projet affiché, le nom des projets et catégories, les tâches pertinentes, le titre de la note ouverte et le début des notes utiles. Il peut lire le texte de notes et procédures locales dans une limite de taille. Pour un document Google, il reçoit le titre et la date seuls. Une recherche dans le dossier partagé lui transmet les chemins trouvés.</p>
          <label className="ai-chat-content-setting">
            <input type="checkbox" checked={allowSharedContent} onChange={(event) => onAllowShared(event.target.checked)} />
            Autoriser l’envoi d’extraits des fichiers partagés dans cette conversation
          </label>
          <p>Ce réglage s’applique à l’envoi des prochains messages.</p>
        </details>
      </footer>
    </section>
  );
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
  const body = proposal.kind === 'update_entry' ? proposal.changes.content_md : 'content_md' in proposal ? proposal.content_md : undefined;
  const taskTitle = proposal.kind === 'update_task' ? proposal.changes.title ?? proposal.title
    : proposal.kind === 'create_task_note' ? proposal.taskTitle : proposal.title;
  const retry = item.status === 'failed';
  const taskId = result?.taskId;
  const entryId = result?.entryId;
  const sharedPath = result?.sharedPath;
  return (
    <li className={'ai-action-row' + (item.status === 'ignored' ? ' is-ignored' : '')}>
      <p className="ai-chat-proposal">{label}</p>
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
