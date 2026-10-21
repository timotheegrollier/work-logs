import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createMemoryDatabase } from './storage';
import { FAKE_CLIENT, FAKE_PROXY, connectGoogle as connect, fakeGoogle } from '../test/fake-google';

const RELAY = { url: 'https://vm.tailnet.ts.net:8443', token: 'c'.repeat(43) };

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

describe('accès au relais gardé dans le compte Google', () => {
  test('enregistré ici, perdu, il revient tout seul ; le fichier Drive ne dit ni l’adresse ni le code', async () => {
    const drive = fakeGoogle();
    connect();
    const { vault, settings } = await load();
    settings.saveRelay(RELAY);
    expect(await vault.syncRelayVault()).toBe('saved');
    const [file] = drive.relayFiles();
    expect(file.name).toBe('WorkLogs relais.json');
    expect(file.parents).toHaveLength(1);
    expect(file.text).not.toContain(RELAY.token);
    expect(file.text).not.toContain('tailnet');
    expect(JSON.parse(file.text)).toEqual({ version: 1, iv: expect.any(String), data: expect.any(String) });
    // Rien de changé : rien ne repart.
    expect(await vault.syncRelayVault()).toBe('unchanged');

    // Le téléphone a perdu son stockage : seule la connexion Google reste.
    localStorage.removeItem('worklogs-relais');
    expect(await vault.syncRelayVault()).toBe('restored');
    expect(settings.readRelay()).toMatchObject(RELAY);
    expect(drive.relayFiles()).toHaveLength(1);
  });

  test('copie illisible (clé du Worker changée) : rien ne revient, la copie suivante la remplace', async () => {
    const drive = fakeGoogle();
    connect();
    const first = await load();
    first.settings.saveRelay(RELAY);
    await first.vault.syncRelayVault();
    const sealed = drive.relayFiles()[0].text;

    connect('acces-secret-change');
    localStorage.removeItem('worklogs-relais');
    const { vault, settings } = await load();
    expect(await vault.syncRelayVault()).toBe('removed');
    expect(settings.readRelay()).toBeNull();
    expect(drive.relayFiles()).toHaveLength(0);

    settings.saveRelay(RELAY);
    expect(await vault.syncRelayVault()).toBe('saved');
    expect(drive.relayFiles()[0].text).not.toBe(sealed);
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
    // L'autre téléphone a enregistré un nouveau code après : sa copie est la plus récente.
    const fresh = { ...RELAY, token: 'n'.repeat(43), saved_at: '2026-10-21T08:00:00.000Z' };
    settings.saveRelay(fresh);
    await vault.syncRelayVault();
    settings.saveRelay({ ...RELAY, saved_at: '2026-10-20T08:00:00.000Z' });
    expect(await vault.syncRelayVault()).toBe('restored');
    expect(settings.readRelay()).toEqual(fresh);
  });

  test('client Google personnel ou compte déconnecté : rien ne part, rien n’est demandé au Worker', async () => {
    const drive = fakeGoogle();
    const { vault, settings } = await load();
    settings.saveRelay(RELAY);
    expect(await vault.syncRelayVault()).toBe('unavailable');
    connect();
    localStorage.setItem('worklogs-google-web-client', '999-perso.apps.googleusercontent.com');
    expect(await vault.syncRelayVault()).toBe('unavailable');
    expect(drive.keyCalls).toBe(0);
    expect(drive.files.size).toBe(0);
  });

  test('la synchro rend l’accès perdu une fois par ouverture et le signale (relayRevision)', async () => {
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
    const calls = drive.keyCalls;
    await sync.syncWebNow();
    expect(drive.keyCalls).toBe(calls);
    expect(sync.webSyncStatus().relayRevision).toBe(1);
  });
});
