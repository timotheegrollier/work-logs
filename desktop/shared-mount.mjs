import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

/**
 * Monter le dossier du TSE comme le fait Nemo (« Se connecter à un serveur ») :
 * GVFS, sans droits administrateur. Le partage apparaît sous
 * `/run/user/<uid>/gvfs/smb-share:server=…,share=…` et WorkLogs le traite comme
 * un dossier. Les identifiants ne passent **jamais** par WorkLogs : `gio mount`
 * réutilise ceux du trousseau ; à défaut, le gestionnaire de fichiers ouvre sa
 * propre fenêtre de connexion. Voir `docs/05-DECISIONS.md` §25.
 */

/**
 * Compte Windows sous lequel monter le partage : `SRVMURGAT\TimotheeG`,
 * `SRVMURGAT;TimotheeG` ou `TimotheeG`. Jamais de mot de passe : il se saisit dans
 * la fenêtre du gestionnaire de fichiers.
 */
export function parseAccount(input) {
  const value = String(input ?? '').trim();
  if (!value) return null;
  const match = /^(?:([^\\;/@:]+)[\\;])?([^\\;/@:]+)$/.exec(value);
  if (!match || /[\x00-\x1f]/.test(value)) throw new Error('Compte invalide : écris-le comme sur le TSE, par exemple SRVMURGAT\\TonNom.');
  const domain = match[1]?.trim() || null;
  const user = match[2].trim();
  return { domain, user, label: domain ? `${domain}\\${user}` : user };
}

/**
 * `\\TSE01\Commun\Procédures`, `//tse01/commun`, `smb://tse01/commun/x` ou
 * `tse01/commun` → `{ uri: 'smb://tse01/commun', host, share, subpath }`. Avec un
 * compte, l'adresse le porte (`smb://DOMAINE;compte@tse01/commun`) : GVFS ne
 * demande alors que son mot de passe, et ne rejoue pas un autre compte retenu.
 */
export function parseShareAddress(input, accountInput = null) {
  let value = String(input ?? '').trim();
  if (!value) throw new Error('Indique l’adresse du partage, par exemple \\\\serveur\\partage.');
  value = value.replace(/\\/g, '/');
  value = value.replace(/^smb:\/*/i, '').replace(/^\/+/, '');
  // Compte écrit dans l'adresse (`domaine;utilisateur@hôte`) : gardé, un mot de passe écarté.
  let account = parseAccount(accountInput);
  const at = value.indexOf('@');
  if (at !== -1 && at < value.indexOf('/')) {
    const userinfo = value.slice(0, at).split(':')[0];
    if (!account) {
      try { account = parseAccount(decodeURIComponent(userinfo)); } catch { account = null; }
    }
    value = value.slice(at + 1);
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Adresse incomplète : il faut le serveur et le partage, par exemple \\\\serveur\\partage.');
  const [host, share, ...rest] = parts;
  if (!/^[\w.-]+$/.test(host)) throw new Error(`Nom de serveur invalide : « ${host} ».`);
  if (/[\x00-\x1f]/.test(value)) throw new Error('Adresse invalide.');
  const userinfo = account ? `${account.domain ? `${encodeURIComponent(account.domain)};` : ''}${encodeURIComponent(account.user)}@` : '';
  return {
    uri: `smb://${userinfo}${host}/${encodeURIComponent(share)}`,
    host,
    share,
    subpath: rest.join('/'),
    label: `\\\\${host}\\${share}${rest.length ? '\\' + rest.join('\\') : ''}`,
    account,
  };
}

/** Champs d'un nom de montage GVFS : `smb-share:domain=X,server=tse01,share=commun,user=timo`. */
function mountFields(name) {
  if (!name.startsWith('smb-share:')) return null;
  const fields = {};
  for (const pair of name.slice('smb-share:'.length).split(',')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    let value = pair.slice(index + 1);
    try { value = decodeURIComponent(value); } catch {}
    fields[pair.slice(0, index)] = value;
  }
  return fields;
}

export const defaultGvfsDir = () => process.env.WORKLOGS_GVFS_DIR || `/run/user/${os.userInfo().uid}/gvfs`;

/**
 * Le partage est-il déjà monté par GVFS ? Chemin du montage, ou `null`. Avec un
 * compte, seul un montage **de ce compte** convient : un montage invité ou d'un
 * autre compte n'a pas les mêmes droits.
 */
export function findShareMount({ host, share, account = null }, gvfsDir = defaultGvfsDir()) {
  let names = [];
  try { names = fs.readdirSync(gvfsDir); } catch { return null; }
  const same = (a, b) => String(a ?? '').normalize('NFC').toLowerCase() === String(b ?? '').normalize('NFC').toLowerCase();
  for (const name of names) {
    const fields = mountFields(name);
    if (!fields || !same(fields.server, host) || !same(fields.share, share)) continue;
    if (account && (!same(fields.user, account.user) || (account.domain && fields.domain && !same(fields.domain, account.domain)))) continue;
    return path.join(gvfsDir, name);
  }
  return null;
}

/** Message d'un dossier qu'on ne peut pas lister : refus d'accès (compte) ou absence. */
function accessProblem(dir, subpath, target) {
  try {
    const handle = fs.opendirSync(dir);
    try { handle.readSync(); } finally { handle.closeSync(); }
    return null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return `Le dossier « ${subpath} » n’existe pas sur ${target.label.split('\\').slice(0, 4).join('\\')}.`;
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      const who = target.account ? `le compte ${target.account.label}` : 'le compte avec lequel le partage est monté (souvent l’accès invité)';
      return `Accès refusé à ${target.label} pour ${who}. Indique dans « Compte » celui que tu utilises sur le TSE (par exemple SRVMURGAT\\TonNom), puis « Se connecter ».`;
    }
    return `${target.label} illisible : ${error.message}`;
  }
}

/** `gio mount <uri>`, sans terminal : réussit si le trousseau connaît déjà le mot de passe. */
export function gioMount(uri, { command = process.env.WORKLOGS_GIO_COMMAND || 'gio', timeoutMs = 20_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, ['mount', uri], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, message: error.message });
      return;
    }
    let message = '';
    child.stderr?.on('data', (chunk) => { message += chunk; });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, message: 'délai dépassé' }); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, message: error.message }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, message: message.trim() }); });
  });
}

/**
 * Gestionnaires de fichiers qui montent un `smb://` par GVFS **et** demandent le mot
 * de passe dans leur propre fenêtre. Pas `xdg-open` : sous Cinnamon (et GNOME), il
 * passe par `gio open`, qui refuse une adresse non montée (« L’emplacement indiqué
 * n’est pas monté ») sans rien afficher — constaté sur Linux Mint le 2026-10-06.
 */
const FILE_MANAGERS = [
  { desktop: /^nemo/i, command: 'nemo' },
  { desktop: /nautilus/i, command: 'nautilus' },
  { desktop: /^caja/i, command: 'caja' },
  { desktop: /^thunar/i, command: 'thunar' },
];

function installed(command, searchPath = process.env.PATH || '') {
  return searchPath.split(path.delimiter).filter(Boolean).some((dir) => {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function defaultFolderHandler() {
  try {
    return execFileSync('xdg-mime', ['query', 'default', 'inode/directory'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Le gestionnaire de fichiers à qui confier la connexion : celui du bureau d'abord, sinon le premier installé. */
export function findFileManager({ defaultHandler = defaultFolderHandler(), exists = installed } = {}) {
  const preferred = FILE_MANAGERS.find((manager) => manager.desktop.test(defaultHandler));
  if (preferred && exists(preferred.command)) return preferred.command;
  return FILE_MANAGERS.find((manager) => exists(manager.command))?.command ?? null;
}

/**
 * Trouve, ou monte, le partage. Ordre : déjà monté → `gio mount` (trousseau) →
 * fenêtre de connexion du gestionnaire de fichiers, puis on attend que le montage
 * apparaisse (le temps de saisir le mot de passe). Renvoie le dossier à utiliser.
 */
export async function connectShare(address, {
  account = null,
  gvfsDir = defaultGvfsDir(),
  mount = gioMount,
  openLocation,
  waitMs = 120_000,
  pollMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const target = parseShareAddress(address, account);
  // Le dossier visé doit se lister : un montage sans droits (invité) est dit tel quel.
  const withSubpath = (root) => {
    const full = target.subpath ? path.join(root, ...target.subpath.split('/')) : root;
    const problem = accessProblem(full, target.subpath, target);
    if (problem) throw new Error(problem);
    return full;
  };
  let found = findShareMount(target, gvfsDir);
  if (found) return { ...target, path: withSubpath(found), how: 'déjà monté' };
  const mounted = await mount(target.uri);
  found = findShareMount(target, gvfsDir);
  if (found) return { ...target, path: withSubpath(found), how: 'gio' };
  if (!openLocation) throw new Error(`Impossible de monter ${target.label} : ${mounted.message || 'refusé'}.`);
  // Mot de passe à saisir : la fenêtre de connexion du gestionnaire de fichiers.
  // Si elle ne peut pas s'ouvrir, on le dit tout de suite au lieu d'attendre pour rien.
  const failure = await openLocation(target.uri);
  if (failure) {
    throw new Error(`La fenêtre de connexion ne s’est pas ouverte (${failure}). Monte ${target.label} dans le gestionnaire de fichiers (Autres emplacements → Connexion à un serveur), puis « ou choisir un dossier déjà monté… ».`);
  }
  for (let waited = 0; waited < waitMs; waited += pollMs) {
    await sleep(pollMs);
    found = findShareMount(target, gvfsDir);
    if (found) return { ...target, path: withSubpath(found), how: 'fenêtre' };
  }
  throw new Error(`${target.label} n’est toujours pas monté : identifiants refusés, ou serveur injoignable depuis ce poste (VPN ?).`);
}
