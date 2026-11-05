import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, todayISO, type AppState, type FollowUp, type Task } from '../lib';
import * as lib from '../lib';
import { generateDailyReview, replanTasks } from '../ai-suggest';
import { OverviewAiActions } from './OverviewAiActions';

vi.mock('../ai-suggest', async (original) => ({
  ...await original<typeof import('../ai-suggest')>(),
  MAX_DAILY_FOLLOW_UPS: 60, MAX_REPLANNED_TASKS: 60,
  generateDailyReview: vi.fn(), replanTasks: vi.fn(),
}));

const today = todayISO();
const task = (id: string, rest: Partial<Task> = {}): Task => ({ id, title: `Tâche ${id}`, status: 'todo', priority: 'normal', pinned: 0, due_date: null, position: 0, project_id: null, created_at: `${today}T09:00:00Z`, updated_at: `${today}T09:00:00Z`, documents: [], ...rest });
const follow: FollowUp = { enabled: true, enabled_at: `${today}T09:00:00Z`, report: { status: 'doing', summary: 'Contrôle commencé.', completed: ['Mesures relevées.'], next_steps: ['Vérifier la vanne.'], blockers: [], warnings: [], generated_at: `${today}T10:00:00Z`, source_key: 'version1' } };
const state = (tasks: Task[]): AppState => ({ projects: [], entries: [], tasks, procedure_attachments: [], stats: { entries: 0, entriesThisWeek: 0, tasks: { todo: tasks.filter((item) => item.status === 'todo').length, doing: tasks.filter((item) => item.status === 'doing').length, done: tasks.filter((item) => item.status === 'done').length }, overdue: 0 } });
const review = { summary: 'Les mesures sont prêtes ; la vanne reste à vérifier.', completed: ['Mesures relevées.'], next_steps: ['Vérifier la vanne.'], blockers: [], warnings: ['Le bilan ne date pas les avancées.'] };
const props = (tasks: Task[]) => ({ tasks, entries: [], projects: [], onChanged: vi.fn(), onTask: vi.fn(), onShowFollowUps: vi.fn() });

beforeEach(() => { localStorage.clear(); vi.mocked(generateDailyReview).mockReset(); vi.mocked(replanTasks).mockReset(); });
afterEach(() => vi.restoreAllMocks());

test('le bilan est directement accessible et lit la totalité des tâches non terminées', async () => {
  const user = userEvent.setup();
  vi.mocked(generateDailyReview).mockResolvedValue(review);
  const inputs = props([task('a', { follow_up: follow, follow_up_key: 'version1' }), task('b')]);
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: /Bilan du jour/ }));
  await screen.findByRole('region', { name: 'Bilan IA du jour' });
  expect(vi.mocked(generateDailyReview).mock.calls[0][1]).toHaveLength(2);
  expect(vi.mocked(generateDailyReview).mock.calls[0][1][0]).toMatchObject({ id: 'a', kind: 'task', follow_up: follow });
  expect(vi.mocked(generateDailyReview).mock.calls[0][1][1]).toMatchObject({ id: 'b', kind: 'task', status: 'todo' });
  expect(screen.getByText(review.summary)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Voir les suivis (1)' }));
  expect(inputs.onShowFollowUps).toHaveBeenCalledOnce();
});

test('sans tâche ouverte et sans suivi, le raccourci du bilan reste désactivé', () => {
  render(<OverviewAiActions {...props([task('finie', { status: 'done' })])} />);
  expect(screen.getByRole('button', { name: /Bilan du jour/ })).toBeDisabled();
  expect(screen.getByText(/Ajoute une tâche ou une entrée aux suivis IA/)).toBeVisible();
});

test('la replanification exclut les terminées, laisse corriger et décocher avant toute écriture', async () => {
  const user = userEvent.setup();
  const tasks = [task('a'), task('b'), task('finie', { status: 'done' })];
  vi.mocked(replanTasks).mockResolvedValue([{ id: 'a', priority: 'high', due_date: today, reason: 'Débloque le contrôle.' }, { id: 'b', priority: 'low', due_date: today, reason: 'Peut attendre.' }]);
  vi.spyOn(api, 'state').mockResolvedValue(state(tasks));
  const write = vi.spyOn(api, 'updateTask').mockImplementation(async (id, patch) => ({ ...tasks.find((item) => item.id === id)!, ...patch }));
  const inputs = props(tasks);
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await screen.findByRole('region', { name: 'Dates et priorités proposées par l’IA' });
  expect(vi.mocked(replanTasks).mock.calls[0][1].map((item) => item.id)).toEqual(['a', 'b']);
  expect(write).not.toHaveBeenCalled();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Priorité proposée pour Tâche a' }), 'low');
  fireEvent.change(screen.getByLabelText('Date proposée pour Tâche a'), { target: { value: '2099-11-09' } });
  await user.click(screen.getByRole('checkbox', { name: 'Replanifier Tâche b' }));
  await user.click(screen.getByRole('button', { name: 'Appliquer 1 tâche' }));
  await waitFor(() => expect(inputs.onChanged).toHaveBeenCalledOnce());
  expect(write).toHaveBeenCalledExactlyOnceWith('a', { priority: 'low', due_date: '2099-11-09', expected_planning: { title: 'Tâche a', status: 'todo', priority: 'normal', due_date: null, project_id: null, pinned: 0, follow_up_key: null } });
  expect(screen.getByText('1 tâche replanifiée.')).toBeVisible();
});

test('une tâche changée à distance bloque toutes les écritures à l’application', async () => {
  const user = userEvent.setup();
  const tasks = [task('a')];
  vi.mocked(replanTasks).mockResolvedValue([{ id: 'a', priority: 'high', due_date: today, reason: '' }]);
  vi.spyOn(api, 'state').mockResolvedValue(state([task('a', { status: 'done' })]));
  const write = vi.spyOn(api, 'updateTask');
  render(<OverviewAiActions {...props(tasks)} />);
  await user.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await screen.findByRole('region', { name: 'Dates et priorités proposées par l’IA' });
  await user.click(screen.getByRole('button', { name: 'Appliquer 1 tâche' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('Les tâches ou les suivis ont changé');
  expect(write).not.toHaveBeenCalled();
});

test('un profil IA modifié sans rerender invalide la proposition avant toute écriture', async () => {
  const user = userEvent.setup();
  const tasks = [task('a')];
  vi.mocked(replanTasks).mockResolvedValue([{ id: 'a', priority: 'high', due_date: today, reason: '' }]);
  vi.spyOn(api, 'state').mockResolvedValue(state(tasks));
  const write = vi.spyOn(api, 'updateTask');
  render(<OverviewAiActions {...props(tasks)} />);
  await user.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await screen.findByRole('region', { name: 'Dates et priorités proposées par l’IA' });
  localStorage.setItem('worklogs-ai-profile', 'Nouvelle contrainte métier');
  await user.click(screen.getByRole('button', { name: 'Appliquer 1 tâche' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('Les tâches ou les suivis ont changé');
  expect(write).not.toHaveBeenCalled();
});

test('la réussite partielle est conservée et la reprise écrit seulement les tâches restantes', async () => {
  const user = userEvent.setup();
  let tasks = [task('a'), task('b')];
  vi.mocked(replanTasks).mockResolvedValue([{ id: 'a', priority: 'high', due_date: today, reason: '' }, { id: 'b', priority: 'low', due_date: today, reason: '' }]);
  vi.spyOn(api, 'state').mockImplementation(async () => state(tasks));
  let refuse = true;
  const write = vi.spyOn(api, 'updateTask').mockImplementation(async (id, patch) => {
    if (id === 'b' && refuse) throw new Error('Écriture refusée.');
    const updated = { ...tasks.find((item) => item.id === id)!, ...patch };
    tasks = tasks.map((item) => item.id === id ? updated : item);
    return updated;
  });
  const inputs = props(tasks);
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await screen.findByRole('region', { name: 'Dates et priorités proposées par l’IA' });
  await user.click(screen.getByRole('button', { name: 'Appliquer 2 tâches' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('1 tâche enregistrée. Écriture refusée.');
  expect(screen.getByRole('checkbox', { name: 'Replanifier Tâche a' })).toBeDisabled();
  refuse = false;
  await user.click(screen.getByRole('button', { name: 'Appliquer 1 tâche' }));
  await waitFor(() => expect(inputs.onChanged).toHaveBeenCalledTimes(2));
  expect(write.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'b']);
});

test('après application, le spinner se retire et la proposition se referme', async () => {
  const user = userEvent.setup();
  let tasks = [task('a')];
  vi.mocked(replanTasks).mockResolvedValue([{ id: 'a', priority: 'high', due_date: today, reason: 'Débloque le contrôle.' }]);
  vi.spyOn(api, 'state').mockImplementation(async () => state(tasks));
  const write = vi.spyOn(api, 'updateTask').mockImplementation(async (id, patch) => {
    const updated = { ...tasks.find((item) => item.id === id)!, ...patch };
    tasks = tasks.map((item) => item.id === id ? updated : item);
    return updated;
  });
  const inputs = props(tasks);
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await screen.findByRole('region', { name: 'Dates et priorités proposées par l’IA' });
  await user.click(screen.getByRole('button', { name: 'Appliquer 1 tâche' }));
  await waitFor(() => expect(inputs.onChanged).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText('1 tâche replanifiée.')).toBeVisible(), { timeout: 3000 });
  expect(write).toHaveBeenCalledOnce();
  // La proposition refermée : plus rien à appliquer, le spinner de « Enregistrement » parti.
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Dates et priorités proposées par l’IA' })).not.toBeInTheDocument());
});

test('Arrêter coupe la demande et ignore une réponse qui arrive ensuite', async () => {
  const user = userEvent.setup();
  let resolve!: (value: typeof review) => void;
  vi.mocked(generateDailyReview).mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<OverviewAiActions {...props([task('a', { follow_up: follow })])} />);
  await user.click(screen.getByRole('button', { name: /Bilan du jour/ }));
  await waitFor(() => expect(generateDailyReview).toHaveBeenCalledOnce());
  const signal = vi.mocked(generateDailyReview).mock.calls[0][0].signal;
  await user.click(screen.getByRole('button', { name: 'Arrêter' }));
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolve(review); });
  expect(screen.queryByRole('region', { name: 'Bilan IA du jour' })).not.toBeInTheDocument();
});

test('un suivi modifié pendant une demande invalide le résultat en vol', async () => {
  const user = userEvent.setup();
  let resolve!: (value: typeof review) => void;
  vi.mocked(generateDailyReview).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const inputs = props([task('a', { follow_up: follow, follow_up_key: 'version1' })]);
  const view = render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: /Bilan du jour/ }));
  await waitFor(() => expect(generateDailyReview).toHaveBeenCalledOnce());
  view.rerender(<OverviewAiActions {...inputs} tasks={[task('a', { follow_up: follow, follow_up_key: 'version2' })]} />);
  await act(async () => { resolve(review); });
  expect(screen.getByRole('alert')).toHaveTextContent('La journée ou les suivis ont changé');
  expect(screen.queryByRole('region', { name: 'Bilan IA du jour' })).not.toBeInTheDocument();
});

test('un changement de jour invalide le bilan au lieu de lui attribuer la nouvelle date', async () => {
  const user = userEvent.setup();
  vi.mocked(generateDailyReview).mockResolvedValue(review);
  const inputs = props([task('a', { follow_up: follow })]);
  const view = render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Bilan du jour' }));
  await screen.findByRole('region', { name: 'Bilan IA du jour' });
  vi.spyOn(lib, 'todayISO').mockReturnValue('2099-11-05');
  view.rerender(<OverviewAiActions {...inputs} />);
  expect(screen.queryByRole('region', { name: 'Bilan IA du jour' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Relance le bilan du jour');
});

test('un chargement limité annonce que d’autres suivis peuvent manquer au bilan', () => {
  render(<OverviewAiActions {...props([task('a', { follow_up: follow })])} missingEntries={4} missingTasks={2} />);
  expect(screen.getByText(/Le bilan couvre uniquement 1 source chargée/)).toHaveTextContent('Éléments non chargés : 4 entrées et 2 tâches. D’autres sources peuvent manquer.');
});
