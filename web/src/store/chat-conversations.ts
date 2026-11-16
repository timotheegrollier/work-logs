import type { ChatAnswer, ChatAppliedResult, ChatProposal } from '../ai-chat';
import { createIndexedDbDatabase } from './storage';

export interface ChatProposalItem {
  proposal: ChatProposal;
  status: 'open' | 'applying' | 'applied' | 'ignored' | 'failed';
  error?: string;
  result?: ChatAppliedResult;
  /** Horodatage du premier essai : un réessai ne recrée pas ce qui a abouti sans réponse. */
  since?: string;
}

export interface ChatTurn {
  id: number;
  question: string;
  answer?: Omit<ChatAnswer, 'proposals' | 'conversationTitle'> & { proposals: ChatProposalItem[] };
  error?: string;
  stopped?: boolean;
}

export interface ChatSession {
  id: number;
  storageId: string;
  createdAt: number;
  title?: string;
  draft: string;
  turns: ChatTurn[];
  allowSharedContent: boolean;
}

type SavedSession = Omit<ChatSession, 'id'>;
const table = 'conversations';
// Le profil WorkLogs conserve le chat indépendamment du journal et de ses sauvegardes.
const database = createIndexedDbDatabase({ name: 'worklogs-assistant', version: 1, stores: { [table]: 'storageId' } });

function restoreTurn(turn: ChatTurn): ChatTurn {
  if (!turn.answer) return turn.error || turn.stopped ? turn : { ...turn, stopped: true };
  const proposals = turn.answer.proposals.map((item): ChatProposalItem => {
    if (item.status !== 'applying') return item;
    if (!item.since) return { ...item, status: 'open' };
    return { ...item, status: 'failed', error: 'L’enregistrement a été interrompu. Réessaie pour vérifier la proposition.' };
  });
  return { ...turn, answer: { ...turn.answer, proposals } };
}

export async function readChatConversations(): Promise<ChatSession[]> {
  const saved = await database.table<SavedSession>(table).all();
  return saved
    .sort((left, right) => left.createdAt - right.createdAt || left.storageId.localeCompare(right.storageId))
    .map((session, index) => ({ ...session, id: index + 1, turns: session.turns.map(restoreTurn) }));
}

export function writeChatConversations(upsert: readonly ChatSession[], remove: readonly string[]): Promise<void> {
  return database.writeAll([
    ...upsert.map(({ id: _id, ...value }) => ({ table, value })),
    ...remove.map((key) => ({ table, key, operation: 'delete' as const })),
  ]);
}
