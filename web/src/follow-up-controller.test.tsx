import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FollowUpProvider, useFollowUp } from './follow-up-controller';
import { discardPendingSaves } from './autosave';
import { resetAiFallbackMemory } from './ai-suggest';
import { api, type AppState, type FollowUp, type FollowUpSnapshot } from './lib';

const at = '2026-11-10T10:00:00.000Z';
const report = {
  status: 'doing' as const,
  summary: 'Bilan déjà là.',
  completed: [],
  next_steps: [],
  blockers: [],
  warnings: [],
  generated_at: at,
  source_key: 'old',
};
const followUp: FollowUp = { enabled: true, enabled_at: at, report };
const source = {
  kind: 'entry' as const,
  id: 'en_1',
  title: 'Note suivie',
  project: null,
  documents: [{
    id: 'en_1', title: 'Note suivie', content_md: 'Pompe remontée.', content_json: null,
    kind: 'note' as const, entry_date: '2026-11-10', google: false,
  }],
};
const snapshot = (sourceKey: string): FollowUpSnapshot => ({ follow_up: followUp, source_key: sourceKey, source });
const state = (sourceKey: string) => ({
  projects: [],
  entries: [{ id: 'en_1', title: 'Note suivie', follow_up: followUp, follow_up_key: sourceKey }],
  tasks: [],
  procedure_attachments: [],
  stats: { entries: 1, entriesThisWeek: 1, tasks: { todo: 0, doing: 0, done: 0 }, overdue: 0 },
} as unknown as AppState);

function Item() {
  const value = useFollowUp('entry', { id: 'en_1', title: 'Note suivie', follow_up: followUp, follow_up_key: 'new' });
  return <span>{value.busy ? 'actualisation' : 'repos'}</span>;
}

function Harness({ value }: { value: AppState }) {
  return <FollowUpProvider state={value} onChanged={() => {}}><Item /></FollowUpProvider>;
}

let currentKey = 'new';
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('worklogs-ai-key', 'cle-test');
  localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
  localStorage.setItem('worklogs-ai-model', 'test');
  discardPendingSaves();
  resetAiFallbackMemory();
  currentKey = 'new';
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ status: 'doing', summary: 'Bilan actualisé.', completed: [], next_steps: [], blockers: [] }) }, finish_reason: 'stop' }] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(api, 'followUp').mockImplementation(async () => snapshot(currentKey));
  vi.spyOn(api, 'saveFollowUp').mockImplementation(async () => snapshot(currentKey));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  discardPendingSaves();
  resetAiFallbackMemory();
});

test('un bilan déjà périmé au chargement ne part pas tout seul ; une modification de la session le fait', async () => {
  const view = render(<Harness value={state('new')} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
  expect(fetchMock).not.toHaveBeenCalled();

  currentKey = 'newer';
  view.rerender(<Harness value={state('newer')} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('deux actualisations automatiques du même élément restent espacées d’une minute', async () => {
  const view = render(<Harness value={state('new')} />);
  currentKey = 'newer';
  view.rerender(<Harness value={state('newer')} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  currentKey = 'newest';
  view.rerender(<Harness value={state('newest')} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
