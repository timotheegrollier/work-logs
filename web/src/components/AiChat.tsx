import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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
  /** Horodatage du premier essai : un réessai ne recrée pas ce qui a abouti sans réponse. */
  since?: string;
}
export interface ChatTurn {
  id: number;
  question: string;
  answer?: Omit<ChatAnswer, 'proposals'> & { proposals: ChatProposalItem[] };
  error?: string;
  stopped?: boolean;
}

let lastTurnId = 0;

const PROPOSAL_WORDS: Record<ChatProposalItem['status'], string> = { open: 'proposée', applying: 'en cours', applied: 'appliquée', ignored: 'ignorée', failed: 'échouée' };

/** Un dialogue, pas un onglet : la conversation vit dans `App`, rien ne part dans `localStorage`. */
export function AiChat({ turns, onTurns, draftStore, projectId, categoryId, openTitle, compact, opener, onClose, onChanged, onTask, onDocument }: {
  turns: ChatTurn[];
  onTurns: Dispatch<SetStateAction<ChatTurn[]>>;
  /** Le texte en cours de frappe survit au dialogue sans redessiner `App` à chaque touche. */
  draftStore: { current: string };
  projectId: string;
  categoryId?: string | null;
  openTitle?: string;
  compact: boolean;
  opener: { current: HTMLElement | null };
  onClose: () => void;
  /** `createdTask` : une tâche vient d'être créée, qu'une vue rapide cacherait. */
  onChanged: (createdTask: boolean) => void | Promise<void>;
  onTask: (task: Task) => void;
  onDocument: (id: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastTurnRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState(draftStore.current);
  const [busy, setBusy] = useState(false);
  const write = (text: string) => {
    draftStore.current = text;
    setDraft(text);
  };
  // Sur téléphone, le champ ferait surgir le clavier par-dessus la réponse.
  const focusField = () => {
    if (!compact) fieldRef.current?.focus();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    const field = fieldRef.current;
    // Sans le champ, showModal choisirait « Nouvelle conversation », qu'une Entrée de plus viderait sans confirmation.
    if (compact) closeRef.current?.focus();
    else if (field) {
      field.focus();
      // Le brouillon gardé se reprend à sa suite, pas devant.
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }, []);
  // Le dialogue retiré ne rend pas le focus de lui-même, et le bouton reste inerte tant qu'il est là.
  useEffect(() => () => {
    request.current?.abort();
    opener.current?.focus();
  }, []);
  // La dernière question en haut du journal, ou le bas s'il reste de la place : une longue réponse se lit depuis son début.
  useEffect(() => {
    const log = logRef.current;
    const last = lastTurnRef.current;
    if (log && last) log.scrollTop += last.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
  }, [turns.length, busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const id = ++lastTurnId;
    const patch = (next: Partial<ChatTurn>) => onTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...next } : turn)));
    // Seuls les échanges où le modèle a répondu : ni demande coupée, ni recherche locale.
    // Les actions et ce qui était affiché d'abord : « mets-la en priorité haute », « et la deuxième ? » les désignent. shortcut: le prompt coupe le dernier message à 900 caractères et les autres à 400, donc la fin d'une très longue liste et la réponse qui la suit, à revoir si le modèle en perd le fil.
    const history = turns.flatMap((turn): ChatHistoryItem[] => (turn.answer?.usedAi ? [{ role: 'user', text: turn.question }, { role: 'assistant', text: [...turn.answer.proposals.map(({ status, proposal }) => `[${PROPOSAL_WORDS[status]}] ${proposal.label}`), ...[...turn.answer.tasks, ...turn.answer.documents].map(({ title }) => `[affiché] « ${title} »`), turn.answer.reply].join('\n') }] : []));
    onTurns((current) => [...current, { id, question: text }]);
    write('');
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const { proposals, ...answer } = await askAssistant({ ...readAiSettings(), signal: controller.signal }, { text, history, projectId, categoryId, openTitle });
      patch({ answer: { ...answer, proposals: proposals.map((proposal) => ({ proposal, status: 'open' })) } });
    } catch (cause) {
      patch(cause instanceof AiCancelled ? { stopped: true } : { error: (cause as Error).message || 'La demande à l’assistant a échoué.' });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  const stop = () => {
    request.current?.abort();
    focusField();
  };
  const reset = () => {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    onTurns([]);
    focusField();
  };

  const patchProposal = (turnId: number, index: number, next: Partial<ChatProposalItem>) => onTurns((current) => current.map((turn) => (turn.id === turnId && turn.answer
    ? { ...turn, answer: { ...turn.answer, proposals: turn.answer.proposals.map((item, position) => (position === index ? { ...item, ...next } : item)) } }
    : turn)));
  const apply = async (turnId: number, targets: { item: ChatProposalItem; index: number }[]) => {
    const started = new Date().toISOString();
    // Toute la file d'un coup : un autre clic ne peut plus doubler une écriture qui attend son tour.
    targets.forEach(({ item, index }) => patchProposal(turnId, index, { status: 'applying', error: '', since: item.since ?? started }));
    focusField();
    try {
      for (const { item, index } of targets) {
        try {
          await applyChatProposal(item.proposal, item.since ? { since: item.since } : undefined);
          patchProposal(turnId, index, { status: 'applied' });
        } catch (cause) {
          patchProposal(turnId, index, { status: 'failed', error: (cause as Error).message || 'Impossible d’appliquer cette proposition.' });
        }
      }
    } finally {
      // Une réponse perdue peut avoir été écrite : relire même après un échec.
      await onChanged(targets.some(({ item }) => item.proposal.kind === 'create_task'));
    }
  };

  return createPortal((
    <dialog className="settings-dialog ai-chat-dialog no-print" aria-label="Assistant IA" aria-modal="true" ref={dialogRef} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="settings-dialog-heading">
        <h2>Assistant</h2>
        <div className="task-creator-actions">
          <button className="ghost" type="button" aria-label="Nouvelle conversation" disabled={turns.length === 0 || turns.some((turn) => turn.answer?.proposals.some((item) => item.status === 'applying'))} onClick={reset}>
            <span className="ai-chat-new-label">Nouvelle conversation</span><span className="ai-chat-new-short">Nouvelle</span>
          </button>
          <button className="ghost" type="button" aria-label="Fermer l’assistant" ref={closeRef} onClick={onClose}>Fermer</button>
        </div>
      </div>
      <div className="ai-chat-log" role="log" aria-label="Conversation avec l’assistant" ref={logRef}>
        {turns.length === 0 && <p className="empty">Pose une question sur tes tâches et tes notes, ou demande une tâche, une échéance, une note : rien n’est écrit sans ton clic.</p>}
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
                {answer.tasks.length + answer.documents.length > 0 && (
                  <ul className="ai-chat-found">
                    {answer.tasks.map((task) => (
                      <li key={task.id}>
                        <button className="ghost" type="button" aria-label={`Ouvrir la tâche ${task.title}`} onClick={() => onTask(task)}>
                          <span>{task.title}</span><small>{COLUMNS.find(({ id }) => id === task.status)?.label}</small>
                        </button>
                      </li>
                    ))}
                    {answer.documents.map((document) => (
                      <li key={document.id}>
                        <button className="ghost" type="button" aria-label={`Ouvrir le document ${document.title}`} onClick={() => onDocument(document.id)}>
                          <span>{document.title}</span><small>{document.google_document_id || document.google_tab_id ? 'Document Google' : document.kind === 'procedure' ? 'Procédure' : 'Note'}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {answer.proposals.length > 0 && (
                  <ul className="ai-action-list">
                    {answer.proposals.map((item, index) => {
                      const { label } = item.proposal;
                      const retry = item.status === 'failed';
                      return (
                        <li className={'ai-action-row' + (item.status === 'ignored' ? ' is-ignored' : '')} key={index}>
                          <p className="ai-chat-proposal">{label}</p>
                          {item.status === 'applying' && <p className="ai-hint" role="status">En cours…</p>}
                          {item.status === 'applied' && <p className="task-message" role="status">✓ Appliqué</p>}
                          {item.status === 'ignored' && <p className="ai-hint">Ignorée</p>}
                          {retry && <p className="error" role="alert">{item.error}</p>}
                          {(item.status === 'open' || retry) && (
                            <div className="task-creator-actions">
                              <button className={retry ? 'ghost' : 'task-primary'} type="button" aria-label={`${retry ? 'Réessayer' : 'Appliquer'} : ${label}`} onClick={() => void apply(turn.id, [{ item, index }])}>{retry ? 'Réessayer' : 'Appliquer'}</button>
                              <button className="ghost" type="button" aria-label={`Ignorer : ${label}`} onClick={() => { patchProposal(turn.id, index, { status: 'ignored' }); focusField(); }}>Ignorer</button>
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
        {busy && <AiPending label="L’assistant cherche dans tes tâches et tes notes…" />}
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
          <p>Le service IA reçoit ta demande, les derniers échanges, ton profil, les repères du projet affiché, le titre de la note ouverte, le nom des projets, les champs des tâches les plus proches de ta demande, et le titre, la date et le début des notes trouvées (le titre et la date seuls pour un document Google). Aucune pièce jointe.</p>
        </details>
      </footer>
    </dialog>
  ), document.body);
}
