import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyChatSharedProcedure, prepareChatSharedProcedure, readChatShare, readChatSharedExcerpt, searchChatShare } from './ai-chat-shared';
import { AiCancelled } from './ai-suggest';
import { api, ApiError, type SharedClient, type SharedEntry, type SharedFile, type SharedListing, type SharedSearchResult, type SharedStatus } from './lib';
import { procedureFileBytes } from './new-files';
import { saveRelay } from './relay-settings';
import { readZip, readZipText } from './zip';

const address = '\\\\serveur\\partage';
const status: SharedStatus = { available: true, root: '/montage', address, reach: 'ok', displayName: 'Timo' };
const projectDir = `${address}\\Équipe`;
const word: SharedSearchResult = { name: 'Sauvegarde.docx', path: 'Équipe/Infra/Sauvegarde.docx', type: 'file', dir: 'Équipe/Infra', ext: 'docx' };
const folder: SharedSearchResult = { name: 'Infra', path: 'Équipe/Infra', type: 'dir', dir: 'Équipe', ext: '' };
const listed = ({ path, name, type, ext }: SharedSearchResult, size = 1024): SharedEntry => ({ path, name, type, ext, size: type === 'file' ? size : null, mtime: null, lock: null, local: null });
const listing = (dir = '', entries: SharedEntry[] = []): SharedListing => ({ dir, entries, reach: 'ok', truncated: false });
const seen = (file = word, size = 1024): SharedFile => ({
  path: file.path, name: file.name, ext: file.ext, size, mtime: null, hash: 'sur-le-serveur', base_hash: 'ancienne-version',
  state: 'pending', source: 'share', draft: { model: 'brouillon local', template_hash: 'brouillon', updated_at: null },
  send: { hash: 'envoi-local', requested: true }, note: '', theirs: null, lock: null,
});

function mockShare() {
  return {
    ...api,
    sharedStatus: vi.fn<SharedClient['sharedStatus']>().mockResolvedValue(status),
    searchShared: vi.fn<SharedClient['searchShared']>().mockImplementation(async (query, dir = '') => ({ query, dir, results: [word, folder], offline: false, partial: false, denied: 0 })),
    sharedList: vi.fn<SharedClient['sharedList']>().mockImplementation(async (dir = '') => listing(dir, dir === 'Équipe' ? [listed(folder)] : [listed(word)])),
    sharedFile: vi.fn<SharedClient['sharedFile']>().mockResolvedValue(seen()),
    sharedContent: vi.fn<SharedClient['sharedContent']>(),
    createShared: vi.fn<SharedClient['createShared']>().mockResolvedValue(seen()),
  };
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('procédures du partage dans l’assistant', () => {
  it('cherche des noms dans le dossier relié au projet, sans lire les documents', async () => {
    const client = mockShare();
    const share = await readChatShare(client, projectDir);
    const results = await searchChatShare(share, ['sauvegarde', 'infra', 'sauvegarde']);
    expect(client.searchShared.mock.calls).toEqual([['sauvegarde', 'Équipe'], ['infra', 'Équipe']]);
    expect(results).toEqual({ files: [word], directories: ['Équipe', 'Équipe/Infra'], notice: '' });
    expect(client.sharedFile).not.toHaveBeenCalled();
    expect(client.sharedContent).not.toHaveBeenCalled();
    expect(client.sharedList).not.toHaveBeenCalled();
  });

  it('garde les noms en cache hors ligne et écarte les destinations et les chemins hors périmètre', async () => {
    const client = mockShare();
    const outside = { ...word, path: 'Autre/Sauvegarde.docx', dir: 'Autre' };
    const traversal = { ...word, path: 'Équipe/../Autre/Sauvegarde.docx', dir: 'Équipe/../Autre' };
    client.sharedStatus.mockResolvedValue({ ...status, reach: 'offline' });
    client.searchShared.mockResolvedValue({ query: 'sauvegarde', dir: 'Équipe', results: [outside, traversal, word, folder], offline: true, partial: true, denied: 0 });
    const share = await readChatShare(client, projectDir);
    const results = await searchChatShare(share, ['sauvegarde']);
    expect(results.files).toEqual([word]);
    expect(results.directories).toEqual([]);
    expect(results.notice).toMatch(/hors ligne/);
    await expect(readChatSharedExcerpt(share, word)).rejects.toThrow(/hors ligne/);
    expect(client.sharedFile).not.toHaveBeenCalled();
    await expect(prepareFor(client, 'Autre')).rejects.toThrow(/hors ligne/);
  });

  it('dit qu’un partage non monté se reconnecte, au lieu de le dire hors ligne', async () => {
    const client = mockShare();
    client.sharedStatus.mockResolvedValue({ ...status, reach: 'unmounted' });
    client.searchShared.mockResolvedValue({ query: 'sauvegarde', dir: 'Équipe', results: [], offline: true, partial: true, denied: 0 });
    const share = await readChatShare(client, projectDir);
    const results = await searchChatShare(share, ['sauvegarde']);
    expect(results.notice).toMatch(/non monté.*« Se reconnecter »/);
    expect(results.notice).not.toMatch(/hors ligne/);
    await expect(readChatSharedExcerpt(share, word)).rejects.toThrow(/non monté/);
  });

  it('ne se rabat pas sur la racine quand le projet pointe vers un autre partage', async () => {
    const client = mockShare();
    const share = await readChatShare(client, '\\\\serveur\\ailleurs\\Équipe');
    const result = await searchChatShare(share, ['sauvegarde']);
    expect(result).toEqual({ files: [], directories: [], notice: expect.stringMatching(/en dehors/) });
    expect(client.searchShared).not.toHaveBeenCalled();
  });

  it('lit le Word indexé à partir de sa version distante, sans son brouillon ni sa base locale', async () => {
    const client = mockShare();
    const bytes = await procedureFileBytes('docx', { title: 'Sauvegarde', markdown: '## Étapes\n\n1. Vérifier le journal.', author: 'Timo' });
    client.sharedContent.mockResolvedValue(new Uint8Array(bytes));
    const share = await readChatShare(client, projectDir);
    await expect(readChatSharedExcerpt(share, word)).rejects.toThrow(/inconnu/);
    expect(client.sharedFile).not.toHaveBeenCalled();
    await searchChatShare(share, ['sauvegarde']);
    const excerpt = await readChatSharedExcerpt(share, word);
    expect(excerpt).toMatch(/Étapes[\s\S]*Vérifier le journal/);
    expect(client.sharedContent.mock.calls).toEqual([['sur-le-serveur']]);
  });

  it('borne les extraits texte et retire les balises et les destinations Markdown', async () => {
    const client = mockShare();
    const file = { ...word, name: 'Sauvegarde.md', path: 'Équipe/Infra/Sauvegarde.md', ext: 'md' };
    client.searchShared.mockResolvedValue({ query: 'sauvegarde', dir: 'Équipe', results: [file], offline: false, partial: false, denied: 0 });
    client.sharedList.mockResolvedValue(listing(file.dir, [listed(file)]));
    client.sharedFile.mockResolvedValue(seen(file));
    client.sharedContent.mockResolvedValue(new TextEncoder().encode('<img src="https://interne/secret">[Journal](https://interne/lien)\n' + 'x'.repeat(5000)));
    const share = await readChatShare(client, projectDir);
    await searchChatShare(share, ['sauvegarde']);
    const excerpt = await readChatSharedExcerpt(share, file);
    expect(excerpt).toMatch(/^Journal\nx+…$/);
    expect(excerpt).toHaveLength(3000);
    client.sharedList.mockResolvedValue(listing(file.dir, [listed(file, 1024 * 1024)]));
    client.sharedFile.mockClear();
    await expect(readChatSharedExcerpt(share, file)).rejects.toThrow(/volumineux/);
    expect(client.sharedFile).not.toHaveBeenCalled();
  });

  it('ne transmet pas les détails internes d’une erreur du partage', async () => {
    const client = mockShare();
    client.sharedFile.mockRejectedValue(new ApiError('Échec EIO dans /chemin/confidentiel.', 'SHARED_ERROR'));
    const share = await readChatShare(client, projectDir);
    await searchChatShare(share, ['sauvegarde']);
    await expect(readChatSharedExcerpt(share, word)).rejects.toThrow(/^Lecture indisponible sur le dossier partagé\.$/);
  });

  it('libère immédiatement une recherche arrêtée par l’utilisateur', async () => {
    const client = mockShare();
    client.searchShared.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const share = await readChatShare(client);
    const result = searchChatShare(share, ['sauvegarde', 'infra'], controller.signal);
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(AiCancelled);
    expect(client.searchShared).toHaveBeenCalledOnce();
  });

  async function prepareFor(client: SharedClient, title = 'Sauvegarde') {
    const share = await readChatShare(client, projectDir);
    const { directories } = await searchChatShare(share, []);
    return prepareChatSharedProcedure(share, directories, { title, content: '## Étapes\n\n1. Vérifier le journal.', directory: 2 });
  }

  it('produit un vrai Word avec l’auteur du partage et le crée exclusivement après validation', async () => {
    const client = mockShare();
    const proposal = await prepareFor(client, 'Sauvegarde.docx');
    expect(proposal).toMatchObject({ kind: 'create_shared_procedure', path: word.path, content_md: expect.stringContaining('Vérifier le journal') });
    expect(client.createShared).not.toHaveBeenCalled();
    await applyChatSharedProcedure(client, proposal);
    expect(client.createShared).toHaveBeenCalledOnce();
    const [path, bytes] = client.createShared.mock.calls[0];
    expect(path).toBe(word.path);
    expect(await readZipText(readZip(bytes), 'word/document.xml')).toContain('Vérifier le journal');
    expect(await readZipText(readZip(bytes), 'docProps/core.xml')).toContain('<dc:creator>Timo</dc:creator>');
  });

  it('écarte les chemins inventés, les mauvais indices, les noms réservés, les images et le HTML', async () => {
    const client = mockShare();
    const share = await readChatShare(client, projectDir);
    const { directories } = await searchChatShare(share, []);
    for (const title of ['../Sauvegarde', 'CON', 'A/B', '~$brouillon']) {
      expect(() => prepareChatSharedProcedure(share, directories, { title, content: 'Vérifier le journal.' })).toThrow();
    }
    for (const content of ['<iframe src="https://autre"></iframe>', '![image](https://autre/image.png)', '']) {
      expect(() => prepareChatSharedProcedure(share, directories, { title: 'Sauvegarde', content })).toThrow(/Contenu de procédure invalide/);
    }
    for (const directory of [3, 'Équipe/Infra', 0, null]) {
      expect(() => prepareChatSharedProcedure(share, directories, { title: 'Sauvegarde', content: 'Vérifier.', directory })).toThrow(/destination inconnu/);
    }
    expect(() => prepareChatSharedProcedure(share, ['Équipe/Inventé'], { title: 'Sauvegarde', content: 'Vérifier.' })).toThrow(/destination inconnu/);
    expect(client.createShared).not.toHaveBeenCalled();
  });

  it('ne renvoie rien vers un montage modifié et remonte le conflit de nom sans écrasement', async () => {
    const client = mockShare();
    const proposal = await prepareFor(client);
    client.sharedStatus.mockResolvedValue({ ...status, root: '/autre-montage' });
    await expect(applyChatSharedProcedure(client, proposal)).rejects.toThrow(/a changé/);
    expect(client.createShared).not.toHaveBeenCalled();
    client.sharedStatus.mockResolvedValue(status);
    client.createShared.mockRejectedValue(new ApiError('Ce nom existe déjà.', 'SHARED_EXISTS'));
    await expect(applyChatSharedProcedure(client, proposal)).rejects.toThrow(/existe déjà/);
    expect(client.createShared).toHaveBeenCalledOnce();
    expect(client.sharedFile).not.toHaveBeenCalled();
  });

  it('réconcilie une réponse perdue en vérifiant les octets écrits avant de rejouer', async () => {
    const client = mockShare();
    const proposal = await prepareFor(client);
    client.createShared.mockImplementation(async (_path, bytes) => {
      client.sharedFile.mockRejectedValueOnce(new TypeError('réseau indisponible')).mockResolvedValue(seen(word, bytes.length));
      client.sharedContent.mockResolvedValue(new Uint8Array(bytes));
      throw new TypeError('réponse perdue');
    });
    await expect(applyChatSharedProcedure(client, proposal)).rejects.toThrow(/Impossible de vérifier/);
    await expect(applyChatSharedProcedure(client, proposal)).resolves.toBeUndefined();
    expect(client.createShared).toHaveBeenCalledOnce();
  });

  it('reconnaît la première création quand elle finit pendant le nouvel essai', async () => {
    const client = mockShare();
    const proposal = await prepareFor(client);
    const missing = new ApiError('Fichier absent.', 'SHARED_NOT_FOUND');
    client.sharedFile.mockRejectedValueOnce(missing).mockRejectedValueOnce(missing);
    client.createShared.mockRejectedValueOnce(new TypeError('réponse perdue'));
    client.createShared.mockImplementationOnce(async (_path, bytes) => {
      expect(bytes).toEqual(client.createShared.mock.calls[0][1]);
      client.sharedFile.mockResolvedValue(seen(word, bytes.length));
      client.sharedContent.mockResolvedValue(new Uint8Array(bytes));
      throw new ApiError('Ce nom existe déjà.', 'SHARED_EXISTS');
    });
    await expect(applyChatSharedProcedure(client, proposal)).rejects.toThrow(/n’a pas pu être confirmée/);
    await expect(applyChatSharedProcedure(client, proposal)).resolves.toBeUndefined();
  });

  it('fige le relais des lectures et refuse de publier si le réglage du relais a changé', async () => {
    vi.stubEnv('VITE_PWA', '1');
    const before = 'https://avant.example';
    const after = 'https://apres.example';
    saveRelay({ url: before });
    const fetch = vi.fn(async (url: string) => Response.json(url.includes('/status') ? status : listing('Équipe', [listed(folder)])));
    vi.stubGlobal('fetch', fetch);
    const share = await readChatShare(api, projectDir);
    saveRelay({ url: after });
    const { directories } = await searchChatShare(share, []);
    const proposal = prepareChatSharedProcedure(share, directories, { title: 'Sauvegarde', content: 'Vérifier.', directory: 2 });
    await expect(applyChatSharedProcedure(api, proposal)).rejects.toThrow(/a changé/);
    expect(fetch.mock.calls.map(([url]) => new URL(url).origin)).toEqual([before, before]);
  });

  it('retrouve une procédure puis écrit un Word via les vraies routes du relais', async () => {
    const [fs, os, path] = await Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
    // @ts-expect-error — serveur Node chargé par les tests.
    const { startRelay } = await import('../../api/src/relay.js');
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-chat-relais-'));
    const root = path.join(workdir, 'partage');
    fs.mkdirSync(path.join(root, 'Infra'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Infra', 'Sauvegarde.md'), '# Sauvegarde\n\nContrôler le journal.');
    const relay = startRelay({ root, origins: [], dataDir: path.join(workdir, 'data'), host: '127.0.0.1', port: 0 });
    try {
      await new Promise((resolve) => relay.server.once('listening', resolve));
      vi.stubEnv('VITE_PWA', '1');
      saveRelay({ url: `http://127.0.0.1:${relay.server.address().port}` });
      const share = await readChatShare(api);
      const { files, directories } = await searchChatShare(share, ['sauvegarde']);
      expect(files.map(({ path }) => path)).toEqual(['Infra/Sauvegarde.md']);
      expect(await readChatSharedExcerpt(share, files[0])).toContain('Contrôler le journal.');
      const proposal = prepareChatSharedProcedure(share, directories, { title: 'Contrôle de sauvegarde', content: '1. Contrôler le journal.', directory: 2 });
      await applyChatSharedProcedure(api, proposal);
      const bytes = fs.readFileSync(path.join(root, 'Infra', 'Contrôle de sauvegarde.docx'));
      expect(await readZipText(readZip(bytes), 'word/document.xml')).toContain('Contrôler le journal.');
    } finally {
      await relay.stop();
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }, 45_000);
});
