import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GoogleDrive } from './components/GoogleDrive';
import { EntryEditor } from './components/EntryEditor';
import { api, ApiError, emptyDocument, type Entry } from './lib';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.worklogsDesktop; });

beforeEach(() => {
  vi.spyOn(api, 'googleBackups').mockResolvedValue({ files: [] });
});

const connected = { available: true, configured: true, connected: true, pending: false, error: '', selectedIds: [] };
const entry: Entry = { id: 'en_google', title: 'Document partagé', content_md: 'Original', content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original' }] }] },
  entry_date: '2026-09-14', project_id: null, created_at: '', updated_at: '', attachments: [], google_sync: { document_id: 'doc-1', synced_at: '', dirty: true } };

function integratedBridge() {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const bridge = { open: vi.fn().mockResolvedValue({ phase: 'signin', message: 'Connecte ton compte Google dans la zone ci-dessous.' }),
    bounds: vi.fn(), hide: vi.fn(), close: vi.fn().mockResolvedValue(true), reload: vi.fn().mockResolvedValue(undefined), print: vi.fn().mockResolvedValue(undefined), onState: vi.fn(() => () => {}) };
  window.worklogsDesktop = { onBeforeClose: () => () => {}, googleDocs: bridge };
  return bridge;
}

test('ouvre automatiquement l’éditeur Google dans WorkLogs et actualise la copie locale au retour', async () => {
  const bridge = integratedBridge();
  const pull = vi.spyOn(api, 'openGoogleDocument').mockResolvedValue({ ...entry, content_md: 'Depuis Google',
    content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Depuis Google' }] }] }, google_sync: { ...entry.google_sync!, dirty: false } });
  render(<EntryEditor entry={{ ...entry, google_sync: { ...entry.google_sync!, dirty: false, tab_id: 't.2' } }} projects={[]} onChanged={() => {}} onDeleted={() => {}} />);
  await waitFor(() => expect(bridge.open).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc-1', tabId: 't.2' })));
  expect(screen.queryByRole('textbox', { name: 'Contenu du document' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Ouvrir dans Google Docs/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Copie locale' }));
  await waitFor(() => expect(pull).toHaveBeenCalledWith('doc-1', 't.2'));
  expect(await screen.findByRole('textbox', { name: 'Contenu du document' })).toHaveTextContent('Depuis Google');
  expect(bridge.close).toHaveBeenCalledWith('doc-1');
  expect(bridge.hide).toHaveBeenCalled();
});

test('conserve le brouillon avant l’éditeur complet et bloque l’ouverture si la fusion échoue', async () => {
  const bridge = integratedBridge();
  const push = vi.spyOn(api, 'pushGoogleDocument').mockRejectedValue(new Error('Conflit du même passage.'));
  render(<EntryEditor entry={entry} projects={[]} onChanged={() => {}} onDeleted={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer le brouillon et ouvrir l’éditeur complet' }));
  expect(await screen.findByText('Conflit du même passage.')).toBeVisible();
  expect(bridge.open).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveTextContent('Original');
  push.mockResolvedValue({ ...entry, google_sync: { ...entry.google_sync!, dirty: false } });
  fireEvent.click(screen.getByRole('button', { name: 'Envoyer le brouillon et ouvrir l’éditeur complet' }));
  await waitFor(() => expect(bridge.open).toHaveBeenCalled());
});

test('un refus de quitter Google garde son éditeur et ne recharge aucune copie locale', async () => {
  const bridge = integratedBridge(); bridge.close.mockResolvedValue(false);
  const pull = vi.spyOn(api, 'pullGoogleDocument');
  render(<EntryEditor entry={{ ...entry, google_sync: { ...entry.google_sync!, dirty: false } }} projects={[]} onChanged={() => {}} onDeleted={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copie locale' }));
  await waitFor(() => expect(bridge.close).toHaveBeenCalled());
  expect(pull).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Éditeur Google Docs intégré')).toBeVisible();
});

test('rend le dialogue Drive au-dessus du layout via le body', async () => {
  vi.spyOn(api, 'googleStatus').mockResolvedValue({ ...connected, connected: false });
  render(<GoogleDrive onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Gérer Google Drive' }));
  const dialog = await screen.findByRole('dialog', { name: 'Gestion Google Drive' });
  expect(dialog.parentElement).toBe(document.body);
});

test('sauvegarde puis restaure la base depuis Google Drive', async () => {
  vi.spyOn(api, 'googleStatus').mockResolvedValue(connected);
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [] });
  const backup = { id: 'backup-1', name: 'WorkLogs backup.json', modifiedTime: '2026-09-17T10:00:00.000Z', size: 1234 };
  vi.spyOn(api, 'googleBackups').mockResolvedValue({ files: [backup] });
  const exportBackup = vi.spyOn(api, 'exportGoogleBackup').mockResolvedValue(backup);
  const importBackup = vi.spyOn(api, 'importGoogleBackup').mockResolvedValue({ ok: true, projects: 1, entries: 1, tasks: 1 });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const onRestored = vi.fn();
  render(<GoogleDrive onOpen={() => {}} onRestored={onRestored} />);
  fireEvent.click(screen.getByRole('button', { name: 'Gérer Google Drive' }));
  await screen.findByRole('button', { name: 'Sauvegarder dans Google Drive' });
  fireEvent.click(screen.getByRole('button', { name: 'Sauvegarder dans Google Drive' }));
  await waitFor(() => expect(exportBackup).toHaveBeenCalledOnce());
  expect(await screen.findByText(/Sauvegarde enregistrée/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Restaurer' }));
  await waitFor(() => expect(importBackup).toHaveBeenCalledWith('backup-1'));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('seront remplacés'));
  expect(onRestored).toHaveBeenCalledOnce();
});

test('ouvre un document autorisé dans WorkLogs puis permet de déconnecter Drive', async () => {
  vi.spyOn(api, 'googleStatus').mockResolvedValue(connected);
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [{ id: 'doc-1', name: 'Document partagé', modifiedTime: '' }] });
  vi.spyOn(api, 'googleDocumentTabs').mockResolvedValue({ tabs: [{ id: 't.0', title: 'Onglet 1', depth: 0 }] });
  const open = vi.spyOn(api, 'openGoogleDocument').mockResolvedValue(entry);
  const disconnect = vi.spyOn(api, 'disconnectGoogle').mockResolvedValue({ ...connected, connected: false });
  const onOpen = vi.fn();
  render(<GoogleDrive onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: 'Gérer Google Drive' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Gérer Google Drive' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Gérer Google Drive' }));
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

test('ouvre directement tous les onglets, y compris ceux signalés incompatibles par l’ancien convertisseur', async () => {
  vi.spyOn(api, 'googleStatus').mockResolvedValue(connected);
  vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [{ id: 'doc-1', name: 'Document partagé', modifiedTime: '' }] });
  const scan = vi.spyOn(api, 'googleDocumentTabs');
  const open = vi.spyOn(api, 'openGoogleDocument').mockResolvedValue(entry);
  const onOpen = vi.fn();
  render(<GoogleDrive onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: 'Gérer Google Drive' }));
  const file = await screen.findByRole('button', { name: 'Document partagé' });
  await waitFor(() => expect(file).toBeEnabled());
  fireEvent.click(file);
  await waitFor(() => expect(open).toHaveBeenCalledWith('doc-1'));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(entry));
  expect(scan).not.toHaveBeenCalled();
});

test('un envoi bloqué par Docs API propose son activation dans l’éditeur', async () => {
  const help = 'https://console.cloud.google.com/apis/library/docs.googleapis.com?project=1234';
  vi.spyOn(api, 'pushGoogleDocument').mockRejectedValue(new ApiError('API Docs désactivée', 'GOOGLE_API_DISABLED', help));
  render(<EntryEditor entry={entry} projects={[]} onChanged={() => {}} onDeleted={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer sur Drive' }));
  expect(await screen.findByRole('link', { name: 'Activer l’API dans Google Cloud' })).toHaveAttribute('href', help);
  expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveTextContent('Original');
});


test('affiche le contenu réconcilié avec Google après un envoi réussi', async () => {
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original et ajout distant' }] }] };
  vi.spyOn(api, 'pushGoogleDocument').mockResolvedValue({ ...entry, content_json: content, content_md: 'Original et ajout distant', google_sync: { ...entry.google_sync!, dirty: false } });
  render(<EntryEditor entry={entry} projects={[]} onChanged={() => {}} onDeleted={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer sur Drive' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveTextContent('Original et ajout distant'));
  expect(screen.getByText('À jour sur Google Drive')).toBeVisible();
});


test('termine la synchronisation avant de reprendre la saisie dans le document', async () => {
  let finish!: (value: Entry) => void;
  vi.spyOn(api, 'pushGoogleDocument').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<EntryEditor entry={entry} projects={[]} onChanged={() => {}} onDeleted={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer sur Drive' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveAttribute('contenteditable', 'false'));
  expect(screen.getByRole('button', { name: 'Gras' })).toBeDisabled();
  await waitFor(() => expect(finish).toBeDefined());
  finish({ ...entry, google_sync: { ...entry.google_sync!, dirty: false } });
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveAttribute('contenteditable', 'true'));
});

test('une copie locale inaccessible après Google reste récupérable avec un état honnête', async () => {
  integratedBridge();
  vi.spyOn(api, 'openGoogleDocument').mockRejectedValue(new Error('Connexion interrompue'));
  render(<EntryEditor entry={{ ...entry, google_sync: { ...entry.google_sync!, dirty: false } }} projects={[]} onChanged={() => {}} onDeleted={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copie locale' }));
  expect(await screen.findByRole('textbox', { name: 'Contenu du document' })).toHaveTextContent('Original');
  expect(screen.getByText('Copie locale à actualiser')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Connexion interrompue');
  expect(screen.queryByText('À jour sur Google Drive')).not.toBeInTheDocument();
});
