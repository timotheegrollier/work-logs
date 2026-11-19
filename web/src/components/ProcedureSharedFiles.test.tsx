import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type Attachment, type Project, type SharedFile, type SharedListing } from '../lib';
import { AttachFromLinkedFolder, CopyAttachmentToLinkedFolder } from './ProcedureSharedFiles';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const project = { id: 'p', name: 'Atelier', shared_dir: '\\\\serveur\\documents\\Procédures' } as Project;
const attachment: Attachment = { id: 'a', filename: 'relevé.xlsx', stored: 'a.xlsx', mime: 'application/octet-stream', size: 3, entry_id: 'e', created_at: '' };
const status = () => vi.spyOn(api, 'sharedStatus').mockResolvedValue({ available: true, address: '\\\\serveur\\documents' });

test('copie les octets de la pièce jointe dans le dossier lié, avec le nom original', async () => {
  status();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0, 128, 255]))));
  const create = vi.spyOn(api, 'createShared').mockResolvedValue({} as SharedFile);
  const onCopied = vi.fn();
  render(<CopyAttachmentToLinkedFolder file={attachment} project={project} onCopied={onCopied} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copier relevé.xlsx vers le dossier lié' }));
  await screen.findByText('Copié dans le dossier lié.');
  expect(create).toHaveBeenCalledExactlyOnceWith('Procédures/relevé.xlsx', new Uint8Array([0, 128, 255]));
  expect(onCopied).toHaveBeenCalledOnce();
});

test('un nom déjà pris ou un dossier hors du partage reste annoncé sans fausse réussite', async () => {
  const readStatus = status();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('octets')));
  const create = vi.spyOn(api, 'createShared').mockRejectedValue(new Error('Ce fichier existe déjà.'));
  const onCopied = vi.fn();
  render(<CopyAttachmentToLinkedFolder file={attachment} project={project} onCopied={onCopied} />);
  const button = screen.getByRole('button', { name: 'Copier relevé.xlsx vers le dossier lié' });
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('Ce fichier existe déjà.');
  expect(onCopied).not.toHaveBeenCalled();
  readStatus.mockResolvedValue({ available: true, address: '\\\\serveur\\autre' });
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('hors du partage connecté'));
  expect(create).toHaveBeenCalledOnce();
});

test('parcourt les sous-dossiers du dossier lié et joint le fichier choisi à la bonne procédure', async () => {
  status();
  const list = vi.spyOn(api, 'sharedList').mockImplementation(async (dir = ''): Promise<SharedListing> => ({
    dir, reach: 'ok', truncated: false, entries: dir === 'Procédures'
      ? [{ type: 'dir', path: 'Procédures/Mesures', name: 'Mesures', ext: '', size: null, mtime: null, lock: null, local: null }]
      : [{ type: 'file', path: 'Procédures/Mesures/relevé.xlsx', name: 'relevé.xlsx', ext: 'xlsx', size: 3, mtime: null, lock: null, local: null }],
  }));
  const shared = vi.spyOn(api, 'sharedFile').mockResolvedValue({ name: 'relevé.xlsx', hash: 'empreinte' } as SharedFile);
  vi.spyOn(api, 'sharedContent').mockResolvedValue(new Uint8Array([0, 128, 255]));
  const upload = vi.spyOn(api, 'upload').mockResolvedValue(attachment);
  const onAttached = vi.fn();
  render(<AttachFromLinkedFolder entryId="e" title="Contrôle" project={project} onAttached={onAttached} />);
  fireEvent.click(screen.getByRole('button', { name: 'Joindre depuis le dossier lié à Contrôle' }));
  const picker = within(await screen.findByRole('region', { name: 'Fichiers du dossier lié à Contrôle' }));
  fireEvent.click(await picker.findByRole('button', { name: 'Ouvrir le dossier Mesures' }));
  fireEvent.click(await picker.findByRole('button', { name: 'Joindre relevé.xlsx à Contrôle' }));
  await picker.findByText('« relevé.xlsx » joint à la procédure.');
  expect(shared).toHaveBeenCalledExactlyOnceWith('Procédures/Mesures/relevé.xlsx');
  expect(upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'relevé.xlsx', size: 3 }), 'e');
  expect(onAttached).toHaveBeenCalledExactlyOnceWith(attachment);
  fireEvent.click(picker.getByRole('button', { name: 'Dossier parent' }));
  await picker.findByRole('button', { name: 'Ouvrir le dossier Mesures' });
  expect(picker.queryByRole('button', { name: 'Dossier parent' })).not.toBeInTheDocument();
  expect(list.mock.calls.map(([dir]) => dir)).toEqual(['Procédures', 'Procédures/Mesures', 'Procédures']);
});

test('une destination modifiée après lecture du dossier empêche de joindre un ancien fichier hors du lien courant', async () => {
  status();
  vi.spyOn(api, 'sharedList').mockResolvedValue({ dir: 'Procédures', reach: 'ok', truncated: false, entries: [{
    type: 'file', path: 'Procédures/relevé.xlsx', name: 'relevé.xlsx', ext: 'xlsx', size: 3, mtime: null, lock: null, local: null,
  }] });
  const shared = vi.spyOn(api, 'sharedFile');
  const upload = vi.spyOn(api, 'upload');
  const onAttached = vi.fn();
  const view = render(<AttachFromLinkedFolder entryId="e" title="Contrôle" project={project} onAttached={onAttached} />);
  fireEvent.click(screen.getByRole('button', { name: 'Joindre depuis le dossier lié à Contrôle' }));
  await screen.findByRole('button', { name: 'Joindre relevé.xlsx à Contrôle' });
  view.rerender(<AttachFromLinkedFolder entryId="e" title="Contrôle" project={{ ...project, shared_dir: 'Autre dossier' }} onAttached={onAttached} />);
  fireEvent.click(screen.getByRole('button', { name: 'Joindre relevé.xlsx à Contrôle' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('hors du dossier lié au projet');
  expect(shared).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(onAttached).not.toHaveBeenCalled();
});
