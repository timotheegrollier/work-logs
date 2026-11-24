import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { SharedFile } from '../lib';
import { saveRelay } from '../relay-settings';
import { localApi, setLocalDatabase } from './localApi';
import { createMemoryDatabase } from './storage';
import {
  SHARED_COPIES_SCHEMA,
  keepSharedBytes,
  keepSharedFile,
  setSharedCopiesDatabase,
  sharedBytesCopy,
  sharedFileCopy,
  sharedListingCopy,
} from './shared-copies';

function sharedFile(path: string, hash: string, extra: Partial<SharedFile> = {}): SharedFile {
  return {
    path, name: path.split('/').pop() ?? path, ext: '.md', hash, size: 4, mtime: null, base_hash: null, draft: null,
    state: null, note: '', theirs: null, send: { hash: null, requested: false }, lock: null, source: 'share', ...extra,
  } as unknown as SharedFile;
}

beforeEach(() => {
  setLocalDatabase(createMemoryDatabase());
  setSharedCopiesDatabase(createMemoryDatabase(SHARED_COPIES_SCHEMA.stores));
  localStorage.clear();
});
afterEach(() => setSharedCopiesDatabase(null));

describe('copies du dossier partagé', () => {
  test('la fiche et les octets d’une version se retrouvent par chemin et par empreinte', async () => {
    await keepSharedFile(sharedFile('2. TSE/Procédure.md', 'h1'));
    await keepSharedBytes('h1', new TextEncoder().encode('# Procédure'));
    expect((await sharedFileCopy('2. TSE/Procédure.md'))?.hash).toBe('h1');
    expect(new TextDecoder().decode(await sharedBytesCopy('h1'))).toBe('# Procédure');
    expect(await sharedFileCopy('ailleurs.md')).toBeUndefined();
  });

  test('une nouvelle version remplace la fiche et libère l’ancienne version', async () => {
    await keepSharedFile(sharedFile('a.md', 'v1'));
    await keepSharedBytes('v1', new Uint8Array([1]));
    await keepSharedFile(sharedFile('a.md', 'v2'));
    expect(await sharedBytesCopy('v1')).toBeUndefined();
    expect((await sharedFileCopy('a.md'))?.hash).toBe('v2');
  });

  test('la liste hors ligne reconstruit les dossiers et signale les fichiers sans octets', async () => {
    await keepSharedFile(sharedFile('2. TSE/Procédure.md', 'h1'));
    await keepSharedBytes('h1', new TextEncoder().encode('# Procédure'));
    await keepSharedFile(sharedFile('2. TSE/Sans octets.md', 'h2'));
    await keepSharedFile(sharedFile('2. TSE/Archives/vieux.md', 'h3'));
    const root = await sharedListingCopy('');
    expect(root.entries).toEqual([expect.objectContaining({ name: '2. TSE', type: 'dir' })]);
    const listing = await sharedListingCopy('2. TSE');
    expect(listing.listed_at).toBeTruthy();
    expect(listing.entries).toEqual([
      expect.objectContaining({ name: 'Archives', type: 'dir' }),
      expect.objectContaining({ name: 'Procédure.md', type: 'file', cached: true, unavailable: false }),
      expect.objectContaining({ name: 'Sans octets.md', type: 'file', unavailable: true }),
    ]);
  });

  test('au-delà de 200 fichiers, les plus anciennement vus partent avec leurs octets', async () => {
    await keepSharedFile(sharedFile('vieux.md', 'old'));
    await keepSharedBytes('old', new Uint8Array([9]));
    for (let i = 0; i < 200; i += 1) await keepSharedFile(sharedFile(`f${i}.md`, `h${i}`));
    expect(await sharedFileCopy('vieux.md')).toBeUndefined();
    expect(await sharedBytesCopy('old')).toBeUndefined();
    expect(await sharedFileCopy('f199.md')).toBeDefined();
  });
});

describe('lecture hors ligne du dossier partagé (PWA)', () => {
  // Vrai relais, comme dans App.local.test.tsx : ouvert une fois, lisible relais coupé.
  test('un fichier ouvert une fois reste lisible quand le relais ne répond plus', async () => {
    const [fs, os, path] = await Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
    // @ts-expect-error — relay.js est du JavaScript pur de l'API, chargé par Node.
    const { startRelay } = await import('../../../api/src/relay.js');
    const share = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-copies-'));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-copies-data-'));
    fs.mkdirSync(path.join(share, '2. TSE'));
    fs.writeFileSync(path.join(share, '2. TSE', 'Redémarrage.md'), '# Redémarrage\n');
    const relay = startRelay({ root: share, origins: [], dataDir: data, host: '127.0.0.1', port: 0, displayName: 'Test' });
    await new Promise((resolve) => relay.server.once('listening', resolve));
    try {
      saveRelay({ url: `http://127.0.0.1:${relay.server.address().port}` });
      const online = await localApi.sharedFile('2. TSE/Redémarrage.md');
      expect(online.source).toBe('share');
      const bytes = await localApi.sharedContent(online.hash!);
      expect(new TextDecoder().decode(bytes)).toBe('# Redémarrage\n');

      await relay.stop();
      const offline = await localApi.sharedFile('2. TSE/Redémarrage.md');
      expect(offline).toMatchObject({ source: 'cache', reach: 'offline', hash: online.hash });
      expect(new TextDecoder().decode(await localApi.sharedContent(online.hash!))).toBe('# Redémarrage\n');
      const listing = await localApi.sharedList('2. TSE');
      expect(listing).toMatchObject({ reach: 'offline', offline: true });
      expect(listing.entries).toEqual([
        expect.objectContaining({ name: 'Redémarrage.md', type: 'file', cached: true, unavailable: false }),
      ]);
      expect((await localApi.sharedList('')).entries).toEqual([
        expect.objectContaining({ name: '2. TSE', type: 'dir' }),
      ]);
    } finally {
      await relay.stop().catch(() => {});
      fs.rmSync(share, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  test('un fichier jamais ouvert reste introuvable hors ligne : l’erreur d’origine remonte', async () => {
    saveRelay({ url: 'http://127.0.0.1:9' });
    await expect(localApi.sharedFile('jamais.md')).rejects.toThrow();
  });
});
