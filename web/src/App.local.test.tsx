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
});
