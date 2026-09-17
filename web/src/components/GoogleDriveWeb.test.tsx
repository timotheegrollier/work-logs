import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GoogleDriveWeb } from './GoogleDriveWeb';
import { setLocalDatabase } from '../store/localApi';
import { createMemoryDatabase } from '../store/storage';

const CLIENT = '123456789012-abc.apps.googleusercontent.com';
const BACKUP = {
  version: 2,
  exported_at: '2026-09-18T10:00:00.000Z',
  projects: [{ id: 'pr_1', name: 'Chantier', color: '#fff', created_at: '2026-09-18T10:00:00.000Z' }],
  entries: [{ id: 'en_1', title: 'Devis distant', content_md: 'corps', content_json: null, entry_date: '2026-09-18', project_id: 'pr_1', created_at: '2026-09-18T10:00:00.000Z', updated_at: '2026-09-18T10:00:00.000Z' }],
  tasks: [],
  task_entries: [],
  google_documents: [],
  attachments: [],
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  setLocalDatabase(createMemoryDatabase());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('panneau Drive de la PWA', () => {
  test('identifiant invalide refusé, valide enregistré', async () => {
    const user = userEvent.setup();
    render(<GoogleDriveWeb />);
    await user.type(screen.getByLabelText('Identifiant client Google Web'), 'n’importe quoi');
    await user.click(screen.getByRole('button', { name: 'Enregistrer l’identifiant' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Identifiant client Google invalide');
    await user.clear(screen.getByLabelText('Identifiant client Google Web'));
    await user.type(screen.getByLabelText('Identifiant client Google Web'), CLIENT);
    await user.click(screen.getByRole('button', { name: 'Enregistrer l’identifiant' }));
    expect(await screen.findByRole('button', { name: 'Connecter Google Drive' })).toBeInTheDocument();
  });

  test('retour OAuth échangé puis sauvegardes listées et chargées', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-google-web-client', CLIENT);
    sessionStorage.setItem(
      'worklogs-google-web-pending',
      JSON.stringify({ state: 's', verifier: 'v', redirectUri: 'http://localhost:3000/' })
    );
    // Échange du code : Google répond avec un jeton, puis Drive liste et envoie.
    vi.stubGlobal(
      'fetch',
      async (url: unknown) => {
        const target = String(url);
        if (target.endsWith('/token')) {
          return Response.json({ access_token: 'acces', refresh_token: 'r', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' });
        }
        if (target.includes('/drive/v3/files?')) {
          return Response.json({ files: [{ id: 'b1', name: 'WorkLogs backup.json', modifiedTime: '2026-09-18T10:00:00.000Z', size: '42', mimeType: 'application/json' }] });
        }
        if (target.includes('alt=media')) return new Response(JSON.stringify(BACKUP));
        throw new Error(`appel inattendu : ${target}`);
      }
    );
    window.history.replaceState(null, '', '/?code=code&state=s');
    const onRestored = vi.fn();
    render(<GoogleDriveWeb onRestored={onRestored} />);
    expect(await screen.findByText(/Google Drive connecté/)).toBeInTheDocument();
    expect(await screen.findByText('WorkLogs backup.json')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Charger' }));
    expect(await screen.findByText(/Sauvegarde chargée : 1 entrée\(s\)/)).toBeInTheDocument();
    expect(onRestored).toHaveBeenCalled();
  });
});
