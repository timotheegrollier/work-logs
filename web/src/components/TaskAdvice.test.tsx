import { afterEach, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { api, type AppState, type Project, type Task } from '../lib';
import { generateFollowUp } from '../ai-suggest';
import { FollowUpProvider } from '../follow-up-controller';
import { TaskAdvice } from './TaskAdvice';

vi.mock('../ai-suggest', async (original) => ({
  ...await original<typeof import('../ai-suggest')>(),
  generateFollowUp: vi.fn(),
}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const task = (blockers: string[]): Task => ({
  entry_id: '', progress: 0, id: 'tk_a', title: 'Réparer la pompe', status: 'todo', priority: 'normal', due_date: null, pinned: 0,
  position: 0, project_id: null, created_at: '2026-10-01', updated_at: '2026-10-30', documents: [],
  follow_up: { enabled: true, enabled_at: '2026-11-01T00:00:00Z', report: {
    generated_at: '2026-11-05T11:00:00Z', source_key: 'k', status: 'blocked', summary: 'S', completed: [], next_steps: [], warnings: [], blockers,
  } },
});
const advice = (blockers: string[]) => <TaskAdvice tasks={[task(blockers)]} projects={[]} onTask={() => {}} />;

test('annonce l’envoi des blocages et annule une préparation dont les blocages ont changé', async () => {
  const view = render(advice(['Pièce attendue.']));
  expect(screen.getByText(/blocages notés dans leurs bilans de suivi/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Préparer les conseils' }));
  await screen.findByRole('button', { name: 'Demander les conseils à l’IA' });

  view.rerender(advice(['Pièce attendue.']));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();

  view.rerender(advice(['Pièce reçue, joint manquant.']));
  expect(await screen.findByRole('alert')).toHaveTextContent('Les tâches ou leur contexte ont changé');
  expect(screen.queryByRole('button', { name: 'Demander les conseils à l’IA' })).not.toBeInTheDocument();
});

const project = (id: string): Project => ({ id, name: id, color: '#000000', created_at: '2026-10-01', entries: 0, open_tasks: 0 });
const projects = [project('p1'), project('p2')];
const scoped = (id: string, project_id: string, blockers: string[], rest: Partial<Task> = {}): Task => ({ ...task(blockers), id, title: id, project_id, ...rest });
const prepared = () => screen.queryByRole('button', { name: 'Demander les conseils à l’IA' });
const prepareP1 = async (tasks: Task[]) => {
  const view = render(<TaskAdvice tasks={tasks} projects={projects} onTask={() => {}} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Projet à analyser par l’IA' }), { target: { value: 'p1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Préparer les conseils' }));
  await screen.findByRole('button', { name: 'Demander les conseils à l’IA' });
  return (next: Task[]) => view.rerender(<TaskAdvice tasks={next} projects={projects} onTask={() => {}} />);
};

test('le bilan d’une tâche d’un autre projet laisse les conseils de la portée', async () => {
  const change = await prepareP1([scoped('a', 'p1', ['Pièce attendue.']), scoped('b', 'p2', ['Accès refusé.'])]);
  change([scoped('a', 'p1', ['Pièce attendue.']), scoped('b', 'p2', ['Accès rétabli, attente du client.'])]);
  expect(prepared()).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('cocher une tâche de la portée garde les conseils', async () => {
  const change = await prepareP1([scoped('a', 'p1', ['Pièce attendue.']), scoped('c', 'p1', [])]);
  change([scoped('a', 'p1', ['Pièce attendue.'], { status: 'done' }), scoped('c', 'p1', [])]);
  expect(prepared()).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('le bilan changé d’une tâche de la portée efface toujours les conseils', async () => {
  const change = await prepareP1([scoped('a', 'p1', ['Pièce attendue.']), scoped('b', 'p2', [])]);
  change([scoped('a', 'p1', ['Pièce reçue, joint manquant.']), scoped('b', 'p2', [])]);
  expect(await screen.findByRole('alert')).toHaveTextContent('Les tâches ou leur contexte ont changé');
  expect(prepared()).not.toBeInTheDocument();
});

test('des conseils préparés retiennent l’actualisation automatique d’un bilan', async () => {
  vi.useFakeTimers();
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  vi.mocked(generateFollowUp).mockReset().mockImplementation(() => new Promise(() => {}));
  vi.spyOn(api, 'followUp').mockResolvedValue({ follow_up: task([]).follow_up ?? null, source_key: 'k2', source: { kind: 'task', id: 'tk_a', title: 'Réparer la pompe', project: null, documents: [] } });
  const tree = (follow_up_key: string) => {
    const stale = { ...task(['Pièce attendue.']), follow_up_key };
    const state: AppState = { projects: [], entries: [], tasks: [stale], procedure_attachments: [], stats: { entries: 0, entriesThisWeek: 0, tasks: { todo: 1, doing: 0, done: 0 }, overdue: 0 } };
    return <FollowUpProvider state={state} onChanged={() => {}}><TaskAdvice tasks={[stale]} projects={[]} onTask={() => {}} /></FollowUpProvider>;
  };
  // Une modification de la session : seule voie d'une actualisation automatique.
  render(tree('k1')).rerender(tree('k2'));
  fireEvent.click(screen.getByRole('button', { name: 'Préparer les conseils' }));
  await advance(0);
  expect(prepared()).toBeInTheDocument();
  await advance(30 * 60_000);
  expect(generateFollowUp).not.toHaveBeenCalled();
  expect(prepared()).toBeInTheDocument();
});
