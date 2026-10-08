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

describe('dossier partagé dans la PWA', () => {
  test('absent : un navigateur n’atteint pas un partage SMB, même avec un chemin retenu', async () => {
    localStorage.setItem('worklogs-shared-path', 'notes.md');
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    expect(screen.queryByText('Dossier partagé')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument();
    expect(await localApi.sharedStatus()).toEqual({ available: false });
    await expect(localApi.sharedList('')).rejects.toThrow('application desktop');
  });

  // Vrai relais : serveur HTTP, puis worker du partage démarré à la première liste
  // (borné à 10 s dans `shared-io`). Sous charge, un aller-retour dépasse la seconde
  // des `findBy` : les attentes du relais ont 10 s, le test 30 s. Requêtes limitées
  // à la région concernée — `getByRole` sur tout l'écran coûte cher dans jsdom.
  test('par le relais du bureau : réglé dans Paramètres, le dossier s’ouvre, un fichier s’édite et s’envoie', async () => {
    const relais = { timeout: 10_000 };
    const [fs, os, path] = await Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
    // @ts-expect-error — relay.js est du JavaScript pur de l'API, chargé par Node.
    const { startRelay, newToken } = await import('../../api/src/relay.js');
    const share = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-pwa-relais-'));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-pwa-relais-data-'));
    fs.mkdirSync(path.join(share, '2. TSE'));
    fs.writeFileSync(path.join(share, '2. TSE', 'Redémarrage.md'), '# Redémarrage\n');
    const token = newToken();
    const relay = startRelay({ root: share, token, origins: [], dataDir: data, host: '127.0.0.1', port: 0, displayName: 'Timothée (mobile)' });
    await new Promise((resolve) => relay.server.once('listening', resolve));
    try {
      localStorage.setItem('worklogs-show-procedures', '1');
      const user = userEvent.setup();
      render(<App />);
      await screen.findByRole('region', { name: 'Journal' });
      expect(screen.queryByText('Dossier partagé')).not.toBeInTheDocument();

      await user.click(await screen.findByRole('button', { name: 'Compte et paramètres' }));
      await user.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Paramètres' }));
      const settings = within(dialog.getByRole('region', { name: 'Dossier partagé du TSE' }));
      // Collés, comme l'adresse et le code donnés à l'installation du relais.
      await user.click(settings.getByLabelText('Adresse du relais'));
      await user.paste(`http://127.0.0.1:${relay.server.address().port}`);
      await user.click(settings.getByLabelText('Code d’accès du relais'));
      await user.paste(token);
      await user.click(settings.getByRole('button', { name: 'Enregistrer' }));
      expect(await settings.findByText(/^Relié au dossier partagé/, undefined, relais)).toBeInTheDocument();
      await user.click(dialog.getByRole('button', { name: 'Fermer' }));

      const tree = within(await screen.findByRole('list', { name: 'Contenu du dossier partagé' }, relais));
      await user.click(tree.getByRole('button', { name: 'Dossier 2. TSE' }));
      const folder = within(await tree.findByRole('list', { name: 'Contenu de 2. TSE' }, relais));
      await user.click(folder.getByRole('button', { name: /^Ouvrir Redémarrage\.md/ }));
      const shared = within(await screen.findByRole('region', { name: 'Fichier partagé' }, relais));
      const area = await shared.findByLabelText('Contenu de Redémarrage.md', undefined, relais);
      expect(area).toHaveValue('# Redémarrage\n');
      await user.type(area, 'Redémarrer le service.{Enter}');
      await user.click(shared.getByRole('button', { name: 'Enregistrer sur le partage' }));
      await waitFor(() => expect(fs.readFileSync(path.join(share, '2. TSE', 'Redémarrage.md'), 'utf8')).toBe('# Redémarrage\nRedémarrer le service.\n'), relais);
      expect(await shared.findByText('Enregistré sur le partage.', undefined, relais)).toBeInTheDocument();
    } finally {
      await relay.stop();
      fs.rmSync(share, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    }
  }, 30_000);

  test('adresse du relais : HTTPS exigé, complétée si on l’oublie', async () => {
    const { normalizeRelayUrl } = await import('./relay-settings');
    expect(normalizeRelayUrl('relais.tailnet.ts.net/')).toBe('https://relais.tailnet.ts.net');
    expect(normalizeRelayUrl('https://relais.tailnet.ts.net:8443')).toBe('https://relais.tailnet.ts.net:8443');
    expect(() => normalizeRelayUrl('http://172.16.1.203')).toThrow('HTTPS');
    expect(normalizeRelayUrl('http://127.0.0.1:8420')).toBe('http://127.0.0.1:8420');
    expect(() => normalizeRelayUrl('  ')).toThrow('adresse du relais');
  });
});
