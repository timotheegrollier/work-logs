import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProjectGithub } from './ProjectGithub';
import { api, type GithubList, type Project } from '../lib';

afterEach(() => { vi.restoreAllMocks(); });

const linked = { id: 'pr_villa', name: 'Villa', color: '#0a0', created_at: '', entries: 0, open_tasks: 0, github_repo: 'Timo/worklogs' } as Project;
const unlinked = { ...linked, github_repo: null } as Project;

const pulls: GithubList = {
  repo: 'Timo/worklogs',
  section: 'pulls',
  items: [{ id: '1', number: 12, title: 'Ajoute la liaison', url: 'https://github.com/Timo/worklogs/pull/12', state: 'ouverte', author: 'timo', date: '2026-11-20T10:00:00Z', ref: 'feat/github' }],
};

test('un projet non relié propose de relier un dépôt', async () => {
  const update = vi.spyOn(api, 'updateProject').mockResolvedValue(linked);
  const onChanged = vi.fn();
  render(<ProjectGithub project={unlinked} onClose={() => {}} onChanged={onChanged} />);
  const field = screen.getByLabelText('Dépôt GitHub');
  fireEvent.change(field, { target: { value: 'Timo/worklogs' } });
  fireEvent.click(screen.getByRole('button', { name: 'Relier le dépôt' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(update).toHaveBeenCalledWith('pr_villa', { github_repo: 'Timo/worklogs' });
});

test('un projet relié affiche les pull requests puis change de rubrique', async () => {
  const list = vi.spyOn(api, 'githubList').mockImplementation(async (_id, section) =>
    section === 'pulls' ? pulls : { repo: 'Timo/worklogs', section, items: [] });
  render(<ProjectGithub project={linked} onClose={() => {}} onChanged={() => {}} />);
  const region = within(await screen.findByRole('region', { name: 'Pull requests de Timo/worklogs' }));
  const row = region.getByRole('link', { name: '#12 Ajoute la liaison' });
  expect(row).toHaveAttribute('href', 'https://github.com/Timo/worklogs/pull/12');
  expect(region.getByText(/ouverte · timo · feat\/github/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
  expect(list).toHaveBeenLastCalledWith('pr_villa', 'actions');
  expect(await screen.findByText('Aucun élément dans cette rubrique.')).toBeInTheDocument();
});

test('une erreur de lecture GitHub reste lisible', async () => {
  vi.spyOn(api, 'githubList').mockRejectedValue(new Error('Connecte GitHub sur cet ordinateur avec gh auth login.'));
  render(<ProjectGithub project={linked} onClose={() => {}} onChanged={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('gh auth login');
});

test('délier le dépôt envoie un lien vide', async () => {
  const update = vi.spyOn(api, 'updateProject').mockResolvedValue(unlinked);
  vi.spyOn(api, 'githubList').mockResolvedValue(pulls);
  const onChanged = vi.fn();
  render(<ProjectGithub project={linked} onClose={() => {}} onChanged={onChanged} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Délier' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(update).toHaveBeenCalledWith('pr_villa', { github_repo: null });
});
