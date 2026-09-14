import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** OAuth desktop : navigateur système + PKCE, aucun jeton dans le renderer. */
export function createGoogleClient({ profileDir, secureStorage, openExternal, fetchImpl = fetch, timeoutMs = 300_000 }) {
  const configPath = path.join(profileDir, 'google-client.json');
  const tokenPath = path.join(profileDir, 'google-tokens.enc');
  let config = {};
  let tokens = null;
  let pending = null;
  let error = '';
  let selected = [];
  let refreshing = null;
  let generation = 0;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

  const protectedStorage = () => secureStorage.isEncryptionAvailable() && secureStorage.getSelectedStorageBackend() !== 'basic_text';
  if (protectedStorage()) {
    try { tokens = JSON.parse(secureStorage.decryptString(fs.readFileSync(tokenPath))); }
    catch { if (fs.existsSync(tokenPath)) error = 'Reconnecte Google Drive : les identifiants enregistrés ne sont plus lisibles.'; }
  }
  function persist() {
    if (!protectedStorage()) throw fail('Le trousseau système est indisponible. Active le trousseau de ta session Linux pour connecter Google Drive.');
    fs.mkdirSync(profileDir, { recursive: true });
    const temporary = tokenPath + '.tmp';
    fs.writeFileSync(temporary, secureStorage.encryptString(JSON.stringify(tokens)), { mode: 0o600 });
    fs.renameSync(temporary, tokenPath);
  }
  const status = () => ({ available: true, configured: !!config.client_id, connected: !!tokens,
    pending: !!pending, error, selectedIds: selected, secureStorage: protectedStorage() });
  const cancel = () => {
    generation++;
    if (pending) { clearTimeout(pending.timer); pending.server.close(); pending.server.closeAllConnections(); pending = null; }
  };
  async function tokenRequest(params) {
    const response = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.client_id, ...(config.client_secret ? { client_secret: config.client_secret } : {}), ...params }),
      signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) {
      if (result.error === 'invalid_grant') { tokens = null; fs.rmSync(tokenPath, { force: true }); }
      throw fail(result.error === 'invalid_grant' ? 'Autorisation Google expirée ou révoquée. Reconnecte Google Drive.' : 'Google a refusé la connexion. Vérifie la configuration OAuth et réessaie.', 401);
    }
    if (typeof result.access_token !== 'string' || !result.access_token) throw fail('Réponse de connexion Google invalide.', 502);
    if (result.scope && !result.scope.split(' ').includes(SCOPE)) throw fail('L’accès aux documents sélectionnés n’a pas été accordé.', 403);
    return { ...result, expires_at: Date.now() + Number(result.expires_in || 3600) * 1000 };
  }
  async function accessToken() {
    if (!tokens) throw fail('Connecte Google Drive pour continuer.', 401);
    if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
    if (!tokens.refresh_token) throw fail('Reconnecte Google Drive pour renouveler l’autorisation.', 401);
    refreshing ??= (async () => {
      const currentGeneration = generation;
      const next = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      if (currentGeneration !== generation) throw fail('Connexion Google annulée.', 401);
      tokens = { ...tokens, ...next }; persist();
      return tokens.access_token;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function request(apiPath, options = {}) {
    // Les appelants ne peuvent pas envoyer le jeton à une URL extérieure.
    if (!/^\/(drive\/v3\/|docs\/v1\/)/.test(apiPath)) throw fail('Adresse Google non autorisée.');
    const url = apiPath.startsWith('/docs/') ? 'https://docs.googleapis.com' + apiPath.slice(5) : 'https://www.googleapis.com' + apiPath;
    const response = await fetchImpl(url, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
      redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) { tokens = null; fs.rmSync(tokenPath, { force: true }); }
      const messages = { 401: 'Autorisation Google expirée. Reconnecte Google Drive.', 403: 'Accès Google refusé : sélectionne ce document avec le sélecteur Drive et vérifie ton droit de modification.',
        404: 'Document Google introuvable ou non autorisé.', 429: 'Google reçoit trop de requêtes. Réessaie dans un instant.' };
      throw fail(messages[response.status] || 'Google a refusé la mise à jour. Recharge le document avant de réessayer.', response.status);
    }
    return body;
  }
  return {
    status, request, close: cancel,
    configure(input) {
      const value = input?.installed || input;
      if (!value || typeof value.client_id !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(value.client_id)) throw fail('Identifiant OAuth desktop Google invalide.');
      if (value.client_secret !== undefined && (typeof value.client_secret !== 'string' || value.client_secret.length > 500)) throw fail('Configuration OAuth invalide.');
      cancel(); tokens = null; selected = []; error = '';
      fs.rmSync(tokenPath, { force: true });
      config = { client_id: value.client_id, ...(value.client_secret ? { client_secret: value.client_secret } : {}) };
      fs.mkdirSync(profileDir, { recursive: true });
      // Identifie une application publique desktop, pas un secret utilisateur.
      fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      return status();
    },
    async connect() {
      if (!config.client_id) throw fail('Configure d’abord le client Google Drive.');
      if (!protectedStorage()) throw fail('Active le trousseau de ta session Linux pour connecter Google Drive.');
      cancel(); error = ''; selected = [];
      const currentGeneration = generation;
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      let redirect;
      let consumed = false;
      const server = createServer(async (req, res) => {
        const url = new URL(req.url, redirect);
        if (req.method !== 'GET' || url.pathname !== '/google/callback' || url.searchParams.get('state') !== state || consumed) {
          res.writeHead(400).end('Retour Google invalide.'); return;
        }
        consumed = true;
        try {
          if (url.searchParams.has('error')) throw fail('Connexion Google annulée.');
          const code = url.searchParams.get('code');
          if (!code) throw fail('Code de connexion Google absent.');
          const next = await tokenRequest({ code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' });
          if (currentGeneration !== generation) throw fail('Connexion Google annulée.');
          // Ne pas réutiliser le refresh token d'un autre compte sélectionné.
          tokens = next; persist();
          selected = (url.searchParams.get('picked_file_ids') || '').split(',').filter(id => /^[\w-]{1,200}$/.test(id));
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Google Drive est connecté. Tu peux fermer cette page et revenir dans WorkLogs.');
        } catch (e) {
          if (currentGeneration === generation) error = e.message || 'Connexion Google impossible.';
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Connexion non terminée. Reviens dans WorkLogs pour réessayer.');
        } finally {
          if (currentGeneration === generation && pending) { clearTimeout(pending.timer); pending = null; }
          server.close();
        }
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      redirect = `http://127.0.0.1:${server.address().port}/google/callback`;
      const timer = setTimeout(() => { error = 'La connexion Google a expiré. Réessaie.'; cancel(); }, timeoutMs);
      timer.unref(); pending = { server, timer };
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: config.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', trigger_onepick: 'true', mimetypes: 'application/vnd.google-apps.document',
        state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
      try { await openExternal(url.href); } catch { cancel(); throw fail('Impossible d’ouvrir le navigateur pour la connexion Google.'); }
      return status();
    },
    async disconnect() {
      const revoke = tokens?.refresh_token || tokens?.access_token;
      cancel(); tokens = null; selected = []; error = ''; fs.rmSync(tokenPath, { force: true });
      if (revoke) {
        try { await fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: revoke }), signal: AbortSignal.timeout(10_000) }); }
        catch { error = 'Déconnecté localement. Hors ligne : tu peux aussi révoquer WorkLogs depuis ton compte Google.'; }
      }
      return status();
    },
  };
}
