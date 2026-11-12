import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { aiUsageLabel } from '../ai-budget';
import { applyChatProposal, askAssistant, type ChatAnswer, type ChatHistoryItem, type ChatProposal } from '../ai-chat';
import { AiCancelled, readAiSettings } from '../ai-suggest';
import { COLUMNS, type Task } from '../lib';
import { AiPending } from './AiMenu';

export interface ChatProposalItem {
  proposal: ChatProposal;
  status: 'open' | 'applying' | 'applied' | 'ignored' | 'failed';
  error?: string;
  createdTaskId?: string;
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

function conversationName(session: ChatSession): string {
  const text = session.turns[0]?.question.replace(/\s+/g, ' ').trim();
  const short = text && (text.length > 48 ? text.slice(0, 47) + '…' : text);
  const title = short ? `Conversation ${session.id} · ${short}` : `Conversation ${session.id}`;
  return isRunning(session) ? `${title} · Recherche en cours`
    : isApplying(session) ? `${title} · Écriture en cours` : title;
}

const PROPOSAL_WORDS: Record<ChatProposalItem['status'], string> = { open: 'proposée', applying: 'en cours', applied: 'appliquée', ignored: 'ignorée', failed: 'échouée' };

/** Monté avec l'application pour laisser les conversations travailler quand le dialogue est fermé. */
export function AiChat({ open, projectId, categoryId, openTitle, openEntryId, compact, opener, onClose, onChanged, onTask, onDocument, onSharedDocument }: {
  open: boolean;
  projectId: string;
  categoryId?: string | null;
  openTitle?: string;
  openEntryId?: string;
  compact: boolean;
  opener: { current: HTMLElement | null };
  onClose: () => void;
  onChanged: (proposals: ChatProposal[]) => void | Promise<void>;
  onTask: (task: Task) => void;
  onDocument: (id: string) => void;
  onSharedDocument: (path: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastTurnRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const requests = useRef(new Map<number, { controller: AbortController; turnId: number }>());
  const pendingProposals = useRef(new Set<string>());
  const writeQueue = useRef<Promise<void> | null>(null);
  const lastTurnId = useRef(0);
  const lastSessionId = useRef(1);
  const [sessions, setSessions] = useState(() => [newSession(1)]);
  const [activeId, setActiveId] = useState(1);
  const active = sessions.find(({ id }) => id === activeId) ?? sessions[0];
  const { draft, turns } = active;
  const busy = isRunning(active);
  const inProgress = sessions.filter((session) => isRunning(session) || isApplying(session)).length;
  const latestOnChanged = useRef(onChanged);
  latestOnChanged.current = onChanged;
  const updateSession = (id: number, patch: (session: ChatSession) => ChatSession) => {
    setSessions((current) => current.map((session) => session.id === id ? patch(session) : session));
  };
  const onTurns = (id: number, patch: (turns: ChatTurn[]) => ChatTurn[]) => {
    updateSession(id, (session) => ({ ...session, turns: patch(session.turns) }));
  };
  const write = (text: string) => updateSession(active.id, (session) => ({ ...session, draft: text }));
  // Sur téléphone, le champ ferait surgir le clavier par-dessus la réponse.
  const focusField = () => {
    if (!compact) fieldRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    }
    const field = fieldRef.current;
    if (compact) closeRef.current?.focus();
    else if (field) {
      field.focus();
      // Le brouillon gardé se reprend à sa suite, pas devant.
      field.setSelectionRange(field.value.length, field.value.length);
    }
    // Le dialogue retiré ne rend pas le focus de lui-même.
    return () => opener.current?.focus();
  }, [open, opener]);
  useEffect(() => () => {
    const pending = [...requests.current.values()];
    requests.current.clear();
    pending.forEach(({ controller }) => controller.abort());
  }, []);
  // La dernière question en haut du journal, ou le bas s'il reste de la place : une longue réponse se lit depuis son début.
  useEffect(() => {
    const log = logRef.current;
    const last = lastTurnRef.current;
    if (log && last) log.scrollTop += last.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
  }, [open, active.id, turns.length, busy]);

  const send = async () => {
    const text = draft.trim();
    const sessionId = active.id;
    if (!text || requests.current.has(sessionId)) return;
    const id = ++lastTurnId.current;
    const patch = (next: Partial<ChatTurn>) => onTurns(sessionId, (current) => current.map((turn) => (turn.id === id ? { ...turn, ...next } : turn)));
    // Seuls les échanges où le modèle a répondu : ni demande coupée, ni recherche locale.
    // Les actions et ce qui était affiché d'abord : « mets-la en priorité haute », « et la deuxième ? » les désignent. shortcut: le prompt coupe le dernier message à 900 caractères et les autres à 400, donc la fin d'une très longue liste et la réponse qui la suit, à revoir si le modèle en perd le fil.
    const history = turns.flatMap((turn): ChatHistoryItem[] => {
      if (!turn.answer?.usedAi || (turn.answer.usedSharedContent && !active.allowSharedContent)) return [];
      const { proposals, tasks, documents, sharedDocuments, reply, usedSharedContent } = turn.answer;
      const actions = proposals.map(({ status, proposal }) => `[${PROPOSAL_WORDS[status]}] ${proposal.label}`);
      const shown = [...tasks, ...documents, ...(sharedDocuments ?? [])].map(({ title }) => `[affiché] « ${title} »`);
      const createdTasks = proposals.flatMap(({ createdTaskId, proposal }) =>
        createdTaskId ? [{ id: createdTaskId, title: proposal.title }] : []);
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
        ...(active.allowSharedContent && { allowSharedContent: true }),
      });
      if (isCurrent()) patch({ answer: { ...answer, proposals: proposals.map((proposal) => ({ proposal, status: 'open' })) } });
    } catch (cause) {
      if (isCurrent()) patch(cause instanceof AiCancelled ? { stopped: true } : { error: (cause as Error).message || 'La demande à l’assistant a échoué.' });
    } finally {
      if (isCurrent()) requests.current.delete(sessionId);
    }
  };
  const stop = () => {
    const running = requests.current.get(active.id);
    if (!running) return;
    requests.current.delete(active.id);
    running.controller.abort();
    onTurns(active.id, (current) => current.map((turn) => turn.id === running.turnId ? { ...turn, stopped: true } : turn));
    focusField();
  };
  const addConversation = () => {
    const session = newSession(++lastSessionId.current);
    setSessions((current) => [...current, session]);
    setActiveId(session.id);
    focusField();
  };
  const removeConversation = () => {
    const remaining = sessions.filter(({ id }) => id !== active.id);
    const next = remaining.at(-1) ?? newSession(++lastSessionId.current);
    stop();
    setSessions(remaining.length ? remaining : [next]);
    setActiveId(next.id);
    focusField();
  };

  const patchProposal = (turnId: number, index: number, next: Partial<ChatProposalItem>) => onTurns(active.id, (current) => current.map((turn) => (turn.id === turnId && turn.answer
    ? { ...turn, answer: { ...turn.answer, proposals: turn.answer.proposals.map((item, position) => (position === index ? { ...item, ...next } : item)) } }
    : turn)));
  const proposalKey = (turnId: number, index: number) => `${turnId}:${index}`;
  const apply = (turnId: number, targets: { item: ChatProposalItem; index: number }[]) => {
    const queued = targets.filter(({ index }) => !pendingProposals.current.has(proposalKey(turnId, index)));
    if (!queued.length) return;
    // Réserver avant le rendu : aucun autre clic ne peut doubler une écriture qui attend son tour.
    queued.forEach(({ index }) => {
      pendingProposals.current.add(proposalKey(turnId, index));
      patchProposal(turnId, index, { status: 'applying', error: '' });
    });
    focusField();
    const run = async () => {
      for (const { item, index } of queued) {
        if (!item.since) patchProposal(turnId, index, { since: new Date().toISOString() });
        try {
          const result = await applyChatProposal(item.proposal, item.since ? { since: item.since } : undefined);
          patchProposal(turnId, index, { status: 'applied', createdTaskId: result?.taskId });
        } catch (cause) {
          patchProposal(turnId, index, { status: 'failed', error: (cause as Error).message || 'Impossible d’appliquer cette proposition.' });
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
  return createPortal((
    <dialog className="settings-dialog ai-chat-dialog no-print" aria-label="Assistant IA" aria-modal="true" ref={dialogRef} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="settings-dialog-heading">
        <h2>Assistant</h2>
        <div className="task-creator-actions">
          <button className="ghost" type="button" aria-label="Nouvelle conversation" disabled={turns.length === 0 && !draft.trim()} onClick={addConversation}>
            <span className="ai-chat-new-label">Nouvelle conversation</span><span className="ai-chat-new-short">Nouvelle</span>
          </button>
          <button className="ghost" type="button" aria-label="Fermer l’assistant" ref={closeRef} onClick={onClose}>Fermer</button>
        </div>
      </div>
      <div className="ai-chat-sessions">
        <label>
          <span>Conversation</span>
          <select aria-label="Conversation active" value={active.id} onChange={(event) => setActiveId(Number(event.target.value))}>
            {sessions.map((session) => <option key={session.id} value={session.id}>{conversationName(session)}</option>)}
          </select>
        </label>
        <button className="ghost" type="button" aria-label="Effacer la conversation active" disabled={isApplying(active) || (sessions.length === 1 && !turns.length && !draft && !active.allowSharedContent)} onClick={removeConversation}>Effacer</button>
      </div>
      <p className="ai-hint ai-chat-session-status" aria-live="polite">{inProgress > 0 && `${inProgress} conversation${inProgress > 1 ? 's' : ''} en cours`}</p>
      <div className="ai-chat-log" role="log" aria-label="Conversation avec l’assistant" aria-busy={busy} ref={logRef}>
        {turns.length === 0 && <p className="empty">Cherche une tâche, une note ou une procédure. Demande un ajout, un classement ou un changement de statut. Rien n’est écrit sans ton clic.</p>}
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
                {answer.tasks.length + answer.documents.length + (answer.sharedDocuments?.length ?? 0) > 0 && (
                  <ul className="ai-chat-found">
                    {answer.tasks.map((task) => (
                      <li key={task.id}>
                        <button className="ghost" type="button" aria-label={`Ouvrir la tâche ${task.title}`} onClick={() => onTask(task)}>
                          <span>{task.title}</span><small>{COLUMNS.find(({ id }) => id === task.status)?.label}</small>
                        </button>
                      </li>
                    ))}
                    {answer.documents.map((document) => {
                      const kind = document.google_document_id || document.google_tab_id ? 'Document Google' : document.kind === 'procedure' ? 'Procédure' : 'Note';
                      const status = document.status === 'done' ? 'Terminée' : document.status === 'doing' ? 'En cours' : undefined;
                      return (
                        <li key={document.id}>
                          <button className="ghost" type="button" aria-label={`Ouvrir le document ${document.title}`} onClick={() => onDocument(document.id)}>
                            <span>{document.title}</span><small>{status ? `${kind} · ${status}` : kind}</small>
                          </button>
                        </li>
                      );
                    })}
                    {answer.sharedDocuments?.map(({ path, title }) => (
                      <li key={path}>
                        <button className="ghost" type="button" aria-label={`Ouvrir le fichier partagé ${path}`} onClick={() => onSharedDocument(path)}>
                          <span>{title}</span><small>Partage</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {answer.proposals.length > 0 && (
                  <ul className="ai-action-list">
                    {answer.proposals.map((item, index) => {
                      const { proposal } = item;
                      const { label } = proposal;
                      const body = proposal.kind === 'update_entry' ? proposal.changes.content_md
                        : 'content_md' in proposal ? proposal.content_md : undefined;
                      const retry = item.status === 'failed';
                      return (
                        <li className={'ai-action-row' + (item.status === 'ignored' ? ' is-ignored' : '')} key={index}>
                          <p className="ai-chat-proposal">{label}</p>
                          {body !== undefined && <details className="ai-chat-review">
                            <summary>Relire le texte proposé</summary>
                            <pre>{body || 'Texte vide'}</pre>
                          </details>}
                          {item.status === 'applying' && <p className="ai-hint" role="status">En cours…</p>}
                          {item.status === 'applied' && <p className="task-message" role="status">✓ Appliqué</p>}
                          {item.status === 'ignored' && <p className="ai-hint">Ignorée</p>}
                          {retry && <p className="error" role="alert">{item.error}</p>}
                          {(item.status === 'open' || retry) && (
                            <div className="task-creator-actions">
                              <button className={retry ? 'ghost' : 'task-primary'} type="button" aria-label={`${retry ? 'Réessayer' : 'Appliquer'} : ${label}`} onClick={() => void apply(turn.id, [{ item, index }])}>{retry ? 'Réessayer' : 'Appliquer'}</button>
                              <button className="ghost" type="button" aria-label={`Ignorer : ${label}`} onClick={() => {
                                if (!pendingProposals.current.has(proposalKey(turn.id, index))) patchProposal(turn.id, index, { status: 'ignored' });
                                focusField();
                              }}>Ignorer</button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {targets.length >= 2 && <button className="task-primary ai-chat-apply-all" type="button" onClick={() => void apply(turn.id, targets)}>Tout appliquer ({targets.length})</button>}
              </>}
            </div>
          );
        })}
        {busy && <AiPending label="L’assistant cherche dans tes tâches, tes notes et tes procédures…" />}
      </div>
      <form className="ai-chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea
          ref={fieldRef}
          aria-label="Message pour l’assistant"
          placeholder="Ta demande…"
          maxLength={2000}
          enterKeyHint="send"
          value={draft}
          onChange={(event) => write(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
        />
        {busy && <button className="ghost" type="button" aria-label="Arrêter la demande IA" onClick={stop}>Arrêter</button>}
        <button className="task-primary" type="submit" disabled={busy || !draft.trim()}>Envoyer</button>
      </form>
      <footer className="ai-chat-footer">
        <p className="ai-hint">{aiUsageLabel()}</p>
        <details className="overview-ai-scope">
          <summary>Données envoyées au service IA</summary>
          <p>Le service IA reçoit ta demande, les derniers échanges, ton profil, les repères du projet affiché, le nom des projets et catégories, les tâches pertinentes, le titre de la note ouverte et le début des notes utiles. Il peut lire le texte de notes et procédures locales dans une limite de taille. Pour un document Google, il reçoit le titre et la date seuls. Une recherche dans le dossier partagé lui transmet les chemins trouvés.</p>
          <label className="ai-chat-content-setting">
            <input type="checkbox" checked={active.allowSharedContent} onChange={(event) => {
              const checked = event.target.checked;
              updateSession(active.id, (session) => ({ ...session, allowSharedContent: checked }));
            }} />
            Autoriser l’envoi d’extraits des fichiers partagés dans cette conversation
          </label>
          <p>Ce réglage s’applique à l’envoi des prochains messages.</p>
        </details>
      </footer>
    </dialog>
  ), document.body);
}
