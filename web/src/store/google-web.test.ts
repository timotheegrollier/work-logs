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
    const { setWebClientId, getWebClientId, setWebClientSecret, getWebClientSecret } = await googleWeb();
    expect(() => setWebClientId('n’importe quoi')).toThrow('Identifiant client Google invalide');
    expect(setWebClientId(`  ${CLIENT}  `)).toBe(CLIENT);
    expect(getWebClientId()).toBe(CLIENT);
    expect(getWebClientSecret()).toBe('');
    expect(setWebClientSecret('  secret-abc  ')).toBe('secret-abc');
    expect(getWebClientSecret()).toBe('secret-abc');
    expect(() => setWebClientSecret('x'.repeat(501))).toThrow('Secret client Google invalide');
    expect(setWebClientSecret('')).toBe('');
    expect(getWebClientSecret()).toBe('');
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
    expect(params.get('scope')).toBe('https://www.googleapis.com/auth/drive.file openid email profile');
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
    const { setWebClientId, setWebClientSecret, handleRedirectCallback, webGoogleStatus } = await googleWeb();
    setWebClientId(CLIENT);
    setWebClientSecret('secret-abc');
    sessionStorage.setItem('worklogs-google-web-pending', JSON.stringify({ state: 's', verifier: 'v', redirectUri: 'https://pwa.test/' }));
    const calls = stubFetch(async (url, init) => {
      if (url.endsWith('/userinfo')) return jsonResponse({ email: 'timo@example.com', name: 'Timo' });
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const body = new URLSearchParams((init?.body as URLSearchParams).toString());
      expect(body.get('client_secret')).toBe('secret-abc');
      expect(body.get('code_verifier')).toBe('v');
      return jsonResponse({ access_token: 'acces', refresh_token: 'renouvellement', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' });
    });
    expect(await handleRedirectCallback('?code=code&state=s')).toBe(true);
    expect(calls).toHaveLength(2);
    expect(webGoogleStatus()).toEqual({
      configured: true, connected: true, builtin: false, expired: false,
      account: { email: 'timo@example.com', name: 'Timo', picture: '' },
    });
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
    // Session « jeton » sans renouvellement : on garde le compte, reprise en un clic.
    await expect(expired.webAccessToken()).rejects.toMatchObject({ code: 'GOOGLE_REAUTH' });
    expect(expired.webGoogleStatus()).toMatchObject({ connected: true, expired: true });
    expired.disconnectWeb();
  });
});

describe('client intégré et session sans secret', () => {
  test('le client intégré sert par défaut, le client personnel reste prioritaire', async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', CLIENT);
    try {
      const { activeWebClientId, builtinWebClientId, setWebClientId, clearWebClient, webGoogleStatus } = await googleWeb();
      expect(builtinWebClientId()).toBe(CLIENT);
      expect(webGoogleStatus()).toMatchObject({ configured: true, builtin: true, connected: false });
      setWebClientId('999-perso.apps.googleusercontent.com');
      expect(activeWebClientId()).toBe('999-perso.apps.googleusercontent.com');
      expect(webGoogleStatus().builtin).toBe(false);
      clearWebClient();
      expect(activeWebClientId()).toBe(CLIENT);
    } finally {
      vi.unstubAllEnvs();
    }
    vi.resetModules();
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'pas-un-client');
    try {
      expect((await googleWeb()).webGoogleStatus()).toMatchObject({ configured: false, builtin: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('URL « jeton » : sans secret ni PKCE, identité demandée, compte suggéré', async () => {
    const { tokenLoginUrl } = await googleWeb();
    const params = new URL(tokenLoginUrl(CLIENT, 'https://pwa.test/', 'etat', 'timo@example.com')).searchParams;
    expect(params.get('response_type')).toBe('token');
    expect(params.get('scope')).toBe('https://www.googleapis.com/auth/drive.file openid email profile');
    expect(params.get('login_hint')).toBe('timo@example.com');
    expect(params.get('state')).toBe('etat');
    expect(params.has('code_challenge')).toBe(false);
    expect(params.has('prompt')).toBe(false);
    expect(new URL(tokenLoginUrl(CLIENT, 'https://pwa.test/', 'etat')).searchParams.has('login_hint')).toBe(false);
  });

  test('retour « jeton » dans le fragment : état vérifié, compte lu, une heure de session', async () => {
    const { handleRedirectCallback, hasRedirectCallback, webGoogleStatus, webAccessToken } = await googleWeb();
    const scope = encodeURIComponent('https://www.googleapis.com/auth/drive.file openid email profile');
    expect(hasRedirectCallback('', `#access_token=a&state=s`)).toBe(true);
    expect(hasRedirectCallback('', '#section')).toBe(false);

    sessionStorage.setItem('worklogs-google-web-pending', JSON.stringify({ state: 's', redirectUri: 'https://pwa.test/' }));
    await expect(handleRedirectCallback('', '#access_token=a&state=autre')).rejects.toThrow('Retour Google invalide');

    sessionStorage.setItem('worklogs-google-web-pending', JSON.stringify({ state: 's', redirectUri: 'https://pwa.test/' }));
    await expect(handleRedirectCallback('', '#access_token=a&state=s&scope=openid')).rejects.toThrow('pas été accordé');
    expect(webGoogleStatus().connected).toBe(false);

    sessionStorage.setItem('worklogs-google-web-pending', JSON.stringify({ state: 's', redirectUri: 'https://pwa.test/' }));
    await expect(handleRedirectCallback('', '#error=access_denied&state=s')).rejects.toThrow('Connexion Google annulée');

    const calls = stubFetch(async (url) => url.endsWith('/userinfo') ? jsonResponse({ email: 'timo@example.com', name: 'Timo' }) : jsonResponse({}));
    sessionStorage.setItem('worklogs-google-web-pending', JSON.stringify({ state: 's', redirectUri: 'https://pwa.test/' }));
    expect(await handleRedirectCallback('', `#access_token=jeton&expires_in=3599&state=s&scope=${scope}`)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['https://openidconnect.googleapis.com/v1/userinfo']);
    expect(webGoogleStatus()).toMatchObject({ connected: true, expired: false, account: { email: 'timo@example.com', name: 'Timo' } });
    expect(await webAccessToken()).toBe('jeton');
  });

  test('401 en session « jeton » : reprise proposée, compte conservé', async () => {
    const { mapGoogleError, webGoogleStatus } = await googleWeb();
    localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({
      access_token: 'a', expires_at: Date.now() + 3600_000, account: { email: 'timo@example.com', name: 'Timo' },
    }));
    expect(() => mapGoogleError(401, {}, '/drive/v3/files')).toThrow(expect.objectContaining({ code: 'GOOGLE_REAUTH' }));
    expect(webGoogleStatus()).toMatchObject({ connected: true, expired: true, account: { email: 'timo@example.com' } });
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

  test('envoi multipart avec vrais CRLF, puis boîte mobile étiquetée', async () => {
    const { uploadDriveFile, uploadOutbox } = await googleWeb();
    await connected();
    const calls = stubFetch(async (url, init) => {
      expect(url).toContain('/upload/drive/v3/files?uploadType=multipart');
      expect((init?.headers as Record<string, string>)['Content-Type']).toMatch(/^multipart\/related; boundary=/);
      const raw = await ((init?.body as Blob).text());
      expect(raw).toContain('\r\n');
      expect(raw).not.toContain('\\r\\n');
      expect(raw).toContain('worklogs_type');
      return jsonResponse({ id: 'f1', name: 'photo.jpg' });
    });
    expect(await uploadDriveFile({ name: 'photo.jpg', mimeType: 'image/jpeg', data: new Blob(['pixels']), appProperties: { worklogs_type: 'attachment' } })).toEqual({ id: 'f1', name: 'photo.jpg' });
    expect(calls).toHaveLength(1);
    await expect(uploadDriveFile({ name: '  ', mimeType: 'image/jpeg', data: new Blob([]), appProperties: {} })).rejects.toThrow('Nom de fichier Google invalide');

    stubFetch(async (_url, init) => {
      const raw = await ((init?.body as Blob).text());
      expect(raw).toContain('"worklogs_type":"outbox"');
      expect(raw).toContain('"version":1');
      return jsonResponse({ id: 'o1' });
    });
    const sent = await uploadOutbox({ version: 1 });
    expect(sent.id).toBe('o1');
    expect(sent.name).toMatch(/^WorkLogs outbox .*\.json$/);
  });

  test('sauvegarde canonique : remplace le fichier existant, sinon crée', async () => {
    const { saveBackupJson } = await googleWeb();
    await connected();
    const calls = stubFetch(async (url, init) => {
      if (url.includes('/upload/')) {
        const raw = await ((init?.body as Blob).text());
        expect(raw).toContain('"worklogs_type":"backup"');
        expect(raw).toContain('"version":2');
        return jsonResponse({ id: 'canon', name: 'WorkLogs backup.json' });
      }
      return jsonResponse({ files: [{ id: 'canon', name: 'WorkLogs backup.json', mimeType: 'application/json' }] });
    });
    expect(await saveBackupJson(JSON.stringify({ version: 2 }))).toEqual({ id: 'canon', name: 'WorkLogs backup.json' });
    const update = calls.find((c) => c.url.includes('/upload/'));
    expect(update?.url).toContain('/upload/drive/v3/files/canon?');
    expect(update?.init?.method).toBe('PATCH');

    const created = stubFetch(async (url) => {
      if (url.includes('/upload/')) return jsonResponse({ id: 'nouveau', name: 'WorkLogs backup.json' });
      return jsonResponse({ files: [] });
    });
    expect(await saveBackupJson(JSON.stringify({ version: 2 }))).toEqual({ id: 'nouveau', name: 'WorkLogs backup.json' });
    expect(created.find((c) => c.url.includes('/upload/'))?.init?.method).toBe('POST');
    await expect(saveBackupJson('x'.repeat(21 * 1024 * 1024))).rejects.toThrow('trop volumineuse');
  });
});
