import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flushPendingSaves } from './autosave';

// Backend local AVANT tout import d'écran : la sélection dans `lib.ts` se fait
// à l'évaluation du module. Fichier séparé d'`App.test.tsx` (un worker = un
// module `lib`, donc un seul backend par fichier de test).
vi.stubEnv('VITE_PWA', '1');
const { default: App } = await import('./App');
const { localApi, setLocalDatabase } = await import('./store/localApi');
const { createMemoryDatabase } = await import('./store/storage');

beforeEach(() => {
  setLocalDatabase(createMemoryDatabase());
  localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(async () => {
  await flushPendingSaves();
  vi.restoreAllMocks();
});

const journal = () => screen.getByRole('region', { name: 'Journal' });
const board = () => screen.getByRole('region', { name: 'Tâches' });
const editor = () => screen.getByRole('region', { name: 'Entrée' });

describe('PWA locale (mêmes écrans, backend IndexedDB/mémoire)', () => {
  test('l’amorçage local affiche le mode d’emploi et les trois tâches', async () => {
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    expect(await within(journal()).findByText('Comment ça marche')).toBeInTheDocument();
    expect(await within(board()).findByText('Écrire ma première entrée')).toBeInTheDocument();
    expect(await within(board()).findByText('Prendre en main WorkLogs')).toBeInTheDocument();
    expect((await localApi.state()).stats.entries).toBe(1);
  });

  test('créer une entrée et une tâche depuis l’interface, sans serveur', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });

    await user.click(screen.getByRole('button', { name: /Nouvelle entrée/ }));
    expect(await screen.findByLabelText('Titre de l’entrée')).toHaveValue('Sans titre');
    await user.clear(screen.getByLabelText('Titre de l’entrée'));
    await user.type(screen.getByLabelText('Titre de l’entrée'), 'Marché fermier');
    await waitFor(() => expect(screen.getByText('Enregistré')).toBeInTheDocument());
    expect(await within(journal()).findByText('Marché fermier')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Nouvelle tâche'), 'Acheter des plants{Enter}');
    expect(await within(board()).findByText('Acheter des plants')).toBeInTheDocument();
    expect((await localApi.state()).stats.entries).toBe(2);
  });

  test('Exporter télécharge le JSON local', async () => {
    const user = userEvent.setup();
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    await user.click(screen.getByRole('button', { name: 'Exporter' }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(created.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(editor()).toBeInTheDocument();
  });

  test('document Google multi-onglets : une ligne au journal, navigation entre onglets', async () => {
    const user = userEvent.setup();
    const { importLocalBackup } = await import('./store/localApi');
    const T = '2026-09-18T10:00:00.000Z';
    const rich = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    await importLocalBackup({
      version: 2,
      projects: [],
      entries: ['A', 'B'].map((tab) => ({
        id: `en_${tab}`, title: `Doc multi — ${tab}`, content_md: `Contenu ${tab}`, content_json: rich(`Contenu ${tab}`),
        entry_date: '2026-09-18', project_id: null, created_at: T, updated_at: T,
      })),
      tasks: [],
      task_entries: [],
      google_documents: ['A', 'B'].map((tab, order) => ({
        entry_id: `en_${tab}`, document_id: 'gdoc-multi', tab_id: `tab-${tab}`, revision_id: 'r1',
        synced_content_json: JSON.stringify(rich(`Contenu ${tab}`)), synced_at: T,
        document_title: 'Doc multi', tab_title: `Onglet ${tab}`, tab_order: order, tab_depth: 0, readonly_reason: '',
      })),
      attachments: [],
    });
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    // Une seule ligne pour les deux onglets, comme sur desktop.
    expect(await within(journal()).findByText('Doc multi')).toBeInTheDocument();
    expect(within(journal()).queryByText('Doc multi — A')).not.toBeInTheDocument();
    await user.click(within(journal()).getByText('Doc multi'));
    expect(await screen.findByRole('tab', { name: 'Onglet A' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Onglet B' }));
    expect(await screen.findByText('Contenu B')).toBeInTheDocument();
  });

  test('panneaux repliables disponibles sur mobile', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    await user.click(screen.getByRole('button', { name: 'Tâches' }));
    expect(document.querySelector('.columns')).toHaveClass('hide-right');
    expect(editor()).toBeInTheDocument();
  });

  test('retour de Google refusé : l’erreur s’affiche au lieu d’un « Non connecté » muet', async () => {
    localStorage.setItem('worklogs-google-web-client', '123456789012-abc.apps.googleusercontent.com');
    sessionStorage.setItem('worklogs-google-web-pending', JSON.stringify({ state: 's', verifier: 'v', redirectUri: 'http://localhost:3000/' }));
    // Ce que Google répond à un client « Web » sans secret (mesuré le 2026-09-23).
    vi.stubGlobal('fetch', async () => Response.json({ error: 'invalid_request', error_description: 'client_secret is missing.' }, { status: 400 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.history.replaceState(null, '', '/?code=code&state=s');
    try {
      render(<App />);
      await screen.findByRole('region', { name: 'Journal' });
      expect(await screen.findByText(/Google a refusé la connexion/)).toBeInTheDocument();
      expect(window.location.search).toBe('');
    } finally {
      vi.unstubAllGlobals();
      sessionStorage.clear();
    }
  });
});
