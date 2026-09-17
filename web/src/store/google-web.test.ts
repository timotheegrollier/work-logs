import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { ApiError } from '../lib';

const CLIENT = '123456789012-abc.apps.googleusercontent.com';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return calls;
}

async function googleWeb() {
  return import('./google-web');
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('configuration et PKCE', () => {
  test('identifiant client validé et conservé', async () => {
    const { setWebClientId, getWebClientId } = await googleWeb();
    expect(() => setWebClientId('n’importe quoi')).toThrow('Identifiant client Google invalide');
    expect(setWebClientId(`  ${CLIENT}  `)).toBe(CLIENT);
    expect(getWebClientId()).toBe(CLIENT);
  });

  test('base64url sans remplissage, conforme RFC 4648', async () => {
    const { base64url } = await googleWeb();
    expect(base64url(new Uint8Array([251, 239, 255]))).toBe('--__');
    expect(base64url(new Uint8Array([250]))).toBe('-g');
    expect(base64url(new Uint8Array([]))).toBe('');
  });

  test('défi PKCE : SHA-256 base64url déterministe de 43 caractères', async () => {
    const { pkceChallenge } = await googleWeb();
    const first = await pkceChallenge('verificateur-aleatoire-0123456789abcdef', webcrypto.subtle);
    const second = await pkceChallenge('verificateur-aleatoire-0123456789abcdef', webcrypto.subtle);
    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await pkceChallenge('autre-verificateur-0123456789abcdef', webcrypto.subtle)).not.toBe(first);
  });

  test('URL Google : code + PKCE + hors-ligne + périmètre Drive', async () => {
    const { loginUrl } = await googleWeb();
    const url = new URL(loginUrl(CLIENT, 'https://pwa.test/app/', 'etat', 'defi'));
    expect(url.origin).toBe('https://accounts.google.com');
    const params = url.searchParams;
    expect(params.get('client_id')).toBe(CLIENT);
    expect(params.get('redirect_uri')).toBe('https://pwa.test/app/');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('code_challenge')).toBe('defi');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('state')).toBe('etat');
  });
});

describe('retour OAuth et jetons', () => {
  test('sans paramètre : rien à traiter', async () => {
    const { handleRedirectCallback } = await googleWeb();
    expect(await handleRedirectCallback('')).toBe(false);
  });

  test('état incohérent ou refus : refus explicite', async () => {
    const { handleRedirectCallback } = await googleWeb();
    sessionStorage.setItem('worklogs-google-web-pending', JSON.stringify({ state: 'bon', verifier: 'v', redirectUri: 'https://pwa.test/' }));
    await expect(handleRedirectCallback('?code=x&state=mauvais')).rejects.toThrow('Retour Google invalide');
    sessionStorage.setItem('worklogs-google-web-pending', JSON.stringify({ state: 'bon', verifier: 'v', redirectUri: 'https://pwa.test/' }));
    await expect(handleRedirectCallback('?error=access_denied&state=bon')).rejects.toThrow('Connexion Google annulée');
  });

  test('échange du code et persistance des jetons', async () => {
    const { setWebClientId, handleRedirectCallback, webGoogleStatus } = await googleWeb();
    setWebClientId(CLIENT);
    sessionStorage.setItem('worklogs-google-web-pending', JSON.stringify({ state: 's', verifier: 'v', redirectUri: 'https://pwa.test/' }));
    stubFetch(async (url) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      return jsonResponse({ access_token: 'acces', refresh_token: 'renouvellement', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' });
    });
    expect(await handleRedirectCallback('?code=code&state=s')).toBe(true);
    expect(webGoogleStatus()).toEqual({ configured: true, connected: true });
    expect(JSON.parse(localStorage.getItem('worklogs-google-web-tokens') as string).refresh_token).toBe('renouvellement');
  });

  test('jeton frais réutilisé, renouvellement unique en concurrence', async () => {
    const { setWebClientId, webAccessToken } = await googleWeb();
    setWebClientId(CLIENT);
    localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({ access_token: 'frais', expires_at: Date.now() + 3600_000 }));
    stubFetch(async () => jsonResponse({}));
    expect(await webAccessToken()).toBe('frais');

    // Rechargement de page : le module relit le stockage, le jeton a expiré.
    vi.resetModules();
    const reloaded = await import('./google-web');
    localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({ access_token: 'vieux', refresh_token: 'r', expires_at: Date.now() - 1000 }));
    const calls = stubFetch(async () => jsonResponse({ access_token: 'neuf', expires_in: 3600 }));
    const [a, b] = await Promise.all([reloaded.webAccessToken(), reloaded.webAccessToken()]);
    expect([a, b]).toEqual(['neuf', 'neuf']);
    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(1);

    localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({ access_token: 'vieux', expires_at: Date.now() - 1000 }));
    vi.resetModules();
    const expired = await import('./google-web');
    stubFetch(async () => jsonResponse({}));
    await expect(expired.webAccessToken()).rejects.toThrow('renouveler l’autorisation');
    expect(expired.webGoogleStatus().connected).toBe(false);
    expired.disconnectWeb();
  });
});

describe('appels Drive', () => {
  async function connected() {
    const { setWebClientId } = await googleWeb();
    setWebClientId(CLIENT);
    localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({ access_token: 'acces', expires_at: Date.now() + 3600_000 }));
  }

  test('adresses hors Google refusées', async () => {
    const { webGoogleRequest } = await googleWeb();
    await connected();
    await expect(webGoogleRequest('https://example.com/x')).rejects.toThrow('non autorisée');
  });

  test('erreurs Google traduites comme côté desktop', async () => {
    const { mapGoogleError } = await googleWeb();
    type ErrorBody = Parameters<typeof mapGoogleError>[1];
    const failure = (status: number, body: ErrorBody) => {
      try {
        mapGoogleError(status, body, '/drive/v3/files');
        expect.unreachable();
      } catch (e) {
        return e as ApiError;
      }
    };
    expect(failure(401, {}).message).toMatch('expirée');
    expect(failure(403, {}).message).toMatch('même projet');
    expect(failure(404, {}).message).toMatch('introuvable');
    expect(failure(400, {}).message).toMatch('refusé la requête');
    const disabled = failure(403, { error: { details: [{ reason: 'SERVICE_DISABLED', metadata: { service: 'drive.googleapis.com', consumer: 'projects/1234' } }] } });
    expect(disabled.code).toBe('GOOGLE_API_DISABLED');
    expect(disabled.helpUrl).toContain('drive.googleapis.com?project=1234');
    expect(failure(429, {}).code).toBe('GOOGLE_RATE_LIMIT');
    expect(failure(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }).code).toBe('GOOGLE_SCOPE_REQUIRED');
  });

  test('liste des sauvegardes et téléchargement', async () => {
    const { listWebBackups, downloadWebBackup } = await googleWeb();
    await connected();
    stubFetch(async (url) => {
      if (url.includes('/drive/v3/files?')) {
        return jsonResponse({ files: [
          { id: 'b1', name: 'WorkLogs backup.json', modifiedTime: '2026-09-18T10:00:00.000Z', size: '12', mimeType: 'application/json' },
          { id: 'img', name: 'photo.png', mimeType: 'image/png' },
        ] });
      }
      return new Response(JSON.stringify({ version: 2 }), { headers: { 'Content-Type': 'application/json' } });
    });
    expect(await listWebBackups()).toEqual([{ id: 'b1', name: 'WorkLogs backup.json', modifiedTime: '2026-09-18T10:00:00.000Z', size: 12 }]);
    expect(await downloadWebBackup('b1')).toEqual({ version: 2 });
    await expect(downloadWebBackup('mauvais id!')).rejects.toThrow('Identifiant de document Google invalide');
  });
});
