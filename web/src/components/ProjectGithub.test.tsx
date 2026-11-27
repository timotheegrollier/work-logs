import { afterEach, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectGithub } from './ProjectGithub';
import { api, ApiError, type GithubAccounts, type GithubList, type GithubLogin, type GithubPullDetail, type Project, type Task } from '../lib';

afterEach(() => { vi.restoreAllMocks(); });

const linked = { id: 'pr_villa', name: 'Villa', color: '#0a0', created_at: '', entries: 0, open_tasks: 0, github_repo: 'Timo/worklogs' } as Project;
const unlinked = { ...linked, github_repo: null } as Project;

const pulls: GithubList = {
  repo: 'Timo/worklogs',
  section: 'pulls',
  items: [
    { id: '1', number: 12, title: 'Ajoute la liaison', url: 'https://github.com/Timo/worklogs/pull/12', state: 'ouverte', author: 'timo', date: '2026-11-20T10:00:00Z', ref: 'feat/github',
      status: 'open', baseRef: 'main', labels: [{ name: 'À relire', color: '5319e7' }], checksStatus: 'failure',
      reviewDecision: 'changes_requested', mergeStatus: 'dirty', changedFiles: 2, additions: 16, deletions: 7 },
    { id: '2', number: 9, title: 'Ancienne branche', url: 'https://github.com/Timo/worklogs/pull/9', state: 'fusionnée', author: 'timo', date: '2026-11-10T10:00:00Z', ref: 'old' },
  ],
};

const panel = (props: Partial<Parameters<typeof ProjectGithub>[0]> = {}) => (
  <ProjectGithub project={linked} tasks={[]} onChanged={() => {}} onOpenTask={() => {}} onCreateTask={async () => {}} {...props} />
);

test('un projet non relié propose de relier un dépôt, dans la colonne et sans fenêtre modale', async () => {
  const update = vi.spyOn(api, 'updateProject').mockResolvedValue(linked);
  const onChanged = vi.fn();
  render(panel({ project: unlinked, onChanged }));
  expect(screen.getByRole('region', { name: 'GitHub du projet Villa' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const field = screen.getByLabelText('Dépôt GitHub');
  fireEvent.change(field, { target: { value: 'Timo/worklogs' } });
  fireEvent.click(screen.getByRole('button', { name: 'Relier le dépôt' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(update).toHaveBeenCalledWith('pr_villa', { github_repo: 'Timo/worklogs' });
});

test('un projet relié affiche les pull requests puis change de rubrique, en annulant la lecture précédente', async () => {
  const list = vi.spyOn(api, 'githubList').mockImplementation(async (_id, section) =>
    section === 'pulls' ? pulls : { repo: 'Timo/worklogs', section, items: [] });
  render(panel());
  const region = within(await screen.findByRole('region', { name: 'Pull requests de Timo/worklogs' }));
  const row = await region.findByRole('link', { name: '#12 Ajoute la liaison' });
  expect(row).toHaveAttribute('href', 'https://github.com/Timo/worklogs/pull/12');
  expect(region.getByText('Ouverte', { selector: '.github-badge' })).toHaveAttribute('data-tone', 'open');
  expect(region.getByText('Fusionnée', { selector: '.github-badge' })).toHaveAttribute('data-tone', 'merged');
  expect(region.getByText('CI échouée')).toHaveAttribute('data-tone', 'failure');
  expect(region.getByText('Modifications demandées')).toBeInTheDocument();
  expect(region.getByText('Conflits')).toBeInTheDocument();
  expect(region.getByText('feat/github')).toBeInTheDocument();
  expect(region.getByText('main')).toBeInTheDocument();
  expect(region.getByText('À relire')).toHaveAttribute('data-color', '#5319e7');
  const first = list.mock.calls[0][2] as AbortSignal;
  expect(first.aborted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
  expect(list).toHaveBeenLastCalledWith('pr_villa', 'actions', expect.any(AbortSignal));
  expect(first.aborted).toBe(true);
  expect(await screen.findByText('Aucun élément dans cette rubrique.')).toBeInTheDocument();
});

test('fermer la colonne arrête la lecture GitHub en cours', () => {
  const list = vi.spyOn(api, 'githubList').mockReturnValue(new Promise(() => {}));
  const { unmount } = render(panel());
  unmount();
  expect((list.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
});

test('une pull request ouverte se suit comme tâche ; une fusionnée ne le propose pas', async () => {
  vi.spyOn(api, 'githubList').mockResolvedValue(pulls);
  const onCreateTask = vi.fn().mockResolvedValue(undefined);
  render(panel({ onCreateTask }));
  fireEvent.click(await screen.findByRole('button', { name: 'Suivre #12 Ajoute la liaison comme tâche' }));
  await waitFor(() => expect(onCreateTask).toHaveBeenCalledWith('#12 Ajoute la liaison', 'https://github.com/Timo/worklogs/pull/12'));
  expect(screen.queryByRole('button', { name: /Suivre #9 / })).not.toBeInTheDocument();
});

test('une pull request déjà suivie ouvre sa tâche au lieu d’en créer une', async () => {
  vi.spyOn(api, 'githubList').mockResolvedValue(pulls);
  const task = { id: 'tk_1', title: '#12 ajoute la LIAISON', project_id: 'pr_villa' } as Task;
  const onOpenTask = vi.fn();
  render(panel({ tasks: [task], onOpenTask }));
  fireEvent.click(await screen.findByRole('button', { name: 'Ouvrir la tâche #12 Ajoute la liaison' }));
  expect(onOpenTask).toHaveBeenCalledWith(task);
  expect(screen.queryByRole('button', { name: /comme tâche/ })).not.toBeInTheDocument();
});

test('les commits ne se suivent pas comme tâches', async () => {
  vi.spyOn(api, 'githubList').mockImplementation(async (_id, section) => ({
    repo: 'Timo/worklogs', section,
    items: section === 'commits' ? [{ id: 'abc', number: null, title: 'fix: corrige', url: 'https://github.com/Timo/worklogs/commit/abc', state: null, author: 'timo', date: null, ref: null }] : [],
  }));
  render(panel());
  fireEvent.click(await screen.findByRole('button', { name: 'Commits' }));
  expect(await screen.findByRole('link', { name: 'fix: corrige' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Tâche|tâche/ })).not.toBeInTheDocument();
});

test('une erreur de lecture GitHub reste lisible', async () => {
  vi.spyOn(api, 'githubList').mockRejectedValue(new Error('Connecte GitHub sur cet ordinateur avec gh auth login.'));
  render(panel());
  expect(await screen.findByRole('alert')).toHaveTextContent('gh auth login');
});

test('délier le dépôt envoie un lien vide', async () => {
  const update = vi.spyOn(api, 'updateProject').mockResolvedValue(unlinked);
  vi.spyOn(api, 'githubList').mockResolvedValue(pulls);
  const onChanged = vi.fn();
  render(panel({ onChanged }));
  fireEvent.click(await screen.findByRole('button', { name: 'Délier' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(update).toHaveBeenCalledWith('pr_villa', { github_repo: null });
});

const accounts: GithubAccounts = {
  accounts: [{ login: 'timotheegrollier', active: true, ok: true }, { login: 'claude-murgat', active: false, ok: true }, { login: 'stxtxm', active: false, ok: false }],
  chosen: null,
};
const idle: GithubLogin = { state: 'idle', code: null, url: null, account: null, error: null };

test('un dépôt inaccessible propose un autre compte de GitHub CLI, puis relit la rubrique avec lui', async () => {
  const list = vi.spyOn(api, 'githubList')
    .mockRejectedValueOnce(new ApiError('GitHub : dépôt ou contenu introuvable, ou inaccessible au compte connecté dans GitHub CLI.', 'GITHUB_NOT_FOUND'))
    .mockResolvedValue(pulls);
  vi.spyOn(api, 'githubAccounts').mockResolvedValue(accounts);
  vi.spyOn(api, 'githubLogin').mockResolvedValue(idle);
  const choose = vi.spyOn(api, 'chooseGithubAccount').mockResolvedValue({ ...accounts, chosen: 'claude-murgat' });
  render(panel());

  expect(await screen.findByRole('alert')).toHaveTextContent('inaccessible au compte connecté');
  const account = within(await screen.findByRole('region', { name: 'Compte GitHub' }));
  expect(screen.getByRole('button', { name: 'Compte' })).toHaveAttribute('aria-expanded', 'true');
  const field = await account.findByLabelText('Compte GitHub de WorkLogs');
  expect(within(field).getAllByRole('option').map((option) => option.textContent))
    .toEqual(['Compte actif de GitHub CLI (timotheegrollier)', 'timotheegrollier', 'claude-murgat', 'stxtxm (à reconnecter)']);
  expect(field).toHaveValue('');

  fireEvent.change(field, { target: { value: 'claude-murgat' } });
  await waitFor(() => expect(choose).toHaveBeenCalledWith('claude-murgat'));
  expect(await screen.findByRole('link', { name: '#12 Ajoute la liaison' })).toBeInTheDocument();
  expect(list).toHaveBeenCalledTimes(2);
  expect(account.getByLabelText('Compte GitHub de WorkLogs')).toHaveValue('claude-murgat');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();

  // Revenir au compte actif de gh efface le choix.
  choose.mockResolvedValue(accounts);
  fireEvent.change(account.getByLabelText('Compte GitHub de WorkLogs'), { target: { value: '' } });
  await waitFor(() => expect(choose).toHaveBeenLastCalledWith(null));
});

test('connecter un compte GitHub montre le code d’appareil et github.com, puis lit avec le compte autorisé', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const list = vi.spyOn(api, 'githubList').mockResolvedValue(pulls);
    const listed = vi.spyOn(api, 'githubAccounts').mockResolvedValue(accounts);
    const status = vi.spyOn(api, 'githubLogin').mockResolvedValue(idle);
    const pendingLogin: GithubLogin = { ...idle, state: 'pending', code: 'AB12-CD34', url: 'https://github.com/login/device' };
    const start = vi.spyOn(api, 'startGithubLogin').mockResolvedValue(pendingLogin);
    const cancel = vi.spyOn(api, 'cancelGithubLogin').mockResolvedValue(idle);
    render(panel());
    await screen.findByRole('link', { name: '#12 Ajoute la liaison' });
    // Sans refus, le compte reste replié derrière son bouton.
    expect(screen.queryByRole('region', { name: 'Compte GitHub' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Compte' }));
    const account = within(await screen.findByRole('region', { name: 'Compte GitHub' }));

    fireEvent.click(await account.findByRole('button', { name: 'Connecter un compte GitHub' }));
    expect(await account.findByText('AB12-CD34')).toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(1);
    expect(account.getByRole('link', { name: 'Ouvrir github.com ↗' })).toHaveAttribute('href', 'https://github.com/login/device');
    expect(account.getByLabelText('Compte GitHub de WorkLogs')).toBeDisabled();

    // Annuler arrête la connexion ; la relancer redonne un code.
    fireEvent.click(account.getByRole('button', { name: 'Annuler' }));
    expect(await account.findByRole('button', { name: 'Connecter un compte GitHub' })).toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);
    fireEvent.click(account.getByRole('button', { name: 'Connecter un compte GitHub' }));
    expect(await account.findByText('AB12-CD34')).toBeInTheDocument();

    status.mockResolvedValueOnce(pendingLogin).mockResolvedValue({ ...idle, state: 'done', account: 'neo' });
    // `gh auth status` est lent : la liste relue doit encore arriver, même après l'affichage suivant.
    let answer: (value: GithubAccounts) => void = () => {};
    listed.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(account.getByText('AB12-CD34')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(listed).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await act(async () => { answer({ accounts: [...accounts.accounts, { login: 'neo', active: false, ok: true }], chosen: 'neo' }); });
    expect(await account.findByText('Compte neo connecté : WorkLogs lit maintenant avec lui.')).toBeInTheDocument();
    await waitFor(() => expect(account.getByLabelText('Compte GitHub de WorkLogs')).toHaveValue('neo'));
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test('une connexion GitHub en cours reprend avec son code quand la colonne se rouvre, même arrivé en retard', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.spyOn(api, 'githubList').mockResolvedValue(pulls);
    vi.spyOn(api, 'githubAccounts').mockResolvedValue(accounts);
    // Rouvert avant que gh ait donné son code : le sondage suivant l'affiche.
    vi.spyOn(api, 'githubLogin')
      .mockResolvedValueOnce({ ...idle, state: 'pending' })
      .mockResolvedValue({ ...idle, state: 'pending', code: 'ZZ99-YY88', url: 'https://github.com/login/device' });
    render(panel());
    fireEvent.click(await screen.findByRole('button', { name: 'Compte' }));
    const account = within(await screen.findByRole('region', { name: 'Compte GitHub' }));
    await waitFor(() => expect(account.queryByRole('button', { name: 'Connecter un compte GitHub' })).not.toBeInTheDocument());
    expect(account.queryByText('ZZ99-YY88')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await account.findByText('ZZ99-YY88')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test('le filtre d’état et la recherche par étiquette, branche ou numéro se combinent et se réinitialisent', async () => {
  const list = vi.spyOn(api, 'githubList').mockResolvedValue(pulls);
  render(panel());
  const search = screen.getByRole('searchbox', { name: 'Rechercher dans Pull requests' });
  const filter = screen.getByRole('combobox', { name: 'Filtrer par état' });
  await screen.findByRole('link', { name: '#12 Ajoute la liaison' });

  fireEvent.change(search, { target: { value: 'a relire feat/github #12' } });
  expect(screen.getByRole('link', { name: '#12 Ajoute la liaison' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '#9 Ancienne branche' })).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('1/2 résultat');

  fireEvent.change(filter, { target: { value: 'merged' } });
  expect(screen.getByText('Aucun résultat pour ces filtres.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Effacer les filtres' }));
  expect(search).toHaveValue('');
  expect(filter).toHaveValue('');
  expect(screen.getByRole('link', { name: '#9 Ancienne branche' })).toBeInTheDocument();
  expect(list).toHaveBeenCalledTimes(1);
});

const pullDetail: GithubPullDetail = {
  body: 'Description de la pull request.',
  checks: [{ name: 'Linux / tests', status: 'failure', url: 'https://github.com/Timo/worklogs/actions/runs/42' }],
  reviews: [{ author: 'alice', state: 'approved', url: null, date: '2026-11-20T10:00:00Z' }],
  files: [{ path: 'src/panneau.ts', status: 'modified', additions: 16, deletions: 7 }],
  checksCount: 1, reviewsCount: 1, filesCount: 2,
};

test('les détails de PR se chargent à la demande puis affichent les vérifications, revues et fichiers', async () => {
  vi.spyOn(api, 'githubList').mockResolvedValue(pulls);
  const detail = vi.spyOn(api, 'githubPullDetail').mockResolvedValue(pullDetail);
  render(panel());

  const toggle = await screen.findByRole('button', { name: 'Détails de #12 Ajoute la liaison' });
  expect(detail).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(detail).toHaveBeenCalledWith(linked.id, 12, expect.any(AbortSignal));
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await screen.findByText('Description de la pull request.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Linux / tests' })).toHaveAttribute('href', pullDetail.checks[0].url);
  expect(within(screen.getByRole('region', { name: 'Revues' })).getByText('Approuvée')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Fichiers modifiés' })).getByText('src/panneau.ts')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Voir les modifications sur GitHub' })).toHaveAttribute('href', pulls.items[0].url + '/files');

  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: 'Vérifications' })).not.toBeInTheDocument();
  expect(detail.mock.calls[0][2]?.aborted).toBe(true);
});

test('une erreur de détail se réessaie et le changement de rubrique annule sa lecture', async () => {
  vi.spyOn(api, 'githubList').mockImplementation(async (_id, section) =>
    section === 'pulls' ? pulls : { repo: pulls.repo, section, items: [] });
  const detail = vi.spyOn(api, 'githubPullDetail')
    .mockRejectedValueOnce(new Error('GitHub : vérifications indisponibles.'))
    .mockReturnValueOnce(new Promise(() => {}));
  render(panel());
  fireEvent.click(await screen.findByRole('button', { name: 'Détails de #12 Ajoute la liaison' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('vérifications indisponibles');
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer les détails' }));
  expect(detail).toHaveBeenCalledTimes(2);
  expect(detail.mock.calls[1][2]?.aborted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
  expect(detail.mock.calls[1][2]?.aborted).toBe(true);
  expect(await screen.findByText('Aucun élément dans cette rubrique.')).toBeInTheDocument();
});

test('copier le lien utilise l’adresse de l’élément et confirme la copie', async () => {
  const user = userEvent.setup();
  vi.spyOn(api, 'githubList').mockResolvedValue(pulls);
  render(panel());

  await user.click(await screen.findByRole('button', { name: 'Copier le lien de #12 Ajoute la liaison' }));
  expect(await navigator.clipboard.readText()).toBe(pulls.items[0].url);
  expect(await screen.findByText('Lien copié.')).toBeInTheDocument();
});

test('une erreur de rubrique se réessaie et le raccourci ouvre la rubrique sur GitHub', async () => {
  const list = vi.spyOn(api, 'githubList')
    .mockRejectedValueOnce(new Error('Lecture indisponible.'))
    .mockResolvedValue(pulls);
  render(panel());

  expect(await screen.findByRole('alert')).toHaveTextContent('Lecture indisponible.');
  expect(screen.getByRole('link', { name: 'Voir Pull requests sur GitHub' })).toHaveAttribute('href', 'https://github.com/Timo/worklogs/pulls');
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  expect(await screen.findByRole('link', { name: '#12 Ajoute la liaison' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(list).toHaveBeenCalledTimes(2);
});
