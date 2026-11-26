import { expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectBar } from './ProjectBar';
import type { Project } from '../lib';

const projects = [
  { id: 'pr_villa', name: 'Villa', color: '#0a0', created_at: '', entries: 0, open_tasks: 0, github_repo: 'Timo/worklogs' } as Project,
];

test('le bouton GitHub n’apparaît que pour un projet sélectionné et ouvre son panneau', () => {
  const onGithub = vi.fn();
  const { rerender } = render(<ProjectBar projects={projects} selected="" onSelect={() => {}} onChanged={() => {}} onGithub={onGithub} />);
  expect(screen.queryByRole('button', { name: 'GitHub' })).not.toBeInTheDocument();
  rerender(<ProjectBar projects={projects} selected="pr_villa" onSelect={() => {}} onChanged={() => {}} onGithub={onGithub} />);
  fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
  expect(onGithub).toHaveBeenCalledWith(projects[0]);
});

test('sans gestionnaire (PWA), aucun bouton GitHub', () => {
  render(<ProjectBar projects={projects} selected="pr_villa" onSelect={() => {}} onChanged={() => {}} />);
  expect(screen.queryByRole('button', { name: 'GitHub' })).not.toBeInTheDocument();
});
