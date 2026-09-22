import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GoogleDriveWeb } from './GoogleDriveWeb';
import { api } from '../lib';
import { localApi, setLocalDatabase } from '../store/localApi';
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
    render(<GoogleDriveWeb onOpen={() => {}} />);
    await user.type(screen.getByLabelText('Identifiant client Google Web'), 'n’importe quoi');
    await user.click(screen.getByRole('button', { name: 'Enregistrer l’identifiant' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Identifiant client Google invalide');
    await user.clear(screen.getByLabelText('Identifiant client Google Web'));
    await user.type(screen.getByLabelText('Identifiant client Google Web'), CLIENT);
    await user.type(screen.getByLabelText('Secret client Google Web'), 'secret-abc');
    await user.click(screen.getByRole('button', { name: 'Enregistrer l’identifiant' }));
    expect(await screen.findByRole('button', { name: 'Se connecter avec Google' })).toBeInTheDocument();
  });

  test('client intégré : bouton unique, client personnel replié', async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', CLIENT);
    try {
      render(<GoogleDriveWeb onOpen={() => {}} />);
      expect(screen.getByRole('button', { name: 'Se connecter avec Google' })).toBeVisible();
      expect(screen.getByText(/Sans connexion, tout reste sur cet appareil/)).toBeVisible();
      expect(screen.getByText('Utiliser mon propre client OAuth')).toBeVisible();
      expect(screen.getByLabelText('Identifiant client Google Web')).not.toBeVisible();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('retour « jeton » : compte affiché, puis reprise proposée quand la session expire', async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', CLIENT);
    try {
      sessionStorage.setItem('worklogs-google-web-pending', JSON.stringify({ state: 's', redirectUri: 'http://localhost:3000/' }));
      vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [] });
      vi.stubGlobal('fetch', async (url: unknown) => {
        const target = String(url);
        if (target.endsWith('/userinfo')) return Response.json({ email: 'timo@example.com', name: 'Timo' });
        if (target.includes('/drive/v3/files?')) return new Response('{}', { status: 401 });
        throw new Error(`appel inattendu : ${target}`);
      });
      window.history.replaceState(null, '', '/#access_token=jeton&expires_in=3599&state=s');
      render(<GoogleDriveWeb onOpen={() => {}} />);
      expect(await screen.findByLabelText('Compte Google connecté')).toHaveTextContent('Connecté : Timo · timo@example.com');
      expect(window.location.hash).toBe('');
      // Le premier appel Drive tombe sur un jeton refusé : reprise en un clic.
      expect(await screen.findByRole('button', { name: 'Reprendre la session Google' })).toBeVisible();
      expect(screen.getByLabelText('Compte Google connecté')).toHaveTextContent('timo@example.com');
    } finally {
      vi.unstubAllEnvs();
    }
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
    render(<GoogleDriveWeb onOpen={() => {}} onRestored={onRestored} />);
    expect(await screen.findByText(/Google Drive connecté/)).toBeInTheDocument();
    expect(await screen.findByText('WorkLogs backup.json')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Charger' }));
    expect(await screen.findByText(/Sauvegarde chargée : 1 entrée\(s\)/)).toBeInTheDocument();
    expect(onRestored).toHaveBeenCalled();
  });

  test('envoi : photo puis boîte mobile, file vidée', async () => {
    const user = userEvent.setup();
    const { disconnectWeb } = await import('../store/google-web');
    disconnectWeb();
    localStorage.setItem('worklogs-google-web-client', CLIENT);
    localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({ access_token: 'acces', expires_at: Date.now() + 3600_000 }));
    const entry = await localApi.createEntry({ title: 'Mobile' });
    await localApi.upload(new File(['pixels'], 'photo.jpg', { type: 'image/jpeg' }), entry.id);

    const uploaded: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const body = await ((init?.body as Blob).text());
      uploaded.push({ url: String(url), body });
      return Response.json({ id: `drive-${uploaded.length}` });
    });
    render(<GoogleDriveWeb onOpen={() => {}} />);
    expect(await screen.findByText(/2 modification\(s\) en attente/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Envoyer vers Drive' }));
    expect(await screen.findByText(/Boîte envoyée dans Google Drive/)).toBeInTheDocument();
    expect(uploaded).toHaveLength(2);
    expect(uploaded[0].body).toContain('pixels');
    expect(uploaded[0].body).toContain('"worklogs_type":"attachment"');
    expect(uploaded[1].body).toContain('"worklogs_type":"outbox"');
    expect(uploaded[1].body).toContain('Mobile');
    expect(uploaded[1].body).toContain('"driveFileId":"drive-1"');
    expect(await screen.findByText(/Rien à envoyer/)).toBeInTheDocument();
  });

  test('sauvegarder synchronise : la base locale part avec ses suppressions, la liste s’actualise', async () => {
    const user = userEvent.setup();
    const { disconnectWeb } = await import('../store/google-web');
    disconnectWeb();
    localStorage.setItem('worklogs-google-web-client', CLIENT);
    localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({ access_token: 'acces', expires_at: Date.now() + 3600_000 }));
    await localApi.createEntry({ title: 'Note locale' });
    const uploaded: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/upload/')) {
        uploaded.push(await ((init?.body as Blob).text()));
        return Response.json({ id: 'canon', name: 'WorkLogs backup.json', modifiedTime: '2026-09-22T10:00:00.000Z' });
      }
      // Pas encore de fichier canonique : la synchro le crée.
      return Response.json({ files: uploaded.length ? [{ id: 'canon', name: 'WorkLogs backup.json', mimeType: 'application/json', modifiedTime: '2026-09-22T10:00:00.000Z' }] : [] });
    });
    render(<GoogleDriveWeb onOpen={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Sauvegarder dans Google Drive' }));
    expect(await screen.findByText(/Synchronisé avec Google Drive/)).toBeInTheDocument();
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toContain('"worklogs_type":"backup"');
    expect(uploaded[0]).toContain('Note locale');
    expect(uploaded[0]).toContain('"deleted":[');
    expect(await screen.findByText('WorkLogs backup.json')).toBeInTheDocument();
  });

  test('importer un fichier JSON restaure la base, fichier illisible refusé', async () => {
    const user = userEvent.setup();
    void user;
    localStorage.setItem('worklogs-google-web-client', CLIENT);
    localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({ access_token: 'acces', expires_at: Date.now() + 3600_000 }));
    vi.spyOn(api, 'googleDocuments').mockResolvedValue({ files: [] });
    const onRestored = vi.fn();
    render(<GoogleDriveWeb onOpen={() => {}} onRestored={onRestored} />);
    // L'input est masqué (display:none) : on renseigne les fichiers directement.
    const input = await screen.findByLabelText('Importer une sauvegarde JSON');
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(BACKUP)], 'sauvegarde.json', { type: 'application/json' })] } });
    expect(await screen.findByText(/Sauvegarde importée : 1 entrée\(s\), 0 tâche\(s\)/)).toBeInTheDocument();
    expect(onRestored).toHaveBeenCalled();
    expect((await localApi.state()).entries.map((e) => e.title)).toContain('Devis distant');

    fireEvent.change(input, { target: { files: [new File(['{pas du json'], 'cassé.json', { type: 'application/json' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('illisible');
  });
});
