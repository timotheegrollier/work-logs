import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProjectGithub } from './ProjectGithub';
import { api, type GithubList, type Project, type Task } from '../lib';

afterEach(() => { vi.restoreAllMocks(); });

const linked = { id: 'pr_villa', name: 'Villa', color: '#0a0', created_at: '', entries: 0, open_tasks: 0, github_repo: 'Timo/worklogs' } as Project;
const unlinked = { ...linked, github_repo: null } as Project;

const pulls: GithubList = {
  repo: 'Timo/worklogs',
  section: 'pulls',
  items: [
    { id: '1', number: 12, title: 'Ajoute la liaison', url: 'https://github.com/Timo/worklogs/pull/12', state: 'ouverte', author: 'timo', date: '2026-11-20T10:00:00Z', ref: 'feat/github' },
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
  const row = region.getByRole('link', { name: '#12 Ajoute la liaison' });
  expect(row).toHaveAttribute('href', 'https://github.com/Timo/worklogs/pull/12');
  expect(region.getByText(/ouverte · timo · feat\/github/)).toBeInTheDocument();
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
