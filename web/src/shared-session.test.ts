import { describe, expect, it } from 'vitest';
import { badgesFor, bannerFor, lockBlocks, lockMessage, sinceLabel } from './shared-session';
import type { SharedEntry, SharedFile, SharedLock } from './lib';

const now = new Date(2026, 9, 5, 15, 0);
const lock = (overrides: Partial<SharedLock> = {}): SharedLock => ({
  app: 'word', by: 'Jean Dupont', since: new Date(2026, 9, 5, 10, 42).toISOString(), self: false, stale: false, ...overrides,
});
const file = (overrides: Partial<SharedFile> = {}): SharedFile => ({
  path: 'a.md', name: 'a.md', ext: 'md', hash: 'h1', size: 1, mtime: null, base_hash: 'h1', draft: null,
  state: '', note: '', theirs: null, send: { hash: null, requested: false }, lock: null, source: 'share', ...overrides,
});

describe('messages du dossier partagé', () => {
  it('dit qui a le fichier, dans quelle application, depuis quand', () => {
    expect(lockMessage(lock(), now)).toBe('Ouvert par Jean Dupont dans Word depuis 10h42');
    expect(lockMessage(lock({ app: 'excel', since: new Date(2026, 9, 3, 9, 5).toISOString() }), now))
      .toBe('Ouvert par Jean Dupont dans Excel depuis le 03/10 à 09h05');
    expect(sinceLabel(null)).toBe('');
  });

  it('seul un verrou d’autrui, récent, donne la main à quelqu’un d’autre', () => {
    expect(lockBlocks(lock())).toBe(true);
    expect(lockBlocks(lock({ self: true }))).toBe(false);
    expect(lockBlocks(lock({ stale: true }))).toBe(false);
    expect(lockBlocks(null)).toBe(false);
  });

  it('un conflit prime sur tout, puis la lecture seule, puis l’attente', () => {
    const conflicted = file({ state: 'conflict', lock: lock(), theirs: { hash: 'h2', deleted: false, size: 2, mtime: null, author: null } });
    expect(bannerFor(conflicted, { dirty: true, override: false })?.kind).toBe('conflict');
    expect(bannerFor(file({ lock: lock(), state: 'pending' }), { dirty: false, override: false, now })?.message)
      .toBe('Lecture seule — Ouvert par Jean Dupont dans Word depuis 10h42.');
    expect(bannerFor(file({ lock: lock(), state: 'pending', note: 'Ouvert par Jean Dupont dans Word' }), { dirty: false, override: true })?.kind).toBe('pending');
    expect(bannerFor(file({ state: 'offline' }), { dirty: true, override: false })?.kind).toBe('offline');
    expect(bannerFor(file({ source: 'cache' }), { dirty: false, override: false })?.kind).toBe('offline');
    expect(bannerFor(file(), { dirty: false, override: false })).toBeNull();
  });

  it('prévient quand le partage a bougé depuis le début du brouillon', () => {
    expect(bannerFor(file({ hash: 'h2', base_hash: 'h1' }), { dirty: true, override: false })?.kind).toBe('changed');
    expect(bannerFor(file({ hash: 'h2', base_hash: 'h1' }), { dirty: false, override: false })).toBeNull();
  });

  it('pastilles de l’arbre : verrou, conflit, attente, brouillon, modifié', () => {
    const entry = (overrides: Partial<SharedEntry>): SharedEntry => ({
      name: 'a.csv', path: 'a.csv', type: 'file', size: 1, mtime: null, ext: 'csv', lock: null, local: null, ...overrides,
    });
    expect(badgesFor(entry({ lock: lock({ app: 'excel' }) }), now).map((b) => b.icon)).toEqual(['🔒']);
    expect(badgesFor(entry({ local: { state: 'conflict', draft: true, modified: true } })).map((b) => b.icon)).toEqual(['⚠', '↻']);
    expect(badgesFor(entry({ local: { state: 'pending', draft: true, modified: false } })).map((b) => b.label)).toEqual(['Envoi en attente']);
    expect(badgesFor(entry({ local: { state: 'draft', draft: true, modified: false } })).map((b) => b.label)).toEqual(['Brouillon sur cet ordinateur']);
    expect(badgesFor(entry({ lock: lock({ self: true }) }))).toEqual([]);
  });
});
