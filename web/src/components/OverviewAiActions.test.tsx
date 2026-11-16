import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, todayISO, type AppState, type EntrySummary, type FollowUp, type Task } from '../lib';
import * as lib from '../lib';
import { generateDailyReview, generateFollowUp, localToday, replanTasks } from '../ai-suggest';
import { recordAiUsage, saveDailyLimit } from '../ai-budget';
import { FollowUpProvider } from '../follow-up-controller';
import { OverviewAiActions } from './OverviewAiActions';

vi.mock('../ai-suggest', async (original) => ({
  ...await original<typeof import('../ai-suggest')>(),
  MAX_DAILY_FOLLOW_UPS: 60, MAX_REPLANNED_TASKS: 60,
  generateDailyReview: vi.fn(), replanTasks: vi.fn(), generateFollowUp: vi.fn(),
}));

const today = todayISO();
const task = (id: string, rest: Partial<Task> = {}): Task => ({ entry_id: '', progress: 0, id, title: `Tâche ${id}`, status: 'todo', priority: 'normal', pinned: 0, due_date: null, position: 0, project_id: null, created_at: `${today}T09:00:00Z`, updated_at: `${today}T09:00:00Z`, documents: [], ...rest });
const follow: FollowUp = { enabled: true, enabled_at: `${today}T09:00:00Z`, report: { status: 'doing', summary: 'Contrôle commencé.', completed: ['Mesures relevées.'], next_steps: ['Vérifier la vanne.'], blockers: [], warnings: [], generated_at: `${today}T10:00:00Z`, source_key: 'version1' } };
const state = (tasks: Task[]): AppState => ({ projects: [], entries: [], tasks, procedure_attachments: [], stats: { entries: 0, entriesThisWeek: 0, tasks: { todo: tasks.filter((item) => item.status === 'todo').length, doing: tasks.filter((item) => item.status === 'doing').length, done: tasks.filter((item) => item.status === 'done').length }, overdue: 0 } });
const review = { summary: 'Les mesures sont prêtes ; la vanne reste à vérifier.', completed: ['Mesures relevées.'], next_steps: ['Vérifier la vanne.'], blockers: [], warnings: ['Le bilan ne date pas les avancées.'] };
const props = (tasks: Task[]) => ({ tasks, entries: [] as EntrySummary[], projects: [], onChanged: vi.fn(), onTask: vi.fn() });
const note = (id: string, title: string, rest: Partial<EntrySummary> = {}): EntrySummary => ({ id, title, entry_date: localToday(), project_id: null, archived: 0, kind: 'note', updated_at: `${today}T09:00:00Z`, excerpt: '', attachments: 0, ...rest });
const localTime = (dayOffset: number, hours: number, minutes: number) => { const date = new Date(); date.setDate(date.getDate() + dayOffset); date.setHours(hours, minutes, 0, 0); return date.toISOString(); };

const mockDailyState = ({ tasks, entries }: ReturnType<typeof props>) => {
  let saved = tasks;
  const read = vi.spyOn(api, 'state').mockImplementation(async () => {
    const snapshot = state(saved);
    return { ...snapshot, entries, stats: { ...snapshot.stats, entries: entries.length } };
  });
  const write = vi.spyOn(api, 'updateTask').mockImplementation(async (id, patch) => {
    const updated = { ...saved.find((task) => task.id === id)!, priority: patch.priority!, due_date: patch.due_date! };
    saved = saved.map((task) => task.id === id ? updated : task);
    return updated;
  });
  return { read, write };
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(generateDailyReview).mockReset();
  vi.mocked(replanTasks).mockReset().mockImplementation(async (_settings, tasks, options) => tasks.map((task) => ({
    id: task.id, priority: task.priority ?? 'normal', due_date: task.due_date ?? options?.today ?? today, reason: 'Date estimée.',
  })));
  vi.mocked(generateFollowUp).mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('le bilan applique les dates et priorités des tâches ouvertes avant la synthèse', async () => {
  const user = userEvent.setup();
  const dueDate = '2099-11-06';
  vi.mocked(replanTasks).mockResolvedValue([
    { id: 'a', priority: 'high', due_date: dueDate, reason: 'À traiter en premier.' },
    { id: 'b', priority: 'low', due_date: dueDate, reason: 'Peut attendre.' },
  ]);
  vi.mocked(generateDailyReview).mockResolvedValue(review);
  const inputs = props([task('a', { follow_up: follow, follow_up_key: 'version1' }), task('b', { status: 'doing' }), task('finie', { status: 'done' })]);
  const { write } = mockDailyState(inputs);
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: /Bilan du jour/ }));
  await screen.findByRole('region', { name: 'Bilan IA du jour' });
  expect(vi.mocked(replanTasks).mock.calls[0][1].map((item) => item.id)).toEqual(['a', 'b']);
  expect(write.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  expect(inputs.onChanged).toHaveBeenCalledOnce();
  expect(write.mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(generateDailyReview).mock.invocationCallOrder[0]);
  expect(vi.mocked(generateDailyReview).mock.calls[0][1]).toEqual([
    expect.objectContaining({ id: 'a', kind: 'task', follow_up: follow, priority: 'high', due_date: dueDate }),
    expect.objectContaining({ id: 'b', kind: 'task', status: 'doing', priority: 'low', due_date: dueDate }),
  ]);
  expect(screen.getByText(review.summary)).toBeVisible();
});

test('le bilan reçoit la vraie planification et l’activité du jour local, sans que ces champs invalident le bilan demandé', async () => {
  const user = userEvent.setup();
  vi.mocked(generateDailyReview).mockResolvedValue(review);
  const followedTask = task('a', { status: 'doing', priority: 'high', due_date: '2099-01-02', follow_up: follow, follow_up_key: 'version1' });
  const inputs = { ...props([
    followedTask,
    task('b', { priority: 'low', due_date: '2099-01-03' }),
    task('matin', { status: 'done', updated_at: localTime(0, 0, 10) }),
    task('veille', { status: 'done', updated_at: localTime(-1, 23, 50) }),
  ]), entries: [note('n1', 'Note du jour'), note('n2', 'Note ancienne', { entry_date: '2020-01-01' }), note('p1', 'Procédure du jour', { kind: 'procedure' })] };
  const { write } = mockDailyState(inputs);
  const view = render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: /Bilan du jour/ }));
  await screen.findByRole('region', { name: 'Bilan IA du jour' });
  expect(write).not.toHaveBeenCalled();
  const [, items, options] = vi.mocked(generateDailyReview).mock.calls[0];
  expect(items.map((item) => [item.id, item.status, item.priority, item.due_date])).toEqual([
    ['a', 'doing', 'high', '2099-01-02'],
    ['b', 'todo', 'low', '2099-01-03'],
  ]);
  expect(options?.todayActivity).toEqual({ doneTasks: ['Tâche matin'], notes: ['Note du jour'] });
  // La clé de fraîcheur garde la forme suivie : replanifier une tâche suivie n'efface pas le bilan.
  view.rerender(<OverviewAiActions {...inputs} tasks={[{ ...followedTask, status: 'todo', priority: 'low', due_date: null }, ...inputs.tasks.slice(1)]} />);
  expect(screen.getByRole('region', { name: 'Bilan IA du jour' })).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('sans tâche ouverte et sans suivi, le raccourci du bilan reste désactivé', () => {
  render(<OverviewAiActions {...props([task('finie', { status: 'done' })])} />);
  expect(screen.getByRole('button', { name: /Bilan du jour/ })).toBeDisabled();
  expect(screen.getByText(/Ajoute une tâche ou une entrée aux suivis IA/)).toBeVisible();
});

test('le bilan synthétise les entrées suivies même sans tâche à replanifier', async () => {
  const user = userEvent.setup();
  const inputs = { ...props([]), entries: [note('n', 'Note suivie', { follow_up: follow })] };
  const { write } = mockDailyState(inputs);
  vi.mocked(generateDailyReview).mockResolvedValue(review);
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Bilan du jour' }));
  await screen.findByRole('region', { name: 'Bilan IA du jour' });
  expect(replanTasks).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(vi.mocked(generateDailyReview).mock.calls[0][1]).toEqual([expect.objectContaining({ id: 'n', follow_up: follow })]);
});

test('un plan incomplet bloque les écritures et le bilan', async () => {
  const user = userEvent.setup();
  const inputs = props([task('a'), task('b')]);
  const { write } = mockDailyState(inputs);
  vi.mocked(replanTasks).mockResolvedValue([{ id: 'a', priority: 'high', due_date: '2099-11-06', reason: 'À traiter en premier.' }]);
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Bilan du jour' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Replanification incomplète (1 sur 2 tâches)');
  expect(write).not.toHaveBeenCalled();
  expect(generateDailyReview).not.toHaveBeenCalled();
});

test('un changement des tâches pendant la replanification empêche le bilan et les écritures', async () => {
  const user = userEvent.setup();
  const inputs = props([task('a')]);
  const { read, write } = mockDailyState(inputs);
  read.mockResolvedValueOnce(state(inputs.tasks)).mockResolvedValueOnce(state([...inputs.tasks, task('b')]));
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Bilan du jour' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('les tâches ont changé pendant la replanification');
  expect(write).not.toHaveBeenCalled();
  expect(generateDailyReview).not.toHaveBeenCalled();
});

test('un refus en cours d’enregistrement rafraîchit les tâches et empêche le bilan', async () => {
  const user = userEvent.setup();
  const inputs = props([task('a'), task('b')]);
  const { write } = mockDailyState(inputs);
  write.mockResolvedValueOnce(task('a', { due_date: '2099-11-06' })).mockRejectedValueOnce(new Error('Écriture refusée.'));
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Bilan du jour' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Écriture refusée.');
  expect(screen.getByRole('status')).toHaveTextContent('1 tâche enregistrée.');
  expect(inputs.onChanged).toHaveBeenCalledOnce();
  expect(generateDailyReview).not.toHaveBeenCalled();
});

test('si le planificateur atteint le plafond IA, le bilan s’arrête avant les écritures', async () => {
  const user = userEvent.setup();
  saveDailyLimit(10);
  for (let index = 0; index < 9; index++) recordAiUsage(100, false);
  const inputs = props([task('a')]);
  const { write } = mockDailyState(inputs);
  vi.mocked(replanTasks).mockImplementation(async () => {
    recordAiUsage(100, false);
    return [{ id: 'a', priority: 'high', due_date: '2099-11-06', reason: 'À traiter en premier.' }];
  });
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Bilan du jour' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Plafond quotidien d’IA atteint');
  expect(write).not.toHaveBeenCalled();
  expect(generateDailyReview).not.toHaveBeenCalled();
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

test.each(['API', 'PWA'])('%s : une réponse sans documents complets conserve la réussite partielle et les tâches restantes', async (backend) => {
  const user = userEvent.setup();
  const documents: Task['documents'] = [{ id: 'note-a', title: 'Note liée', entry_date: today, project_id: null, archived: 0, kind: 'note', updated_at: `${today}T09:00:00Z`, excerpt: '', attachments: 0 }];
  let tasks = [task('a', { documents }), task('b')];
  vi.mocked(replanTasks).mockResolvedValue([{ id: 'a', priority: 'high', due_date: today, reason: '' }, { id: 'b', priority: 'low', due_date: today, reason: '' }]);
  vi.spyOn(api, 'state').mockImplementation(async () => state(tasks));
  let refuse = true;
  const write = vi.spyOn(api, 'updateTask').mockImplementation(async (id, patch) => {
    if (id === 'b' && refuse) throw new Error('Écriture refusée.');
    const updated = { ...tasks.find((item) => item.id === id)!, ...patch };
    tasks = tasks.map((item) => item.id === id ? updated : item);
    // Le PUT serveur omet les documents ; le miroir PWA renvoie une liste vide.
    const { documents: _documents, ...response } = updated;
    return backend === 'PWA' ? { ...response, documents: [] } : response;
  });
  const inputs = props(tasks);
  const view = render(<OverviewAiActions {...inputs} />);
  inputs.onChanged.mockImplementation(() => view.rerender(<OverviewAiActions {...inputs} tasks={tasks} />));
  await user.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await screen.findByRole('region', { name: 'Dates et priorités proposées par l’IA' });
  await user.click(screen.getByRole('button', { name: 'Appliquer 2 tâches' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('1 tâche enregistrée. Écriture refusée.');
  await waitFor(() => expect(inputs.onChanged).toHaveBeenCalledOnce());
  expect(screen.getByRole('region', { name: 'Bilan du jour et planification IA' })).toHaveAttribute('aria-busy', 'false');
  expect(screen.queryByText('Enregistrement des dates et priorités…')).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Replanifier Tâche a' })).toBeDisabled();
  refuse = false;
  await user.click(screen.getByRole('button', { name: 'Appliquer 1 tâche' }));
  await waitFor(() => expect(inputs.onChanged).toHaveBeenCalledTimes(2));
  expect(write.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'b']);
});

test('après application, le spinner se retire et la proposition se referme même si la relecture attend', async () => {
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
  let release!: () => void;
  inputs.onChanged.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await screen.findByRole('region', { name: 'Dates et priorités proposées par l’IA' });
  await user.click(screen.getByRole('button', { name: 'Appliquer 1 tâche' }));
  await waitFor(() => expect(inputs.onChanged).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText('1 tâche replanifiée.')).toBeVisible(), { timeout: 3000 });
  expect(write).toHaveBeenCalledOnce();
  expect(screen.getByRole('region', { name: 'Bilan du jour et planification IA' })).toHaveAttribute('aria-busy', 'false');
  expect(screen.queryByText('Enregistrement des dates et priorités…')).not.toBeInTheDocument();
  // La proposition refermée : plus rien à appliquer, le spinner de « Enregistrement » parti.
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Dates et priorités proposées par l’IA' })).not.toBeInTheDocument());
  await act(async () => { release(); });
});

test('Arrêter coupe la demande et ignore une réponse qui arrive ensuite', async () => {
  const user = userEvent.setup();
  let resolve!: (value: typeof review) => void;
  vi.mocked(generateDailyReview).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const inputs = props([task('a', { follow_up: follow })]);
  mockDailyState(inputs);
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: /Bilan du jour/ }));
  await waitFor(() => expect(generateDailyReview).toHaveBeenCalledOnce());
  const signal = vi.mocked(generateDailyReview).mock.calls[0][0].signal;
  await user.click(screen.getByRole('button', { name: 'Arrêter' }));
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolve(review); });
  expect(screen.queryByRole('region', { name: 'Bilan IA du jour' })).not.toBeInTheDocument();
});

describe.each(['Bilan du jour', 'Replanifier avec l’IA'])('%s : pas de fausse alerte au changement suivant', (name) => {
  const followed = (version: string) => [task('a', { follow_up: follow, follow_up_key: version })];

  test('après Arrêter', async () => {
    const user = userEvent.setup();
    vi.mocked(generateDailyReview).mockImplementation(() => new Promise(() => {}));
    vi.mocked(replanTasks).mockImplementation(() => new Promise(() => {}));
    const inputs = props(followed('version1'));
    mockDailyState(inputs);
    const view = render(<OverviewAiActions {...inputs} />);
    await user.click(screen.getByRole('button', { name }));
    await user.click(await screen.findByRole('button', { name: 'Arrêter' }));
    view.rerender(<OverviewAiActions {...inputs} tasks={followed('version2')} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('après une erreur, qui reste affichée', async () => {
    const user = userEvent.setup();
    vi.mocked(generateDailyReview).mockRejectedValue(new Error('Quota atteint.'));
    vi.mocked(replanTasks).mockRejectedValue(new Error('Quota atteint.'));
    const inputs = props(followed('version1'));
    mockDailyState(inputs);
    const view = render(<OverviewAiActions {...inputs} />);
    await user.click(screen.getByRole('button', { name }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Quota atteint.');
    view.rerender(<OverviewAiActions {...inputs} tasks={followed('version2')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Quota atteint.');
  });
});

test('Fermer le bilan : le changement suivant ne déclenche pas de fausse alerte', async () => {
  const user = userEvent.setup();
  vi.mocked(generateDailyReview).mockResolvedValue(review);
  const inputs = props([task('a', { follow_up: follow, follow_up_key: 'version1' })]);
  mockDailyState(inputs);
  const view = render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: /Bilan du jour/ }));
  await screen.findByRole('region', { name: 'Bilan IA du jour' });
  await user.click(screen.getByRole('button', { name: 'Fermer le bilan du jour' }));
  view.rerender(<OverviewAiActions {...inputs} tasks={[task('a', { follow_up: follow, follow_up_key: 'version2' })]} />);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('arrêter un bilan laisse applicable la replanification déjà proposée', async () => {
  const user = userEvent.setup();
  const tasks = [task('a')];
  vi.mocked(replanTasks).mockResolvedValueOnce([{ id: 'a', priority: 'high', due_date: today, reason: '' }])
    .mockImplementationOnce(() => new Promise(() => {}));
  vi.spyOn(api, 'state').mockResolvedValue(state(tasks));
  const write = vi.spyOn(api, 'updateTask').mockImplementation(async (_id, patch) => ({ ...tasks[0], ...patch }));
  render(<OverviewAiActions {...props(tasks)} />);
  await user.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await screen.findByRole('region', { name: 'Dates et priorités proposées par l’IA' });
  await user.click(screen.getByRole('button', { name: 'Bilan du jour' }));
  await waitFor(() => expect(replanTasks).toHaveBeenCalledTimes(2));
  await user.click(await screen.findByRole('button', { name: 'Arrêter' }));
  await user.click(screen.getByRole('button', { name: 'Appliquer 1 tâche' }));
  await waitFor(() => expect(write).toHaveBeenCalledOnce());
});

test('un suivi modifié pendant une demande invalide le résultat en vol', async () => {
  const user = userEvent.setup();
  let resolve!: (value: typeof review) => void;
  vi.mocked(generateDailyReview).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const inputs = props([task('a', { follow_up: follow, follow_up_key: 'version1' })]);
  mockDailyState(inputs);
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
  mockDailyState(inputs);
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

test('la replanification distingue les changements des propositions inchangées', async () => {
  const user = userEvent.setup();
  const tasks = [task('a', { priority: 'normal', due_date: null }), task('b', { priority: 'high', due_date: today })];
  vi.mocked(replanTasks).mockResolvedValue([
    { id: 'a', priority: 'high', due_date: today, reason: 'À traiter en premier.' },
    { id: 'b', priority: 'high', due_date: today, reason: '' },
  ]);
  render(<OverviewAiActions {...props(tasks)} />);
  await user.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await screen.findByRole('region', { name: 'Dates et priorités proposées par l’IA' });
  expect(screen.getByText('2 tâches · 1 changement')).toBeVisible();
  expect(screen.getByText('À modifier')).toBeVisible();
  expect(screen.getByText('Inchangée')).toBeVisible();
  const changedItem = screen.getByText('Tâche a').closest('li') as HTMLElement;
  expect(changedItem).toHaveTextContent('Actuel : Normale · sans date');
  expect(changedItem).toHaveTextContent(/Proposé : Haute/);
});

/** Le vrai contrôleur autour de la vue, avec un bilan qu'une modification de la session vient de rendre périmé. */
const renderWithStaleFollowUp = () => {
  vi.useFakeTimers();
  vi.mocked(generateFollowUp).mockImplementation(() => new Promise(() => {}));
  vi.spyOn(api, 'followUp').mockResolvedValue({ follow_up: follow, source_key: 'version2', source: { kind: 'task', id: 'a', title: 'Tâche a', project: null, documents: [] } });
  mockDailyState(props([task('a', { follow_up: follow, follow_up_key: 'version2' })]));
  const tree = (key: string) => {
    const stale = task('a', { follow_up: follow, follow_up_key: key });
    return <FollowUpProvider state={state([stale])} onChanged={vi.fn()}><OverviewAiActions {...props([stale])} /></FollowUpProvider>;
  };
  render(tree('version1')).rerender(tree('version2'));
  return (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

test.each([
  ['Replanifier avec l’IA', 'Dates et priorités proposées par l’IA', 'Ignorer'],
  ['Bilan du jour', 'Bilan IA du jour', 'Fermer le bilan du jour'],
])('%s : le résultat affiché survit à l’attente du suivi automatique, qui repart après sa fermeture', async (name, region, close) => {
  vi.mocked(replanTasks).mockResolvedValue([{ id: 'a', priority: 'high', due_date: today, reason: '' }]);
  vi.mocked(generateDailyReview).mockResolvedValue(review);
  const advance = renderWithStaleFollowUp();
  fireEvent.click(screen.getByRole('button', { name }));
  await advance(0);
  expect(screen.getByRole('region', { name: region })).toBeVisible();
  await advance(30 * 60_000);
  expect(generateFollowUp).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: region })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: close }));
  await advance(8_000);
  expect(generateFollowUp).toHaveBeenCalledOnce();
});

test('une demande en vol retient aussi l’actualisation automatique', async () => {
  vi.mocked(replanTasks).mockImplementation(() => new Promise(() => {}));
  const advance = renderWithStaleFollowUp();
  fireEvent.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await advance(30 * 60_000);
  expect(replanTasks).toHaveBeenCalledOnce();
  expect(generateFollowUp).not.toHaveBeenCalled();
});

test('les documents Google ne donnent pas leur titre à l’activité du jour', async () => {
  const user = userEvent.setup();
  vi.mocked(generateDailyReview).mockResolvedValue(review);
  const entries = [note('n', 'Note locale'), note('g', 'Contrat Google', { google_document_id: 'doc1' }), note('o', 'Onglet Google', { google_tab_id: 'tab1' })];
  const inputs = { ...props([task('a')]), entries };
  mockDailyState(inputs);
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Bilan du jour' }));
  await screen.findByRole('region', { name: 'Bilan IA du jour' });
  expect(vi.mocked(generateDailyReview).mock.calls[0][2]?.todayActivity?.notes).toEqual(['Note locale']);
});

test('le bilan annonce le jour local de son activité, même quand le jour UTC retarde', async () => {
  const user = userEvent.setup();
  vi.spyOn(lib, 'todayISO').mockReturnValue('2099-11-05');
  vi.mocked(generateDailyReview).mockResolvedValue(review);
  const inputs = props([task('a')]);
  mockDailyState(inputs);
  render(<OverviewAiActions {...inputs} />);
  await user.click(screen.getByRole('button', { name: 'Bilan du jour' }));
  await screen.findByRole('region', { name: 'Bilan IA du jour' });
  expect(vi.mocked(generateDailyReview).mock.calls[0][2]?.today).toBe(localToday());
  const label = new Date(localToday() + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  expect(screen.getByRole('heading', { name: `Bilan du ${label}` })).toBeVisible();
});

test('la replanification garde sa date de référence quand seul le bilan passe au jour local', async () => {
  const user = userEvent.setup();
  vi.spyOn(lib, 'todayISO').mockReturnValue('2099-11-05');
  vi.mocked(replanTasks).mockResolvedValue([{ id: 'a', priority: 'high', due_date: '2099-11-05', reason: '' }]);
  render(<OverviewAiActions {...props([task('a')])} />);
  await user.click(screen.getByRole('button', { name: 'Replanifier avec l’IA' }));
  await screen.findByRole('region', { name: 'Dates et priorités proposées par l’IA' });
  expect(vi.mocked(replanTasks).mock.calls[0][2]?.today).toBe('2099-11-05');
});

test('« Données envoyées » cite le profil pour les deux demandes', () => {
  render(<OverviewAiActions {...props([task('a')])} />);
  expect(screen.getByText(/bilan du jour, le service IA reçoit ton profil,.*replanifier, il reçoit ton profil,/)).toBeInTheDocument();
});
