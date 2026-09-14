import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GoogleDrive } from './components/GoogleDrive';
import { EntryEditor } from './components/EntryEditor';
import { api, emptyDocument, type Entry } from './lib';

afterEach(() => vi.restoreAllMocks());
const connected = { available: true, configured: true, connected: true, pending: false, error: '', selectedIds: [] };
const entry: Entry = { id: 'en_google', title: 'Document partagé', content_md: 'Original', content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original' }] }] },
  entry_date: '2026-09-14', project_id: null, created_at: '', updated_at: '', attachments: [], google_sync: { document_id: 'doc-1', synced_at: '', dirty: true } };

test('ouvre un document autorisé dans WorkLogs puis permet de déconnecter Drive', async () => {
  vi.spyOn(api, 'googleStatus').mockResolvedValue(connected);
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [{ id: 'doc-1', name: 'Document partagé', modifiedTime: '' }] });
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
