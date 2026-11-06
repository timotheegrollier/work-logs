import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createMemoryDatabase } from './storage';
import { FAKE_CLIENT, FAKE_PROXY, connectGoogle as connect, fakeGoogle } from '../test/fake-google';

const RELAY = { url: 'https://vm.tailnet.ts.net:8443' };

async function load() {
  vi.resetModules();
  const local = await import('./localApi');
  local.setLocalDatabase(createMemoryDatabase());
  return {
    vault: await import('./relay-drive'),
    settings: await import('../relay-settings'),
    sync: await import('./sync-web'),
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', FAKE_CLIENT);
  vi.stubEnv('VITE_GOOGLE_TOKEN_PROXY', FAKE_PROXY);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('adresse du relais gardée dans le compte Google', () => {
  test('enregistrée ici, perdue, elle revient toute seule ; un ancien code ne part jamais', async () => {
    const drive = fakeGoogle();
    connect();
    const { vault, settings } = await load();
    // Réglage d'avant le relais sans code : l'adresse et son code, sans date.
    localStorage.setItem('worklogs-relais', JSON.stringify({ ...RELAY, token: 'c'.repeat(43) }));
    expect(await vault.syncRelayVault()).toBe('saved');
    const [file] = drive.relayFiles();
    expect(file.name).toBe('WorkLogs relais.json');
    expect(file.parents).toHaveLength(1);
    expect(JSON.parse(file.text)).toEqual({ url: RELAY.url, saved_at: '' });
    // Rien de changé : rien ne repart.
    expect(await vault.syncRelayVault()).toBe('unchanged');

    // Le téléphone a perdu son stockage : seule la connexion Google reste.
    localStorage.removeItem('worklogs-relais');
    expect(await vault.syncRelayVault()).toBe('restored');
    expect(settings.readRelay()).toMatchObject(RELAY);
    expect(drive.relayFiles()).toHaveLength(1);
  });

  test('ancienne copie chiffrée (§39) : remplacée par l’adresse, ou retirée si ce téléphone n’a rien', async () => {
    const sealed = JSON.stringify({ version: 1, iv: 'aXY', data: 'Y2hpZmZyw6k' });
    const drive = fakeGoogle();
    connect();
    drive.files.set('ancien', { type: 'relay', name: 'WorkLogs relais.json', text: sealed, trashed: false });
    const { vault, settings } = await load();
    expect(await vault.syncRelayVault()).toBe('removed');
    expect(settings.readRelay()).toBeNull();
    expect(drive.relayFiles()).toHaveLength(0);

    drive.files.set('ancien-2', { type: 'relay', name: 'WorkLogs relais.json', text: sealed, trashed: false });
    settings.saveRelay(RELAY);
    expect(await vault.syncRelayVault()).toBe('saved');
    expect(drive.relayFiles()).toHaveLength(1);
    expect(JSON.parse(drive.files.get('ancien-2')!.text)).toMatchObject(RELAY);
  });

  test('« Oublier ce relais » : la copie part à la corbeille, même oubliée hors connexion', async () => {
    const drive = fakeGoogle();
    connect();
    const first = await load();
    first.settings.saveRelay(RELAY);
    await first.vault.syncRelayVault();
    first.settings.saveRelay(null);
    expect(await first.vault.syncRelayVault()).toBe('removed');
    expect(drive.relayFiles()).toHaveLength(0);
    expect(first.settings.relayForgottenAt()).toBe('');

    // Oublié sans connexion, synchronisé plus tard : la copie ne revient pas.
    first.settings.saveRelay(RELAY);
    await first.vault.syncRelayVault();
    localStorage.removeItem('worklogs-google-web-tokens');
    const offline = await load();
    await new Promise((resolve) => setTimeout(resolve, 5));
    offline.settings.saveRelay(null);
    expect(await offline.vault.syncRelayVault()).toBe('unavailable');
    connect();
    const { vault, settings } = await load();
    expect(await vault.syncRelayVault()).toBe('removed');
    expect(drive.relayFiles()).toHaveLength(0);
    expect(settings.readRelay()).toBeNull();
  });

  test('deux téléphones : le plus récent gagne, l’autre se met à jour', async () => {
    fakeGoogle();
    connect();
    const { vault, settings } = await load();
    settings.saveRelay({ ...RELAY, saved_at: '2026-10-20T08:00:00.000Z' });
    await vault.syncRelayVault();
    // L'autre téléphone a enregistré une nouvelle adresse après : sa copie est la plus récente.
    const fresh = { url: 'https://relais-2.tailnet.ts.net:8443', saved_at: '2026-10-21T08:00:00.000Z' };
    settings.saveRelay(fresh);
    await vault.syncRelayVault();
    settings.saveRelay({ ...RELAY, saved_at: '2026-10-20T08:00:00.000Z' });
    expect(await vault.syncRelayVault()).toBe('restored');
    expect(settings.readRelay()).toEqual(fresh);
  });

  test('compte déconnecté : rien ne part ; client Google personnel : la copie suit aussi', async () => {
    const drive = fakeGoogle();
    const { vault, settings } = await load();
    settings.saveRelay(RELAY);
    expect(await vault.syncRelayVault()).toBe('unavailable');
    expect(drive.files.size).toBe(0);
    connect();
    localStorage.setItem('worklogs-google-web-client', '999-perso.apps.googleusercontent.com');
    expect(await vault.syncRelayVault()).toBe('saved');
    expect(drive.relayFiles()).toHaveLength(1);
  });

  test('la synchro rend l’adresse perdue une fois par ouverture et le signale (relayRevision)', async () => {
    const drive = fakeGoogle();
    connect();
    const first = await load();
    first.settings.saveRelay(RELAY);
    await first.sync.syncWebNow();
    expect(drive.relayFiles()).toHaveLength(1);

    // Réouverture de la PWA sur un téléphone qui a perdu le réglage.
    localStorage.removeItem('worklogs-relais');
    const { sync, settings } = await load();
    await sync.syncWebNow();
    expect(settings.readRelay()).toMatchObject(RELAY);
    expect(sync.webSyncStatus().relayRevision).toBe(1);
    await sync.syncWebNow();
    expect(sync.webSyncStatus().relayRevision).toBe(1);
  });
});
