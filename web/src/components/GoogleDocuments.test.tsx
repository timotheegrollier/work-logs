import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GoogleDocuments } from './GoogleDocuments';
import { api, ApiError, type Entry, type Project } from '../lib';

afterEach(() => { vi.restoreAllMocks(); });

const projects: Project[] = [{ id: 'pr_villa', name: 'Villa', color: '#0a0', created_at: '' } as Project];
const entry = { id: 'en_google', title: 'Document partagé' } as Entry;

function show(overrides: Partial<Parameters<typeof GoogleDocuments>[0]> = {}) {
  const props = { projects, onClose: vi.fn(), onOpen: vi.fn(), onChanged: vi.fn(), ...overrides };
  render(<GoogleDocuments {...props} />);
  return props;
}
const row = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement;

test('ouvre un document dans WorkLogs sans explorer ses onglets, puis se ferme', async () => {
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [{ id: 'doc-1', name: 'Document partagé', modifiedTime: '' }] });
  const scan = vi.spyOn(api, 'googleDocumentTabs');
  const open = vi.spyOn(api, 'openGoogleDocument').mockResolvedValue(entry);
  const props = show();
  expect(screen.getByRole('dialog', { name: 'Documents Google' })).toBeInTheDocument();
  const line = await row('Document partagé');
  await waitFor(() => expect(within(line).getByRole('button', { name: 'Ouvrir Document partagé' })).toBeEnabled());
  fireEvent.click(within(line).getByRole('button', { name: 'Ouvrir Document partagé' }));
  await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith(entry));
  expect(open).toHaveBeenCalledWith('doc-1');
  expect(props.onClose).toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
});

test('range un document dans un projet, en créant d’abord sa copie locale si besoin', async () => {
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [
    { id: 'doc-1', name: 'Jamais ouvert', modifiedTime: '', linked: false, project_id: null },
    { id: 'doc-2', name: 'Déjà rangé', modifiedTime: '', linked: true, project_id: 'pr_villa' },
  ] });
  const open = vi.spyOn(api, 'openGoogleDocument').mockResolvedValue(entry);
  const assign = vi.spyOn(api, 'setGoogleDocumentProject')
    .mockResolvedValueOnce({ ok: true, entries: 1, linked: true, project_id: 'pr_villa' })
    .mockResolvedValueOnce({ ok: true, entries: 2, linked: true, project_id: null });
  const props = show();
  expect(await screen.findByLabelText('Projet de Déjà rangé')).toHaveValue('pr_villa');
  fireEvent.change(screen.getByLabelText('Projet de Jamais ouvert'), { target: { value: 'pr_villa' } });
  expect(await screen.findByText('« Jamais ouvert » rangé dans Villa.')).toBeVisible();
  expect(open).toHaveBeenCalledWith('doc-1');
  expect(assign).toHaveBeenCalledWith('doc-1', 'pr_villa');
  expect(screen.getByLabelText('Projet de Jamais ouvert')).toHaveValue('pr_villa');
  expect(props.onChanged).toHaveBeenCalled();
  // Déjà local : pas de réouverture.
  fireEvent.change(screen.getByLabelText('Projet de Déjà rangé'), { target: { value: '' } });
  expect(await screen.findByText('« Déjà rangé » retiré de son projet.')).toBeVisible();
  expect(open).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenLastCalledWith('doc-2', null);
});

test('corbeille Drive après confirmation, rien sans elle', async () => {
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [{ id: 'doc-1', name: 'Brouillon', modifiedTime: '' }] });
  const trash = vi.spyOn(api, 'trashGoogleDocument').mockResolvedValue({ ok: true, removed: 1 });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  const props = show();
  const line = await row('Brouillon');
  await waitFor(() => expect(within(line).getByRole('button', { name: 'Mettre Brouillon à la corbeille' })).toBeEnabled());
  fireEvent.click(within(line).getByRole('button', { name: 'Mettre Brouillon à la corbeille' }));
  expect(trash).not.toHaveBeenCalled();
  fireEvent.click(within(line).getByRole('button', { name: 'Mettre Brouillon à la corbeille' }));
  expect(confirm.mock.calls[1][0]).toMatch(/récupérable 30 jours/);
  expect(await screen.findByText('« Brouillon » est dans la corbeille Google Drive.')).toBeVisible();
  expect(trash).toHaveBeenCalledWith('doc-1');
  expect(screen.queryByText('Brouillon')).not.toBeInTheDocument();
  expect(props.onChanged).toHaveBeenCalled();
});

test('crée un Google Docs nommé et l’ouvre immédiatement', async () => {
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [] });
  const create = vi.spyOn(api, 'createGoogleDocument').mockResolvedValue(entry);
  const props = show();
  const button = await screen.findByRole('button', { name: '＋ Nouveau Google Docs' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(screen.getByRole('button', { name: 'Créer et ouvrir' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Titre du nouveau document'), { target: { value: 'Document partagé' } });
  fireEvent.click(screen.getByRole('button', { name: 'Créer et ouvrir' }));
  await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith(entry));
  expect(create).toHaveBeenCalledWith('Document partagé');
});

test('API désactivée : lien d’activation sans prétendre la liste vide, puis récupération et filtre', async () => {
  const help = 'https://console.cloud.google.com/apis/library/drive.googleapis.com?project=1234';
  const list = vi.spyOn(api, 'googleDocuments').mockRejectedValueOnce(new ApiError('API Drive désactivée', 'GOOGLE_API_DISABLED', help))
    .mockResolvedValue({ files: [{ id: 'doc-1', name: 'Retrouvé', modifiedTime: '' }] });
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('API Drive désactivée');
  expect(screen.getByRole('link', { name: 'Activer l’API dans Google Cloud' })).toHaveAttribute('href', help);
  expect(screen.queryByText(/Aucun document autorisé/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Actualiser' }));
  expect(await screen.findByText('Retrouvé')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(list).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText('Filtrer les documents Drive'), { target: { value: 'absent' } });
  expect(screen.queryByText('Retrouvé')).not.toBeInTheDocument();
  expect(screen.getByText('Aucun document ne correspond.')).toBeVisible();
});
