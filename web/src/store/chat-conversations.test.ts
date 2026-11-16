import { expect, test, vi } from 'vitest';
import type { ChatProposal } from '../ai-chat';
import { readChatConversations, writeChatConversations, type ChatSession } from './chat-conversations';

const { all, writeAll } = vi.hoisted(() => ({ all: vi.fn(), writeAll: vi.fn() }));
vi.mock('./storage', () => ({ createIndexedDbDatabase: () => ({ table: () => ({ all }), writeAll }) }));

const saved = (storageId: string, createdAt: number, fields: Partial<Omit<ChatSession, 'id'>> = {}) =>
  ({ storageId, createdAt, draft: '', turns: [], allowSharedContent: false, ...fields });

test('relit les conversations dans l’ordre de création avec des numéros de colonne distincts', async () => {
  const first = saved('alpha', 1, { title: 'Maintenance de la pompe', draft: 'Le joint', allowSharedContent: true });
  const second = saved('beta', 1);
  const third = saved('gamma', 2);
  all.mockResolvedValueOnce([third, second, first]);
  expect(await readChatConversations()).toEqual([{ ...first, id: 1 }, { ...second, id: 2 }, { ...third, id: 3 }]);
});

test('relit les échanges et permet de reprendre une écriture interrompue', async () => {
  const proposal: ChatProposal = { kind: 'create_task', title: 'Contrôler le filtre', project_id: null, priority: 'normal', status: 'todo', due_date: null, label: 'Créer la tâche' };
  const since = '2026-11-16T11:00:00Z';
  const response = {
    reply: 'Voici les résultats.', notice: '', tasks: [], documents: [], usedAi: true, usedSharedContent: true,
    proposals: [
      { proposal, status: 'applying' as const, since },
      { proposal, status: 'applying' as const },
      { proposal, status: 'applied' as const, since, result: { taskId: 'tk_1', entryId: 'en_1' } },
    ],
  };
  const turns = [
    { id: 1, question: 'Quelles sont les tâches ?', answer: response },
    { id: 2, question: 'Quel filtre ?' },
    { id: 3, question: 'Suite', error: 'Lecture indisponible.' },
  ];
  all.mockResolvedValueOnce([saved('alpha', 1, { turns })]);
  const [session] = await readChatConversations();
  expect(session.turns).toEqual([
    { ...turns[0], answer: { ...response, proposals: [
      { proposal, status: 'failed', since, error: expect.stringContaining('interrompu') },
      { proposal, status: 'open' },
      response.proposals[2],
    ] } },
    { ...turns[1], stopped: true },
    turns[2],
  ]);
});

test('ajout et effacement ciblent les identifiants persistants dans une seule transaction', async () => {
  const value = saved('alpha', 1, { title: 'Atelier' });
  writeAll.mockResolvedValueOnce(undefined);
  await writeChatConversations([{ ...value, id: 19 }], ['beta']);
  expect(writeAll).toHaveBeenCalledExactlyOnceWith([
    { table: 'conversations', value },
    { table: 'conversations', key: 'beta', operation: 'delete' },
  ]);
});
