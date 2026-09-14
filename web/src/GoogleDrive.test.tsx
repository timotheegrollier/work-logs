import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GoogleDrive } from './components/GoogleDrive';
import { EntryEditor } from './components/EntryEditor';
import { api, ApiError, emptyDocument, type Entry } from './lib';

afterEach(() => vi.restoreAllMocks());
const connected = { available: true, configured: true, connected: true, pending: false, error: '', selectedIds: [] };
const entry: Entry = { id: 'en_google', title: 'Document partagé', content_md: 'Original', content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original' }] }] },
  entry_date: '2026-09-14', project_id: null, created_at: '', updated_at: '', attachments: [], google_sync: { document_id: 'doc-1', synced_at: '', dirty: true } };

test('ouvre un document autorisé dans WorkLogs puis permet de déconnecter Drive', async () => {
  vi.spyOn(api, 'googleStatus').mockResolvedValue(connected);
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [{ id: 'doc-1', name: 'Document partagé', modifiedTime: '' }] });
  vi.spyOn(api, 'googleDocumentTabs').mockResolvedValue({ tabs: [{ id: 't.0', title: 'Onglet 1', depth: 0 }] });
  const open = vi.spyOn(api, 'openGoogleDocument').mockResolvedValue(entry);
  const disconnect = vi.spyOn(api, 'disconnectGoogle').mockResolvedValue({ ...connected, connected: false });
  const onOpen = vi.fn();
  render(<GoogleDrive onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: /Google Drive/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Document partagé' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(entry));
  expect(open).toHaveBeenCalledWith('doc-1');
  fireEvent.click(screen.getByRole('button', { name: 'Déconnecter Google Drive' }));
  await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
  expect(await screen.findByRole('button', { name: 'Connecter Google Drive' })).toBeVisible();
});

test('un conflit Drive affiche l’erreur et conserve le contenu local éditable', async () => {
  vi.spyOn(api, 'pushGoogleDocument').mockRejectedValue(new Error('Le document a changé sur Google Drive. Ton brouillon local est conservé.'));
  render(<EntryEditor entry={entry} projects={[]} onChanged={() => {}} onDeleted={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer sur Drive' }));
  expect(await screen.findByText(/Le document a changé/)).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveTextContent('Original');
  expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveAttribute('contenteditable', 'true');
});

test('recharger Google exige le choix explicite de remplacer le brouillon', async () => {
  const pull = vi.spyOn(api, 'pullGoogleDocument').mockResolvedValue({ ...entry, content_md: '', content_json: emptyDocument(), google_sync: { ...entry.google_sync!, dirty: false } });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<EntryEditor entry={entry} projects={[]} onChanged={() => {}} onDeleted={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Recharger depuis Google' }));
  expect(pull).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Recharger depuis Google' }));
  await waitFor(() => expect(pull).toHaveBeenCalledWith(entry.id, entry.content_json));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Contenu du document' })).not.toHaveTextContent('Original'));
});

test('crée un Google Docs nommé et l’ouvre immédiatement dans l’éditeur', async () => {
  vi.spyOn(api, 'googleStatus').mockResolvedValue(connected);
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [] });
  const create = vi.spyOn(api, 'createGoogleDocument').mockResolvedValue(entry);
  const onOpen = vi.fn();
  render(<GoogleDrive onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: /Google Drive/ }));
  const button = await screen.findByRole('button', { name: 'Créer un Google Docs' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(screen.getByRole('button', { name: 'Créer et ouvrir' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Titre du nouveau document'), { target: { value: 'Document partagé' } });
  fireEvent.click(screen.getByRole('button', { name: 'Créer et ouvrir' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(entry));
  expect(create).toHaveBeenCalledWith('Document partagé');
  expect(await screen.findByRole('button', { name: 'Document partagé' })).toBeVisible();
});

test('une API désactivée affiche un lien d’activation, sans prétendre que la liste est vide, puis récupère après actualisation', async () => {
  vi.spyOn(api, 'googleStatus').mockResolvedValue(connected);
  const help = 'https://console.cloud.google.com/apis/library/drive.googleapis.com?project=1234';
  const list = vi.spyOn(api, 'googleDocuments').mockRejectedValueOnce(new ApiError('API Drive désactivée', 'GOOGLE_API_DISABLED', help))
    .mockResolvedValue({ files: [{ id: 'doc-1', name: 'Retrouvé', modifiedTime: '' }] });
  render(<GoogleDrive onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Google Drive/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('API Drive désactivée');
  expect(screen.getByRole('link', { name: 'Activer l’API dans Google Cloud' })).toHaveAttribute('href', help);
  expect(screen.queryByText(/Aucun document autorisé/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Actualiser la liste' }));
  expect(await screen.findByRole('button', { name: 'Retrouvé' })).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(list).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText('Filtrer les documents Drive'), { target: { value: 'absent' } });
  expect(screen.queryByRole('button', { name: 'Retrouvé' })).not.toBeInTheDocument();
});

test('propose les onglets Google et ouvre uniquement le brouillon choisi', async () => {
  vi.spyOn(api, 'googleStatus').mockResolvedValue(connected);
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [{ id: 'doc-1', name: 'Document partagé', modifiedTime: '' }] });
  vi.spyOn(api, 'googleDocumentTabs').mockResolvedValue({ tabs: [
    { id: 't.0', title: 'Complexe', depth: 0, editable: false, reason: 'Contient un tableau' },
    { id: 't.1', title: 'Notes', depth: 1, editable: true },
  ] });
  const open = vi.spyOn(api, 'openGoogleDocument').mockResolvedValue(entry);
  const onOpen = vi.fn();
  render(<GoogleDrive onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: /Google Drive/ }));
  const file = await screen.findByRole('button', { name: 'Document partagé' });
  await waitFor(() => expect(file).toBeEnabled());
  fireEvent.click(file);
  expect(await screen.findByRole('button', { name: 'Complexe' })).toBeDisabled();
  expect(open).not.toHaveBeenCalled();
  const child = screen.getByRole('button', { name: /Notes/ });
  await waitFor(() => expect(child).toBeEnabled());
  fireEvent.click(child);
  await waitFor(() => expect(open).toHaveBeenCalledWith('doc-1', 't.1'));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(entry));
});

test('un envoi bloqué par Docs API propose son activation dans l’éditeur', async () => {
  const help = 'https://console.cloud.google.com/apis/library/docs.googleapis.com?project=1234';
  vi.spyOn(api, 'pushGoogleDocument').mockRejectedValue(new ApiError('API Docs désactivée', 'GOOGLE_API_DISABLED', help));
  render(<EntryEditor entry={entry} projects={[]} onChanged={() => {}} onDeleted={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer sur Drive' }));
  expect(await screen.findByRole('link', { name: 'Activer l’API dans Google Cloud' })).toHaveAttribute('href', help);
  expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveTextContent('Original');
});
