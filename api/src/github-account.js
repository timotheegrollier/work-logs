import { execFile as runFile, spawn as runSpawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(runFile);
const HOST = 'github.com';
const SETTING = 'github.account';
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
// Durée de vie d'un code d'appareil GitHub : au-delà, `gh` attendrait pour rien.
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const CODE_TIMEOUT_MS = 20_000;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const ghEnv = (extra = {}) => ({ ...process.env, ...extra, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat' });
const unavailable = () => fail(503, 'GITHUB_UNAVAILABLE', 'GitHub : GitHub CLI (gh) est nécessaire sur cet ordinateur pour se connecter à GitHub.');

/**
 * Compte GitHub de WorkLogs sur ce poste (§101) : choisi parmi les comptes déjà connectés à
 * GitHub CLI, il sert aux lectures par son jeton (`GH_TOKEN`), sans changer le compte actif
 * de `gh` dont dépendent les autres outils. Réglage de la machine, jamais synchronisé.
 */
export function createGithubAccounts({ db, execFile = execute, spawn = runSpawn, timeoutMs = LOGIN_TIMEOUT_MS, codeTimeoutMs = CODE_TIMEOUT_MS } = {}) {
  const chosen = () => db.prepare('SELECT value FROM local_settings WHERE key=?').get(SETTING)?.value ?? null;
  const store = (login) => {
    if (login === null) db.prepare('DELETE FROM local_settings WHERE key=?').run(SETTING);
    else db.prepare(`INSERT INTO local_settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(SETTING, login, new Date().toISOString());
  };
  const gh = async (args, options = {}) => {
    try {
      return (await execFile('gh', args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true, env: ghEnv(), ...options })).stdout;
    } catch (cause) {
      if (cause.code === 'ENOENT') throw unavailable();
      throw cause;
    }
  };

  /** Les comptes connectés à `gh`, sans leurs jetons (`--json` sort en 0 même si un compte est à reconnecter). */
  const accounts = async () => {
    let body;
    try { body = JSON.parse(await gh(['auth', 'status', '--hostname', HOST, '--json', 'hosts'])); }
    catch (cause) {
      if (cause.code === 'GITHUB_UNAVAILABLE') throw cause;
      throw fail(502, 'GITHUB_READ_FAILED', 'GitHub : impossible de lire les comptes de GitHub CLI sur cet ordinateur.');
    }
    const rows = Array.isArray(body?.hosts?.[HOST]) ? body.hosts[HOST] : [];
    return rows.filter((row) => typeof row?.login === 'string' && LOGIN.test(row.login))
      .map((row) => ({ login: row.login, active: row.active === true, ok: row.state === 'success' }));
  };
  const list = async () => ({ accounts: await accounts(), chosen: chosen() });

  const choose = async (login) => {
    if (login === null || login === '') { store(null); return list(); }
    if (typeof login !== 'string' || !LOGIN.test(login)) throw fail(400, 'GITHUB_ACCOUNT_INVALID', 'GitHub : nom de compte invalide.');
    const known = await accounts();
    const account = known.find((row) => row.login.toLowerCase() === login.toLowerCase());
    if (!account) throw fail(400, 'GITHUB_ACCOUNT_UNKNOWN', `GitHub : le compte ${login} n’est pas connecté à GitHub CLI sur cet ordinateur.`);
    store(account.login);
    return { accounts: known, chosen: account.login };
  };

  /** Variables d'environnement des lectures : le jeton du compte choisi, rien pour suivre le compte actif. */
  const env = async () => {
    const login = chosen();
    if (!login) return {};
    let token = '';
    try { token = (await gh(['auth', 'token', '--hostname', HOST, '--user', login])).trim(); }
    catch (cause) { if (cause.code === 'GITHUB_UNAVAILABLE') throw cause; }
    if (!token || /\s/.test(token)) {
      throw fail(401, 'GITHUB_AUTH_REQUIRED', `GitHub : le compte ${login} n’est plus connecté à GitHub CLI sur cet ordinateur. Choisis un autre compte ou reconnecte-le.`);
    }
    return { GH_TOKEN: token };
  };

  // Une connexion à la fois : `gh auth login --web` affiche un code d'appareil, puis attend
  // que l'utilisateur l'autorise sur github.com.
  let login = { state: 'idle' };
  const status = () => {
    const { state, code = null, url = null, account = null, error = null } = login;
    return { state, code, url, account, error };
  };

  const finish = async (current, exitCode) => {
    if (login !== current) return;
    if (exitCode !== 0) {
      login = { state: 'failed', error: current.expired ? 'GitHub : le code a expiré avant d’être autorisé. Relance la connexion.' : 'GitHub : la connexion n’a pas abouti.' };
      return;
    }
    // `gh auth login` rend actif le compte connecté : on le lit, puis on rend la main au compte
    // d'avant, même si la lecture a échoué (basculer vers un compte déjà actif ne change rien).
    let account = null;
    try { account = (await accounts()).find((row) => row.active)?.login ?? null; } catch { /* le retour passe d'abord */ }
    if (current.previous && account !== current.previous) {
      try { await gh(['auth', 'switch', '--hostname', HOST, '--user', current.previous]); }
      catch {
        if (login === current) login = { state: 'failed', error: `GitHub : le compte est connecté, mais GitHub CLI n’a pas pu revenir au compte ${current.previous} : le nouveau compte reste le compte actif de GitHub CLI.` };
        return;
      }
    }
    // Annulée entre-temps : rien n'est retenu.
    if (login !== current) return;
    if (!account) {
      login = { state: 'failed', error: 'GitHub : le compte est connecté, mais WorkLogs n’a pas pu le retenir. Choisis-le dans la liste.' };
      return;
    }
    store(account);
    login = { state: 'done', account };
  };

  const startLogin = async () => {
    if (login.state === 'pending') return status();
    const previous = (await accounts()).find((row) => row.active)?.login ?? null;
    if (login.state === 'pending') return status();
    let child;
    try {
      // Sans `--git-protocol` : ce réglage vaut pour tous les comptes de l'hôte, gh le garde tel quel.
      child = spawn('gh', ['auth', 'login', '--hostname', HOST, '--web', '--clipboard=false'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: ghEnv() });
    } catch (cause) {
      if (cause.code === 'ENOENT') throw unavailable();
      throw cause;
    }
    const current = { state: 'pending', child, previous, code: null, url: null };
    login = current;
    // Quitter WorkLogs arrête la connexion : sinon `gh` pourrait changer le compte actif plus tard.
    const stop = () => child.kill();
    process.once('exit', stop);
    const timer = setTimeout(() => { current.expired = true; child.kill(); }, timeoutMs);
    timer.unref?.();
    let output = '';
    return new Promise((resolve, reject) => {
      const answered = setTimeout(() => { child.kill(); reject(fail(504, 'GITHUB_TIMEOUT', 'GitHub : GitHub CLI n’a pas donné de code de connexion.')); }, codeTimeoutMs);
      const read = (chunk) => {
        if (current.code) return;
        output = (output + chunk).slice(-8000);
        const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(output)?.[1];
        const url = /https:\/\/github\.com\/login\/device\b/.exec(output)?.[0];
        if (!code || !url) return;
        Object.assign(current, { code, url });
        clearTimeout(answered);
        resolve(status());
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.on('error', (cause) => {
        clearTimeout(answered);
        if (login === current) login = { state: 'failed', error: 'GitHub : la connexion n’a pas abouti.' };
        reject(cause.code === 'ENOENT' ? unavailable() : fail(502, 'GITHUB_READ_FAILED', 'GitHub : la connexion n’a pas abouti.'));
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        clearTimeout(answered);
        process.off('exit', stop);
        if (!current.code) {
          if (login === current) login = { state: 'failed', error: 'GitHub : GitHub CLI n’a pas donné de code de connexion.' };
          reject(fail(502, 'GITHUB_READ_FAILED', 'GitHub : GitHub CLI n’a pas donné de code de connexion.'));
          return;
        }
        void finish(current, exitCode);
      });
    });
  };

  const cancelLogin = () => {
    if (login.state === 'pending') login.child.kill();
    login = { state: 'idle' };
    return status();
  };

  return { list, choose, env, startLogin, loginStatus: status, cancelLogin };
}
