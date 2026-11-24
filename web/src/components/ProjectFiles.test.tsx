import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProjectFiles } from './ProjectFiles';
import { api, type Project, type ProjectFile } from '../lib';

afterEach(() => { vi.restoreAllMocks(); });

const projects = [
  { id: 'pr_villa', name: 'Villa', color: '#0a0', created_at: '', shared_dirs: ['2. TSE'] } as Project,
  { id: 'pr_notes', name: 'Notes', color: '#00a', created_at: '' } as Project,
];

const file = (overrides: Partial<ProjectFile> = {}): ProjectFile => ({
  id: 'at_1', filename: 'plan.pdf', stored: 's1', mime: 'application/pdf', size: 2048,
  entry_id: 'en_1', created_at: '2026-09-10T09:00:00Z', driveFileId: null,
  entry_title: 'Sauvegarde', entry_kind: 'procedure', entry_date: '2026-09-09',
  project_id: 'pr_villa', project_name: 'Villa', ...overrides,
});

function show(overrides: Partial<Parameters<typeof ProjectFiles>[0]> = {}) {
  const props = { projects, onClose: vi.fn(), onOpenEntry: vi.fn(), onSharedFolder: vi.fn(), onChanged: vi.fn(), ...overrides };
  render(<ProjectFiles {...props} />);
  return props;
}

test('range les fichiers par projet, sans projet à part, et les compte', async () => {
  vi.spyOn(api, 'projectFiles').mockResolvedValue([
    file(),
    file({ id: 'at_2', filename: 'suivi.xlsx', entry_id: 'en_2', entry_title: 'Compte rendu', project_id: 'pr_notes', project_name: 'Notes' }),
    file({ id: 'at_3', filename: 'libre.txt', entry_id: 'en_3', entry_title: 'Sans projet', project_id: null, project_name: null }),
  ]);
  show();
  expect(screen.getByRole('dialog', { name: 'Fichiers des projets' })).toBeInTheDocument();
  const villa = within(await screen.findByRole('region', { name: 'Fichiers du projet Villa' }));
  expect(villa.getByRole('button', { name: 'Ouvrir plan.pdf' })).toBeInTheDocument();
  expect(villa.getByRole('button', { name: 'Ouvrir l’entrée Sauvegarde' })).toBeInTheDocument();
  expect(villa.getByText(/1 fichier · 2 Ko/)).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Fichiers du projet Notes' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Fichiers du projet Sans projet' })).toBeInTheDocument();
  expect(screen.getByText('3 fichiers')).toBeInTheDocument();
});

test('filtre par projet puis par nom, et revient à tout', async () => {
  vi.spyOn(api, 'projectFiles').mockResolvedValue([
    file(),
    file({ id: 'at_3', filename: 'libre.txt', entry_id: 'en_3', entry_title: 'Sans projet', project_id: null, project_name: null }),
  ]);
  show();
  await screen.findByRole('region', { name: 'Fichiers du projet Villa' });
  fireEvent.click(screen.getByRole('button', { name: /^Sans projet/ }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Fichiers du projet Villa' })).not.toBeInTheDocument());
  expect(screen.getByRole('region', { name: 'Fichiers du projet Sans projet' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Tous' }));
  const search = screen.getByLabelText('Filtrer les fichiers');
  fireEvent.change(search, { target: { value: 'plan' } });
  expect(screen.queryByText('libre.txt')).not.toBeInTheDocument();
  expect(screen.getByText('plan.pdf')).toBeInTheDocument();
  fireEvent.change(search, { target: { value: 'introuvable' } });
  expect(screen.getByText('Aucun fichier ne correspond.')).toBeInTheDocument();
});

test('ouvre l’entrée d’un fichier et ferme le panneau', async () => {
  vi.spyOn(api, 'projectFiles').mockResolvedValue([file()]);
  const props = show();
  fireEvent.click(await screen.findByRole('button', { name: 'Ouvrir l’entrée Sauvegarde' }));
  expect(props.onOpenEntry).toHaveBeenCalledWith('en_1', 'pr_villa');
  expect(props.onClose).toHaveBeenCalled();
});

test('supprime après confirmation, met à jour la liste et prévient l’écran', async () => {
  vi.spyOn(api, 'projectFiles').mockResolvedValue([file(), file({ id: 'at_2', filename: 'note.txt', entry_title: 'Note' })]);
  const remove = vi.spyOn(api, 'deleteAttachment').mockResolvedValue({ ok: true, driveTrashed: false });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  const props = show();
  const button = await screen.findByRole('button', { name: 'Supprimer plan.pdf' });
  fireEvent.click(button);
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(remove).toHaveBeenCalledWith('at_1'));
  expect(await screen.findByText('« plan.pdf » supprimé.')).toBeInTheDocument();
  expect(screen.queryByText('plan.pdf')).not.toBeInTheDocument();
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(props.onChanged).toHaveBeenCalled();
});

test('un dossier partagé relié ouvre la colonne Procédures sur son projet', async () => {
  vi.spyOn(api, 'projectFiles').mockResolvedValue([file()]);
  const props = show();
  const link = await screen.findByRole('button', { name: 'Ouvrir le dossier partagé de Villa (2. TSE)' });
  fireEvent.click(link);
  expect(props.onSharedFolder).toHaveBeenCalledWith('pr_villa');
  expect(props.onClose).toHaveBeenCalled();
});

test('une erreur de lecture reste visible', async () => {
  vi.spyOn(api, 'projectFiles').mockRejectedValue(new Error('Relais injoignable'));
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('Relais injoignable');
});
