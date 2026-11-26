import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import express from 'express';
import { openDb } from '../src/db.js';
import { createGithubAccounts } from '../src/github-account.js';
import { createGithubRepoReader } from '../src/github-links.js';
import { registerGithubRoutes } from '../src/github-routes.js';

const statusOf = (rows) => JSON.stringify({ hosts: { 'github.com': rows } });
const row = (login, active = false, state = 'success') => ({ state, active, host: 'github.com', login, tokenSource: 'keyring' });

/** Un faux `gh` : comptes connectés, jetons par compte, et chaque appel noté. */
function fakeGh(initial = [row('timotheegrollier', true), row('claude-murgat'), row('stxtxm', false, 'error')]) {
  const state = { rows: initial, tokens: { 'timotheegrollier': 'gho_timo', 'claude-murgat': 'gho_murgat' }, calls: [] };
  state.execFile = async (file, args, options) => {
    state.calls.push(args.join(' '));
    assert.equal(file, 'gh');
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    if (args.slice(0, 2).join(' ') === 'auth status') return { stdout: statusOf(state.rows) };
    if (args.slice(0, 2).join(' ') === 'auth token') {
      const token = state.tokens[args[args.indexOf('--user') + 1]];
      if (!token) throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'no oauth token found' });
      return { stdout: token + '\n' };
    }
    if (args.slice(0, 2).join(' ') === 'auth switch') {
      const login = args[args.indexOf('--user') + 1];
      state.rows = state.rows.map((item) => ({ ...item, active: item.login === login }));
      return { stdout: '' };
    }
    throw new Error('appel inattendu : ' + args.join(' '));
  };
  return state;
}

/** Un faux `gh auth login --web` : ses sorties sont pilotées par le test. */
function fakeLogin() {
  const children = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.args = args;
    child.options = options;
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)); };
    children.push(child);
    return child;
  };
  return { spawn, children };
}

const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(check());
};

test('le compte GitHub se choisit parmi ceux de GitHub CLI, sans jeton, en réglage de la machine', async () => {
  const db = openDb(':memory:', { withSeed: false });
  const gh = fakeGh([{ ...row('timotheegrollier', true), token: 'gho_secret' }, row('claude-murgat'), row('stxtxm', false, 'error'), row('../evil')]);
  const accounts = createGithubAccounts({ db, execFile: gh.execFile });

  const listed = await accounts.list();
  assert.deepEqual(listed, { chosen: null, accounts: [
    { login: 'timotheegrollier', active: true, ok: true },
    { login: 'claude-murgat', active: false, ok: true },
    { login: 'stxtxm', active: false, ok: false },
  ] });
  assert.doesNotMatch(JSON.stringify(listed), /gho_/);

  assert.equal((await accounts.choose('Claude-Murgat')).chosen, 'claude-murgat');
  assert.equal(db.prepare("SELECT value FROM local_settings WHERE key='github.account'").get().value, 'claude-murgat');
  assert.equal((await accounts.list()).chosen, 'claude-murgat');
  await assert.rejects(accounts.choose('inconnu'), { status: 400, code: 'GITHUB_ACCOUNT_UNKNOWN' });
  await assert.rejects(accounts.choose('a b'), { status: 400, code: 'GITHUB_ACCOUNT_INVALID' });
  await assert.rejects(accounts.choose(42), { status: 400, code: 'GITHUB_ACCOUNT_INVALID' });
  assert.equal((await accounts.list()).chosen, 'claude-murgat');
  assert.equal((await accounts.choose(null)).chosen, null);
  assert.equal(db.prepare("SELECT value FROM local_settings WHERE key='github.account'").get(), undefined);

  const missing = createGithubAccounts({ db, execFile: async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); } });
  await assert.rejects(missing.list(), { status: 503, code: 'GITHUB_UNAVAILABLE' });
});

test('les lectures prennent le jeton du compte choisi, et suivent le compte actif de gh sinon', async () => {
  const db = openDb(':memory:', { withSeed: false });
  const gh = fakeGh();
  const accounts = createGithubAccounts({ db, execFile: gh.execFile });
  const seen = [];
  const list = createGithubRepoReader({ auth: accounts.env, execFile: async (_file, args, options) => {
    seen.push(options.env.GH_TOKEN ?? null);
    return { stdout: '[]' };
  } });

  assert.deepEqual(await accounts.env(), {});
  await list('Murgat-Ingenierie/murgat_management_prod', 'pulls');
  await accounts.choose('claude-murgat');
  assert.deepEqual(await accounts.env(), { GH_TOKEN: 'gho_murgat' });
  await list('Murgat-Ingenierie/murgat_management_prod', 'pulls');
  assert.deepEqual(seen, [null, 'gho_murgat']);
  assert.ok(gh.calls.includes('auth token --hostname github.com --user claude-murgat'));

  // Compte retiré de gh après coup : on le dit, sans retomber en silence sur un autre compte.
  delete gh.tokens['claude-murgat'];
  await assert.rejects(list('Murgat-Ingenierie/murgat_management_prod', 'pulls'),
    (failure) => failure.code === 'GITHUB_AUTH_REQUIRED' && failure.status === 401 && /claude-murgat/.test(failure.message));
  assert.equal(seen.length, 2);
});

test('connecter un compte affiche le code d’appareil, retient le compte et rend la main au compte actif d’avant', async () => {
  const db = openDb(':memory:', { withSeed: false });
  const gh = fakeGh();
  const login = fakeLogin();
  const accounts = createGithubAccounts({ db, execFile: gh.execFile, spawn: login.spawn });
  assert.deepEqual(accounts.loginStatus(), { state: 'idle', code: null, url: null, account: null, error: null });

  const started = accounts.startLogin();
  await until(() => login.children.length === 1);
  const [child] = login.children;
  assert.deepEqual(child.args, ['auth', 'login', '--hostname', 'github.com', '--web', '--clipboard=false']);
  assert.deepEqual(child.options.stdio, ['ignore', 'pipe', 'pipe']);
  child.stderr.emit('data', '! First copy your one-time code: ');
  child.stderr.emit('data', 'AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
  assert.deepEqual(await started, { state: 'pending', code: 'AB12-CD34', url: 'https://github.com/login/device', account: null, error: null });
  // Une seule connexion à la fois : redemander rend la même.
  assert.equal((await accounts.startLogin()).code, 'AB12-CD34');
  assert.equal(login.children.length, 1);

  // Autorisé sur github.com : `gh` rend le nouveau compte actif, puis se termine.
  gh.tokens.neo = 'gho_neo';
  gh.rows = [...gh.rows.map((item) => ({ ...item, active: false })), row('neo', true)];
  child.emit('close', 0);
  await until(() => accounts.loginStatus().state === 'done');
  assert.equal(accounts.loginStatus().account, 'neo');
  assert.ok(gh.calls.includes('auth switch --hostname github.com --user timotheegrollier'));
  assert.equal(gh.rows.find((item) => item.active).login, 'timotheegrollier');
  assert.equal((await accounts.list()).chosen, 'neo');
  assert.deepEqual(await accounts.env(), { GH_TOKEN: 'gho_neo' });
});

test('après la connexion, le compte actif d’avant revient même si la relecture échoue, et un échec du retour est dit', async () => {
  const db = openDb(':memory:', { withSeed: false });
  const prompt = (child) => child.stderr.emit('data', 'one-time code: AB12-CD34\nhttps://github.com/login/device\n');
  const connect = async (accounts, login, gh, makeNeoActive = true) => {
    const started = accounts.startLogin();
    await until(() => login.children.length > 0 && !login.children.at(-1).used);
    const child = login.children.at(-1);
    child.used = true;
    prompt(child);
    await started;
    if (makeNeoActive) gh.rows = [...gh.rows.map((item) => ({ ...item, active: false })), row('neo', true)];
    return child;
  };

  // `gh auth status` échoue juste après : on bascule quand même vers le compte d'avant.
  let gh = fakeGh();
  let login = fakeLogin();
  let accounts = createGithubAccounts({ db, execFile: (...call) => gh.execFile(...call), spawn: login.spawn });
  let child = await connect(accounts, login, gh);
  const read = gh.execFile;
  gh.execFile = async (file, args, options) => {
    if (args[1] === 'status') throw Object.assign(new Error('Command failed'), { code: 1 });
    return read(file, args, options);
  };
  child.emit('close', 0);
  await until(() => accounts.loginStatus().state === 'failed');
  assert.ok(gh.calls.includes('auth switch --hostname github.com --user timotheegrollier'));
  assert.equal(gh.rows.find((item) => item.active).login, 'timotheegrollier');
  assert.match(accounts.loginStatus().error, /Choisis-le dans la liste/);

  // Le retour lui-même échoue : on dit que le compte actif de GitHub CLI a changé.
  gh = fakeGh();
  login = fakeLogin();
  accounts = createGithubAccounts({ db, execFile: async (file, args, options) => {
    if (args[1] === 'switch') throw Object.assign(new Error('Command failed'), { code: 1 });
    return gh.execFile(file, args, options);
  }, spawn: login.spawn });
  child = await connect(accounts, login, gh);
  child.emit('close', 0);
  await until(() => accounts.loginStatus().state === 'failed');
  assert.match(accounts.loginStatus().error, /reste le compte actif de GitHub CLI/);

  // Annulée pendant la fin : le compte d'avant revient, mais rien n'est retenu.
  gh = fakeGh();
  login = fakeLogin();
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  accounts = createGithubAccounts({ db, execFile: async (file, args, options) => {
    if (args[1] === 'switch') await slow;
    return gh.execFile(file, args, options);
  }, spawn: login.spawn });
  child = await connect(accounts, login, gh);
  child.emit('close', 0);
  await until(() => gh.calls.some((call) => call.startsWith('auth status')) && gh.calls.filter((call) => call.startsWith('auth status')).length >= 2);
  accounts.cancelLogin();
  release();
  await until(() => gh.calls.includes('auth switch --hostname github.com --user timotheegrollier'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(accounts.loginStatus().state, 'idle');
  assert.equal((await accounts.list()).chosen, null);
});

test('une connexion annulée, refusée, expirée ou sans gh ne retient aucun compte', async () => {
  const db = openDb(':memory:', { withSeed: false });
  const gh = fakeGh();
  const login = fakeLogin();
  const accounts = createGithubAccounts({ db, execFile: gh.execFile, spawn: login.spawn, timeoutMs: 30 });
  const prompt = (child) => child.stderr.emit('data', 'one-time code: AB12-CD34\nhttps://github.com/login/device\n');

  let started = accounts.startLogin();
  await until(() => login.children.length === 1);
  prompt(login.children[0]);
  await started;
  assert.deepEqual(accounts.cancelLogin(), { state: 'idle', code: null, url: null, account: null, error: null });
  assert.equal(login.children[0].killed, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(accounts.loginStatus().state, 'idle');

  started = accounts.startLogin();
  await until(() => login.children.length === 2);
  prompt(login.children[1]);
  await started;
  login.children[1].emit('close', 1);
  await until(() => accounts.loginStatus().state === 'failed');
  assert.match(accounts.loginStatus().error, /n’a pas abouti/);

  started = accounts.startLogin();
  await until(() => login.children.length === 3);
  prompt(login.children[2]);
  await started;
  await until(() => accounts.loginStatus().state === 'failed');
  assert.equal(login.children[2].killed, true);
  assert.match(accounts.loginStatus().error, /expiré/);

  // Sans code affiché, la demande échoue au lieu d'attendre.
  const silent = createGithubAccounts({ db, execFile: gh.execFile, spawn: login.spawn, codeTimeoutMs: 20 });
  await assert.rejects(silent.startLogin(), { code: 'GITHUB_TIMEOUT' });
  const absent = createGithubAccounts({ db, execFile: gh.execFile, spawn: () => {
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill() {} });
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })));
    return child;
  } });
  await assert.rejects(absent.startLogin(), { status: 503, code: 'GITHUB_UNAVAILABLE' });

  assert.equal((await accounts.list()).chosen, null);
  assert.ok(!gh.calls.some((call) => call.startsWith('auth switch')));
});

test('les routes du compte GitHub restent réservées à cet ordinateur', async () => {
  const calls = [];
  const accounts = {
    list: async () => { calls.push('list'); return { accounts: [], chosen: null }; },
    choose: async (login) => { calls.push(['choose', login]); return { accounts: [], chosen: login }; },
    env: async () => ({}),
    startLogin: async () => { calls.push('start'); return { state: 'pending', code: 'AB12-CD34', url: 'https://github.com/login/device' }; },
    loginStatus: () => ({ state: 'idle' }),
    cancelLogin: () => { calls.push('cancel'); return { state: 'idle' }; },
  };
  const app = express();
  app.use(express.json());
  registerGithubRoutes(app, { accounts });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/github`;
  try {
    const refused = await fetch(base + '/login', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(refused.status, 403);
    assert.equal((await fetch(base + '/account', { method: 'PUT', headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, body: '{"login":"x"}' })).status, 403);
    assert.deepEqual(calls, []);

    const chosen = await fetch(base + '/account', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"login":"claude-murgat"}' });
    assert.equal(chosen.headers.get('cache-control'), 'no-store');
    assert.equal((await chosen.json()).chosen, 'claude-murgat');
    assert.equal((await (await fetch(base + '/login', { method: 'POST' })).json()).code, 'AB12-CD34');
    assert.equal((await (await fetch(base + '/login')).json()).state, 'idle');
    assert.equal((await fetch(base + '/login', { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(base + '/accounts')).status, 200);
    assert.deepEqual(calls, [['choose', 'claude-murgat'], 'start', 'cancel', 'list']);
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); });
  }
});
