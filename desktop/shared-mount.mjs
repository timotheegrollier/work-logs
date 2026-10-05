import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Monter le dossier du TSE comme le fait Nemo (« Se connecter à un serveur ») :
 * GVFS, sans droits administrateur. Le partage apparaît sous
 * `/run/user/<uid>/gvfs/smb-share:server=…,share=…` et WorkLogs le traite comme
 * un dossier. Les identifiants ne passent **jamais** par WorkLogs : `gio mount`
 * réutilise ceux du trousseau ; à défaut, le gestionnaire de fichiers ouvre sa
 * propre fenêtre de connexion. Voir `docs/05-DECISIONS.md` §25.
 */

/**
 * `\\TSE01\Commun\Procédures`, `//tse01/commun`, `smb://tse01/commun/x` ou
 * `tse01/commun` → `{ uri: 'smb://tse01/commun', host, share, subpath }`.
 */
export function parseShareAddress(input) {
  let value = String(input ?? '').trim();
  if (!value) throw new Error('Indique l’adresse du partage, par exemple \\\\serveur\\partage.');
  value = value.replace(/\\/g, '/');
  value = value.replace(/^smb:\/*/i, '').replace(/^\/+/, '');
  // Identifiants éventuels dans l'adresse (`domaine;utilisateur@hôte`) : on les écarte.
  const at = value.indexOf('@');
  if (at !== -1 && at < value.indexOf('/')) value = value.slice(at + 1);
  const parts = value.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Adresse incomplète : il faut le serveur et le partage, par exemple \\\\serveur\\partage.');
  const [host, share, ...rest] = parts;
  if (!/^[\w.-]+$/.test(host)) throw new Error(`Nom de serveur invalide : « ${host} ».`);
  if (/[\x00-\x1f]/.test(value)) throw new Error('Adresse invalide.');
  return {
    uri: `smb://${host}/${encodeURIComponent(share)}`,
    host,
    share,
    subpath: rest.join('/'),
    label: `\\\\${host}\\${share}${rest.length ? '\\' + rest.join('\\') : ''}`,
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

/** Le partage est-il déjà monté par GVFS ? Chemin du montage, ou `null`. */
export function findShareMount({ host, share }, gvfsDir = defaultGvfsDir()) {
  let names = [];
  try { names = fs.readdirSync(gvfsDir); } catch { return null; }
  const wantedHost = host.toLowerCase();
  const wantedShare = share.toLowerCase();
  for (const name of names) {
    const fields = mountFields(name);
    if (fields && fields.server?.toLowerCase() === wantedHost && fields.share?.toLowerCase() === wantedShare) {
      return path.join(gvfsDir, name);
    }
  }
  return null;
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
 * Trouve, ou monte, le partage. Ordre : déjà monté → `gio mount` (trousseau) →
 * fenêtre de connexion du gestionnaire de fichiers, puis on attend que le montage
 * apparaisse (le temps de saisir le mot de passe). Renvoie le dossier à utiliser.
 */
export async function connectShare(address, {
  gvfsDir = defaultGvfsDir(),
  mount = gioMount,
  openLocation,
  waitMs = 120_000,
  pollMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const target = parseShareAddress(address);
  const withSubpath = (root) => {
    if (!target.subpath) return root;
    const full = path.join(root, ...target.subpath.split('/'));
    if (!fs.existsSync(full)) throw new Error(`Le dossier « ${target.subpath} » n’existe pas sur ${target.label.split('\\').slice(0, 4).join('\\')}.`);
    return full;
  };
  let found = findShareMount(target, gvfsDir);
  if (found) return { ...target, path: withSubpath(found), how: 'déjà monté' };
  const mounted = await mount(target.uri);
  found = findShareMount(target, gvfsDir);
  if (found) return { ...target, path: withSubpath(found), how: 'gio' };
  if (!openLocation) throw new Error(`Impossible de monter ${target.label} : ${mounted.message || 'refusé'}.`);
  // Mot de passe à saisir : la fenêtre de connexion du gestionnaire de fichiers.
  await openLocation(target.uri);
  for (let waited = 0; waited < waitMs; waited += pollMs) {
    await sleep(pollMs);
    found = findShareMount(target, gvfsDir);
    if (found) return { ...target, path: withSubpath(found), how: 'fenêtre' };
  }
  throw new Error(`${target.label} n’est toujours pas monté : identifiants refusés, ou serveur injoignable depuis ce poste (VPN ?).`);
}
