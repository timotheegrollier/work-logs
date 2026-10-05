import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nowISO, uid } from './db.js';
import { createSharedIo, SharedIoError, transferTimeout } from './shared-io.js';
import { describeLock, formatWorkLogsLock, isTechnicalName, libreOfficeLockName, lockAppLabel, lockBlocks, ownerFileName } from './shared-locks.js';

/**
 * Dossier partagé (le dossier du TSE monté en SMB) : la **référence** des
 * fichiers d'équipe. WorkLogs les lit, garde chaque version vue ou envoyée dans
 * un magasin local, enregistre les brouillons sur cet ordinateur seulement, et
 * n'écrit sur le partage que sur un geste explicite — **jamais par-dessus une
 * version qu'il n'a pas vue**. Voir `docs/05-DECISIONS.md` §25.
 *
 * Les octets sont traités ici ; les formats (texte, CSV…) sont lus et réécrits
 * par le front. Tout accès au partage passe par `shared-io.js` (délais bornés).
 */

const MAX_FILE = 100 * 1024 * 1024;
const MAX_LIST = 2000;
const MAX_SCAN = 5000;
const MAX_DRAFT = 4.5 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;
const DAY = 24 * 60 * 60 * 1000;
const KEEP_VERSIONS = 30;
const KEEP_DAYS = 90;
const MAX_STORE = 1024 ** 3;
const MOUNT_CHECK_MS = 15_000;
/** Notre verrou est renouvelé chaque minute par l'éditeur ; sans nouvelles depuis 3 min, il est rendu. */
const LEASE_MS = 3 * 60 * 1000;
/** Le verrou WorkLogs d'un autre poste est jugé oublié après 3 min d'observation sans renouvellement. */
const STALE_WATCH_MS = 3 * 60 * 1000;
const KEPT_STATES = new Set(['conflict', 'archived', 'pending']);

/** Types `statfs` des montages réseau : CIFS, SMB2/3, SMB1, FUSE (GVFS). */
const NETWORK_MOUNTS = new Map([[0xff534d42, 'cifs'], [0xfe534d42, 'smb2'], [0x517b, 'smb'], [0x65735546, 'fuse']]);
const isNetworkMount = (type) => NETWORK_MOUNTS.has(Number(type) >>> 0);
export function mountName(type, root) {
  if (/\/gvfs\//.test(root || '')) return 'gvfs';
  return NETWORK_MOUNTS.get(Number(type) >>> 0) ?? 'local';
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export class SharedError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const REACH_MESSAGES = {
  unconfigured: ['SHARED_UNCONFIGURED', 'Aucun dossier partagé n’est choisi.'],
  offline: ['SHARED_OFFLINE', 'Le dossier partagé ne répond pas (réseau ou VPN ?).'],
  unmounted: ['SHARED_UNMOUNTED', 'Le dossier partagé n’est pas monté sur cet ordinateur.'],
  blocked: ['SHARED_BLOCKED', 'Le dossier partagé ne répond plus : WorkLogs attend qu’il se libère.'],
};
const reachError = (reach) => {
  const [code, message] = REACH_MESSAGES[reach] || REACH_MESSAGES.offline;
  return new SharedError(503, code, message, { reach });
};
const isOffline = (error) => error?.code === 'SHARED_OFFLINE' || error?.code === 'SHARED_BLOCKED'
  || error?.code === 'SHARED_UNMOUNTED' || (error instanceof SharedError && error.status === 503);

/** Erreur d'E/S → erreur lisible, avec le bon statut HTTP. */
export function toSharedError(error) {
  if (error instanceof SharedError) return error;
  if (error instanceof SharedIoError) {
    if (error.code === 'SHARED_OFFLINE') return reachError('offline');
    if (error.code === 'SHARED_BLOCKED') return reachError('blocked');
    if (error.code === 'ENOENT') return new SharedError(404, 'SHARED_NOT_FOUND', 'Fichier introuvable sur le dossier partagé.');
    if (error.code === 'EACCES' || error.code === 'EPERM') return new SharedError(403, 'SHARED_DENIED', 'Le dossier partagé refuse l’accès à ce fichier.');
    if (error.code === 'EFBIG') return new SharedError(413, 'SHARED_TOO_BIG', 'Fichier trop volumineux (100 Mo au plus).');
    if (error.code === 'ENOTDIR') return new SharedError(400, 'SHARED_NOT_DIR', 'Ce n’est pas un dossier.');
    if (error.code === 'EISDIR') return new SharedError(400, 'SHARED_NOT_FILE', 'Ce n’est pas un fichier.');
  }
  return new SharedError(500, 'SHARED_ERROR', `Dossier partagé : ${error?.message || 'erreur inconnue'}`);
}

/** Nom complet du compte Linux (champ GECOS), sinon l'identifiant. */
export function defaultDisplayName() {
  const { username } = os.userInfo();
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((row) => row.startsWith(username + ':'));
    const full = line?.split(':')[4]?.split(',')[0]?.trim();
    if (full) return full;
  } catch {}
  return username;
}

/** Identifiant de cette installation : une base copiée ailleurs ne revendique pas nos verrous. */
export function instanceId(dataDir) {
  let machine = '';
  try { machine = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch {}
  return sha256(`${machine || os.hostname()}\0${path.resolve(dataDir)}`).slice(0, 16);
}

const pad = (n) => String(n).padStart(2, '0');
/** `Nom (copie T. Grollier 2026-10-05 10h47).ext` — caractères interdits par Windows retirés. */
export function copyName(name, author, date, attempt = 1) {
  const extension = path.extname(name);
  const base = name.slice(0, name.length - extension.length) || name;
  const who = String(author || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'WorkLogs';
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}h${pad(date.getMinutes())}`;
  const suffix = ` (copie ${who} ${stamp}${attempt > 1 ? ` ${attempt}` : ''})`;
  const room = Math.max(8, 180 - suffix.length - extension.length);
  return base.slice(0, room) + suffix + extension;
}

/** Chemin relatif sûr : segments non vides, ni `.` ni `..`, ni caractère de contrôle. */
export function relativeParts(rel, { allowRoot = false } = {}) {
  if (typeof rel !== 'string') throw new SharedError(400, 'SHARED_BAD_PATH', 'Chemin invalide.');
  if (rel === '') {
    if (allowRoot) return [];
    throw new SharedError(400, 'SHARED_BAD_PATH', 'Chemin requis.');
  }
  if (rel.length > 1024 || /[\x00-\x1f\x7f\\]/.test(rel)) throw new SharedError(400, 'SHARED_BAD_PATH', 'Chemin invalide.');
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new SharedError(400, 'SHARED_BAD_PATH', 'Chemin invalide.');
  }
  return parts;
}

const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const joinRel = (dir, name) => (dir ? `${dir}/${name}` : name);

const FILE_COLUMNS = ['base_hash', 'seen_hash', 'seen_size', 'seen_mtime_ms', 'template_hash', 'draft_json',
  'draft_updated_at', 'send_hash', 'send_requested', 'send_started_at', 'state', 'note', 'theirs_hash',
  'theirs_deleted', 'lock_nonce', 'lock_renewed_at'];
const EMPTY_FILE = Object.fromEntries(FILE_COLUMNS.map((column) => [column, null]));
Object.assign(EMPTY_FILE, { send_requested: 0, state: '', note: '', theirs_deleted: 0 });

export function createSharedService({
  db,
  blobDir,
  root = null,
  configurable = false,
  io = createSharedIo(),
  clock = () => Date.now(),
  retryMs = 30_000,
  probeMs = 10_000,
  mountCheckMs = MOUNT_CHECK_MS,
  instance = '',
  user = os.userInfo().username,
  host = os.hostname(),
}) {
  fs.mkdirSync(blobDir, { recursive: true });

  // ------------------------------------------------------------ réglages locaux
  const setting = (key) => db.prepare('SELECT value FROM local_settings WHERE key=?').get(key)?.value ?? null;
  const setSetting = (key, value) => {
    if (value === null || value === undefined) db.prepare('DELETE FROM local_settings WHERE key=?').run(key);
    else {
      db.prepare(`INSERT INTO local_settings (key,value,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, String(value), nowISO());
    }
  };
  const rootPath = () => root || setting('shared.root');
  const displayName = () => setting('shared.display_name') || defaultDisplayName();

  // ------------------------------------------------------------ magasin local
  const blobPath = (hash) => path.join(blobDir, hash.slice(0, 2), hash);
  const hasBlob = (hash) => Boolean(hash) && HASH_RE.test(hash) && fs.existsSync(blobPath(hash));
  const readBlob = (hash) => {
    if (!hash || !HASH_RE.test(hash)) return null;
    try { return fs.readFileSync(blobPath(hash)); } catch { return null; }
  };
  const storeBlob = (hash, bytes) => {
    const file = blobPath(hash);
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, file);
  };

  // ------------------------------------------------------------ lignes locales
  const getRow = (rel) => db.prepare('SELECT * FROM shared_files WHERE rel_path=?').get(rel) ?? null;
  const save = (rel, fields) => {
    const next = { ...EMPTY_FILE, ...(getRow(rel) ?? {}), ...fields };
    const columns = ['rel_path', ...FILE_COLUMNS, 'updated_at'];
    db.prepare(`INSERT INTO shared_files (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
      ON CONFLICT(rel_path) DO UPDATE SET ${[...FILE_COLUMNS, 'updated_at'].map((c) => `${c}=excluded.${c}`).join(',')}`)
      .run(rel, ...FILE_COLUMNS.map((column) => next[column] ?? null), nowISO());
    return getRow(rel);
  };
  const addVersion = (rel, hash, size, origin, state) => {
    const last = db.prepare('SELECT * FROM shared_versions WHERE rel_path=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(rel);
    if (last && last.hash === hash && last.origin === origin) {
      if (last.state !== state) db.prepare('UPDATE shared_versions SET state=? WHERE id=?').run(state, last.id);
      return last.id;
    }
    const id = uid('sv_');
    db.prepare('INSERT INTO shared_versions (id,rel_path,hash,size,origin,state,author,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, rel, hash, size, origin, state, origin === 'mine' ? displayName() : '', new Date(clock()).toISOString());
    return id;
  };
  const markVersions = (rel, hash, from, to) => {
    db.prepare("UPDATE shared_versions SET state=? WHERE rel_path=? AND hash=? AND origin='mine' AND state=?").run(to, rel, hash, from);
  };

  // ------------------------------------------------------------ joignabilité
  let mount = { at: -Infinity, root: null, reach: 'unconfigured', real: null, type: null };
  let lastProbe = -Infinity;
  let retryRun = null;

  /**
   * Le partage répond-il, et est-ce bien lui ? Un point de montage vide (partage
   * démonté) répond très bien… avec un dossier local : on compare le type de
   * système de fichiers à celui relevé quand le partage était là.
   */
  async function reach({ force = false } = {}) {
    const current = rootPath();
    if (!current) return { reach: 'unconfigured' };
    const breaker = io.state().breaker;
    if (breaker === 'blocked') return { ...mount, reach: 'blocked' };
    const now = clock();
    if (breaker === 'open') {
      if (!force && now - lastProbe < probeMs) return { ...mount, reach: 'offline' };
      lastProbe = now;
    } else if (!force && mount.root === current && now - mount.at < (mount.reach === 'ok' ? mountCheckMs : probeMs)) {
      return mount;
    }
    const before = mount.reach;
    let next;
    try {
      const { type } = await io.call('statfs', [current], { probe: breaker === 'open' });
      const real = await io.call('realpath', [current]);
      const recordedRoot = setting('shared.fs_root');
      const recorded = Number(setting('shared.fs_type'));
      if (recordedRoot === current && isNetworkMount(recorded) && recorded !== type) {
        next = { at: now, root: current, reach: 'unmounted', real: null, type };
      } else {
        if (recordedRoot !== current || recorded !== type) {
          setSetting('shared.fs_root', current);
          setSetting('shared.fs_type', type);
        }
        next = { at: now, root: current, reach: 'ok', real, type };
      }
    } catch (error) {
      const code = error?.code;
      next = {
        at: now, root: current, real: null, type: null,
        reach: code === 'ENOENT' || code === 'ENOTDIR' ? 'unmounted' : code === 'SHARED_BLOCKED' ? 'blocked' : 'offline',
      };
    }
    mount = next;
    // Le partage revient : les envois en attente partent aussitôt.
    if (next.reach === 'ok' && before !== 'ok' && before !== 'unconfigured') setImmediate(() => { void retryPending(); });
    return mount;
  }

  async function requireReach() {
    const current = await reach();
    if (current.reach !== 'ok') throw reachError(current.reach);
    return current;
  }

  /** Chemin absolu d'un chemin relatif, vérifié à l'intérieur du partage (liens symboliques compris). */
  async function locate(rel, { allowRoot = false, mayNotExist = false } = {}) {
    const parts = relativeParts(rel, { allowRoot });
    const { real } = await requireReach();
    const inside = (candidate) => candidate === real || candidate.startsWith(real + path.sep);
    const abs = path.join(real, ...parts);
    let checked;
    try {
      checked = await io.call('realpath', [abs]);
    } catch (error) {
      if (error.code === 'ENOENT' && mayNotExist && parts.length) {
        const parent = await io.call('realpath', [path.dirname(abs)]);
        if (!inside(parent)) throw new SharedError(403, 'SHARED_OUTSIDE', 'Ce chemin sort du dossier partagé.');
        return { abs, parts, missing: true };
      }
      throw error;
    }
    if (!inside(checked)) throw new SharedError(403, 'SHARED_OUTSIDE', 'Ce chemin sort du dossier partagé.');
    return { abs, parts, missing: false };
  }

  // ------------------------------------------------------------ verrous lus
  const observed = new Map();
  /**
   * Verrou WorkLogs d'un autre poste : renouvelé chaque minute tant qu'on y écrit.
   * Si sa date n'a pas bougé depuis 3 min **d'observation**, il est oublié (plantage,
   * coupure). Mesuré avec notre seule horloge : un décalage d'heure avec le TSE ne
   * fausse rien.
   */
  function observe(lockPath, lock, libre) {
    if (!lock || lock.app !== 'worklogs' || lock.self || !libre) return lock;
    const seen = observed.get(lockPath);
    if (!seen || seen.mtimeMs !== libre.mtimeMs) {
      observed.set(lockPath, { mtimeMs: libre.mtimeMs, since: clock() });
      return lock;
    }
    return clock() - seen.since >= STALE_WATCH_MS ? { ...lock, stale: true } : lock;
  }
  const lockPathOf = (abs) => path.join(path.dirname(abs), libreOfficeLockName(path.basename(abs)));

  async function lockFor(abs) {
    const name = path.basename(abs);
    const dir = path.dirname(abs);
    const [owner, libre] = await io.call('readMany', [[path.join(dir, ownerFileName(name)), lockPathOf(abs)], 4096]);
    return observe(lockPathOf(abs), describeLock({ name, owner, libre, instance, user, host, now: clock() }), libre);
  }
  const lockNote = (lock) => `Ouvert par ${lock.by} dans ${lockAppLabel(lock.app)}`;

  // ------------------------------------------------------------ notre verrou
  const lockMarker = (nonce) => `worklogs:${instance}:${nonce}`;
  const lockBytes = (nonce) => Buffer.from(formatWorkLogsLock({
    displayName: displayName(), user, host, instance, nonce, date: new Date(clock()),
  }), 'utf8');

  /**
   * Prend (ou renouvelle) la main sur un fichier : un `.~lock.<nom>#` au format
   * LibreOffice, que LibreOffice et les autres WorkLogs respectent. Word et Excel
   * l'ignorent — leur propre fichier `~$`, lui, n'est jamais touché.
   */
  async function acquireLock(rel, { takeOver = false } = {}) {
    relativeParts(rel);
    try {
      const located = await locate(rel);
      const lockPath = lockPathOf(located.abs);
      const row = getRow(rel);
      if (row?.lock_nonce) {
        const renewed = await io.call('renewLock', [lockPath, lockBytes(row.lock_nonce), lockMarker(row.lock_nonce)]);
        if (renewed.result === 'renewed') {
          save(rel, { lock_renewed_at: new Date(clock()).toISOString() });
          return payload(rel, { lock: await lockFor(located.abs) });
        }
        // Perdu (repris par quelqu'un) : on repart de zéro, sans rien écraser.
        save(rel, { lock_nonce: null, lock_renewed_at: null });
      }
      const current = await lockFor(located.abs);
      const ours = current?.app === 'worklogs' && current.self;
      if (current && !ours && !takeOver) {
        // Un verrou oublié se reprend, mais seulement sur demande explicite.
        throw new SharedError(409, current.stale ? 'SHARED_LOCK_STALE' : 'SHARED_LOCKED',
          current.stale ? `${lockNote(current)} — probablement oublié.` : `${lockNote(current)}.`, { lock: current });
      }
      // Un verrou LibreOffice/WorkLogs repris est remplacé ; nos restes d'un plantage aussi.
      if (current && takeOver && (current.app === 'libreoffice' || current.app === 'worklogs')) await io.call('unlink', [lockPath]);
      await io.call('unlinkIfMarked', [lockPath, `worklogs:${instance}:`]);
      const nonce = crypto.randomBytes(6).toString('hex');
      const created = await io.call('createExclusive', [lockPath, lockBytes(nonce)]);
      if (!created.created) {
        const other = await lockFor(located.abs);
        throw new SharedError(409, 'SHARED_LOCKED', other ? `${lockNote(other)}.` : 'Quelqu’un vient d’ouvrir ce fichier.', { lock: other });
      }
      save(rel, { lock_nonce: nonce, lock_renewed_at: new Date(clock()).toISOString() });
      return payload(rel, { lock: await lockFor(located.abs) });
    } catch (error) {
      throw toSharedError(error);
    }
  }

  /** Rend la main : retire notre verrou, jamais celui d'un autre. Hors ligne, il vieillira seul. */
  async function releaseLock(rel) {
    const row = getRow(rel);
    if (!row?.lock_nonce) return payload(rel);
    const nonce = row.lock_nonce;
    save(rel, { lock_nonce: null, lock_renewed_at: null });
    try {
      const located = await locate(rel, { mayNotExist: true });
      await io.call('unlinkIfMarked', [lockPathOf(located.abs), lockMarker(nonce)]);
    } catch {
      // Partage injoignable : notre verrou restera, les autres le verront vieillir.
    }
    return payload(rel);
  }

  /** Bail : sans renouvellement depuis 3 min (onglet fermé, plantage), la main est rendue. */
  async function expireLocks() {
    const limit = clock() - LEASE_MS;
    for (const row of db.prepare('SELECT rel_path, lock_renewed_at FROM shared_files WHERE lock_nonce IS NOT NULL').all()) {
      if (!row.lock_renewed_at || Date.parse(row.lock_renewed_at) < limit) await releaseLock(row.rel_path);
    }
  }
  async function releaseAll() {
    for (const row of db.prepare('SELECT rel_path FROM shared_files WHERE lock_nonce IS NOT NULL').all()) await releaseLock(row.rel_path);
  }

  // ------------------------------------------------------------ vues
  function payload(rel, extra = {}) {
    const row = getRow(rel) ?? { ...EMPTY_FILE };
    let draft = null;
    if (row.draft_json) {
      try {
        draft = { model: JSON.parse(row.draft_json), template_hash: row.template_hash, updated_at: row.draft_updated_at };
      } catch {
        draft = null;
      }
    }
    return {
      path: rel,
      name: path.posix.basename(rel),
      ext: path.extname(rel).slice(1).toLowerCase(),
      hash: row.seen_hash,
      size: row.seen_size,
      mtime: isoOf(row.seen_mtime_ms),
      base_hash: row.base_hash,
      draft,
      state: row.state || '',
      note: row.note || '',
      theirs: row.state === 'conflict'
        ? { hash: row.theirs_hash, deleted: Boolean(row.theirs_deleted), size: row.theirs_deleted ? null : row.seen_size, mtime: row.theirs_deleted ? null : isoOf(row.seen_mtime_ms), author: null }
        : null,
      send: { hash: row.send_hash, requested: Boolean(row.send_requested) },
      /** Cette installation tient la main sur le fichier (notre `.~lock#`). */
      held: Boolean(row.lock_nonce),
      lock: null,
      source: 'share',
      ...extra,
    };
  }

  const localState = (row, entry) => (row
    ? {
      state: row.state || '',
      draft: Boolean(row.draft_json),
      modified: Boolean(entry) && row.seen_size !== null && (entry.size !== row.seen_size || entry.mtimeMs !== row.seen_mtime_ms),
    }
    : null);

  function cachedEntries(dir) {
    return db.prepare('SELECT * FROM shared_files').all()
      .filter((row) => parentOf(row.rel_path) === dir && hasBlob(row.seen_hash || row.base_hash))
      .sort((a, b) => collator.compare(a.rel_path, b.rel_path))
      .map((row) => ({
        name: path.posix.basename(row.rel_path), path: row.rel_path, type: 'file', size: row.seen_size,
        mtime: isoOf(row.seen_mtime_ms), ext: path.extname(row.rel_path).slice(1).toLowerCase(),
        lock: null, local: localState(row, null), cached: true,
      }));
  }

  // ------------------------------------------------------------ envoi gardé
  const queues = new Map();
  /** Un seul envoi (ou réglage de conflit) à la fois par fichier. */
  function exclusive(rel, task) {
    const previous = queues.get(rel) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    queues.set(rel, tail);
    void tail.then(() => { if (queues.get(rel) === tail) queues.delete(rel); });
    return run;
  }

  const answer = (status, rel, body) => ({ status, body: { ...body, file: payload(rel) } });
  const mark = (rel, state, note, extra = {}) => {
    save(rel, { state, note });
    return answer(202, rel, { state, note, ...extra });
  };
  const offlineNote = 'Hors ligne — gardé sur cet ordinateur, envoyé dès que le partage répond.';

  function written(rel, row, result) {
    const fields = {
      base_hash: row.send_hash, seen_hash: row.send_hash, seen_size: result.size, seen_mtime_ms: result.mtimeMs,
      send_requested: 0, state: '', note: '', theirs_hash: null, theirs_deleted: 0,
    };
    // Le brouillon est consommé, sauf s'il a encore bougé depuis la demande d'envoi.
    if (row.draft_json && (!row.draft_updated_at || !row.send_started_at || row.draft_updated_at <= row.send_started_at)) {
      Object.assign(fields, { draft_json: null, draft_updated_at: null, template_hash: null });
    } else if (row.draft_json) {
      fields.state = 'draft';
    }
    markVersions(rel, row.send_hash, 'pending', 'written');
    save(rel, fields);
    prune(rel);
    return answer(200, rel, { state: 'written', hash: row.send_hash, mtime: isoOf(result.mtimeMs) });
  }

  async function attempt(rel) {
    const row = getRow(rel);
    if (!row?.send_requested) return answer(200, rel, { state: row?.state || '' });
    const mine = readBlob(row.send_hash);
    if (!mine) {
      save(rel, { send_requested: 0, state: row.draft_json ? 'draft' : '' });
      throw new SharedError(500, 'SHARED_LOST', 'La version à envoyer est introuvable sur cet ordinateur.');
    }
    let located;
    let lock = null;
    try {
      located = await locate(rel, { mayNotExist: true });
      lock = await lockFor(located.abs);
    } catch (error) {
      if (isOffline(error)) return mark(rel, 'offline', offlineNote);
      throw toSharedError(error);
    }
    // LibreOffice et les autres WorkLogs annoncent leur verrou : on attend notre tour.
    // LibreOffice ouvert sur cet ordinateur (« Ouvrir avec… ») compte aussi.
    if (lockBlocks(lock) && (lock.app === 'libreoffice' || lock.app === 'worklogs')) {
      return mark(rel, 'pending', lockNote(lock), { lock });
    }
    if (located.missing) {
      save(rel, { state: 'conflict', theirs_hash: null, theirs_deleted: 1, send_requested: 0, note: 'Supprimé du dossier partagé.' });
      markVersions(rel, row.send_hash, 'pending', 'conflict');
      return answer(409, rel, { code: 'SHARED_CONFLICT', state: 'conflict', deleted: true, theirs: null });
    }
    let result;
    try {
      result = await io.call('writeGuarded', [located.abs, mine, row.base_hash, row.send_hash, row.state === 'interrupted'],
        { timeoutMs: transferTimeout(mine.length) * 2 });
    } catch (error) {
      if (isOffline(error)) return mark(rel, 'offline', offlineNote);
      throw toSharedError(error);
    }
    switch (result.result) {
      case 'written':
      case 'same':
        return written(rel, row, result);
      case 'busy':
        // Windows tient le fichier ouvert (Word, Excel) : son fichier `~$` dit qui.
        return mark(rel, 'pending', lock ? lockNote(lock) : 'Ouvert sous Windows (Word ou Excel ?)', { lock });
      case 'denied':
        if (lock) return mark(rel, 'pending', lockNote(lock), { lock });
        save(rel, { send_requested: 0, state: row.draft_json ? 'draft' : '', note: '' });
        throw new SharedError(403, 'SHARED_DENIED', 'WorkLogs n’a pas le droit d’écrire ce fichier sur le dossier partagé.');
      case 'missing':
        save(rel, { state: 'conflict', theirs_hash: null, theirs_deleted: 1, send_requested: 0, note: 'Supprimé du dossier partagé.' });
        markVersions(rel, row.send_hash, 'pending', 'conflict');
        return answer(409, rel, { code: 'SHARED_CONFLICT', state: 'conflict', deleted: true, theirs: null });
      case 'changed': {
        const theirs = Buffer.from(result.theirs);
        storeBlob(result.hash, theirs);
        addVersion(rel, result.hash, theirs.length, 'theirs', 'conflict');
        markVersions(rel, row.send_hash, 'pending', 'conflict');
        save(rel, {
          state: 'conflict', note: '', theirs_hash: result.hash, theirs_deleted: 0, send_requested: 0,
          seen_hash: result.hash, seen_size: result.size, seen_mtime_ms: result.mtimeMs,
        });
        return answer(409, rel, {
          code: 'SHARED_CONFLICT', state: 'conflict',
          theirs: { hash: result.hash, size: result.size, mtime: isoOf(result.mtimeMs), author: null },
        });
      }
      case 'interrupted':
        return mark(rel, 'interrupted', 'Envoi interrompu : WorkLogs le reprendra sans écraser une autre version.');
      default:
        throw new SharedError(500, 'SHARED_ERROR', 'Réponse inattendue du dossier partagé.');
    }
  }

  /** Renvoie ce qui attend (verrou, hors ligne, interruption). Un seul passage à la fois. */
  function retryPending() {
    retryRun ??= (async () => {
      const rows = db.prepare('SELECT rel_path FROM shared_files WHERE send_requested=1').all();
      if (!rows.length) return;
      if ((await reach()).reach !== 'ok') return;
      for (const { rel_path: rel } of rows) {
        try { await exclusive(rel, () => attempt(rel)); } catch {}
      }
    })().finally(() => { retryRun = null; });
    return retryRun;
  }

  async function createCopy(rel, bytes) {
    const parent = parentOf(rel);
    const located = await locate(parent, { allowRoot: true });
    const date = new Date(clock());
    for (let attemptNumber = 1; attemptNumber <= 20; attemptNumber++) {
      const name = copyName(path.posix.basename(rel), displayName(), date, attemptNumber);
      const created = await io.call('createExclusive', [path.join(located.abs, name), bytes], { timeoutMs: transferTimeout(bytes.length) });
      if (created.created) {
        const copyRel = joinRel(parent, name);
        const hash = sha256(bytes);
        addVersion(copyRel, hash, bytes.length, 'mine', 'written');
        return copyRel;
      }
    }
    throw new SharedError(409, 'SHARED_COPY_TAKEN', 'Impossible de créer la copie : tous les noms essayés existent déjà.');
  }

  // ------------------------------------------------------------ rétention
  function protectedHashes() {
    const hashes = new Set();
    for (const row of db.prepare('SELECT base_hash, seen_hash, template_hash, send_hash, theirs_hash FROM shared_files').all()) {
      for (const hash of Object.values(row)) if (hash) hashes.add(hash);
    }
    return hashes;
  }

  /** Les 30 dernières versions, 90 jours au plus — jamais la base, un brouillon, un conflit ou une version mise de côté. */
  function prune(rel) {
    const keep = protectedHashes();
    const limit = clock() - KEEP_DAYS * DAY;
    let kept = 0;
    for (const version of db.prepare('SELECT * FROM shared_versions WHERE rel_path=? ORDER BY created_at DESC, rowid DESC').all(rel)) {
      kept++;
      if (keep.has(version.hash) || KEPT_STATES.has(version.state)) continue;
      if (kept > KEEP_VERSIONS || Date.parse(version.created_at) < limit) {
        db.prepare('DELETE FROM shared_versions WHERE id=?').run(version.id);
      }
    }
    collectGarbage();
  }

  /** 1 Go au plus pour tout le magasin, puis suppression des octets que plus rien ne référence. */
  function collectGarbage() {
    const keep = protectedHashes();
    const sizes = new Map(db.prepare('SELECT hash, MAX(size) size FROM shared_versions GROUP BY hash').all().map((row) => [row.hash, row.size]));
    let total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    if (total > MAX_STORE) {
      for (const version of db.prepare('SELECT * FROM shared_versions ORDER BY created_at ASC, rowid ASC').all()) {
        if (total <= MAX_STORE) break;
        if (keep.has(version.hash) || KEPT_STATES.has(version.state)) continue;
        db.prepare('DELETE FROM shared_versions WHERE id=?').run(version.id);
        if (!db.prepare('SELECT 1 FROM shared_versions WHERE hash=?').get(version.hash)) total -= sizes.get(version.hash) ?? 0;
      }
    }
    const referenced = new Set([...keep, ...db.prepare('SELECT DISTINCT hash FROM shared_versions').all().map((row) => row.hash)]);
    let folders = [];
    try { folders = fs.readdirSync(blobDir); } catch { return; }
    for (const folder of folders) {
      const dir = path.join(blobDir, folder);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (!referenced.has(file)) fs.rmSync(path.join(dir, file), { force: true });
      }
    }
  }

  // ------------------------------------------------------------ démarrage
  collectGarbage();
  // Verrous restés d'une session précédente (fermeture brutale) : rendus d'emblée.
  void releaseAll().catch(() => {});
  const timer = retryMs > 0 ? setInterval(() => {
    void retryPending();
    void expireLocks().catch(() => {});
  }, retryMs) : null;
  timer?.unref();

  return {
    configurable,

    async status() {
      const current = rootPath();
      const state = current ? await reach() : { reach: 'unconfigured' };
      const count = (where) => db.prepare(`SELECT COUNT(*) n FROM shared_files WHERE ${where}`).get().n;
      return {
        available: true,
        configurable,
        root: current,
        label: current ? path.basename(current) : '',
        mount: current && state.type !== null && state.type !== undefined ? mountName(state.type, current) : null,
        reach: state.reach,
        since: io.state().since,
        displayName: displayName(),
        projects: Object.fromEntries(db.prepare(
          'SELECT f.project_id, f.rel_dir FROM shared_project_folders f JOIN projects p ON p.id = f.project_id',
        ).all().map((row) => [row.project_id, row.rel_dir])),
        pending: count('send_requested=1'),
        conflicts: count("state='conflict'"),
      };
    },

    /** Choisi par le dialogue natif (IPC) — jamais par une route HTTP. */
    async configure(dir) {
      if (!configurable) throw new SharedError(403, 'SHARED_NOT_CONFIGURABLE', 'Le dossier partagé est fixé par la configuration.');
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new SharedError(400, 'SHARED_BAD_PATH', 'Chemin absolu attendu.');
      let real;
      let stat;
      let type;
      try {
        real = await io.call('realpath', [dir], { probe: true });
        stat = await io.call('stat', [real], { probe: true });
        ({ type } = await io.call('statfs', [real], { probe: true }));
      } catch (error) {
        throw toSharedError(error);
      }
      if (!stat.isDir) throw new SharedError(400, 'SHARED_NOT_DIR', 'Ce n’est pas un dossier.');
      if (real === path.parse(real).root || real === os.homedir()) {
        throw new SharedError(400, 'SHARED_TOO_WIDE', 'Choisis le dossier partagé lui-même, pas la racine ni ton dossier personnel.');
      }
      setSetting('shared.root', real);
      setSetting('shared.fs_root', real);
      setSetting('shared.fs_type', type);
      mount = { at: -Infinity, root: null, reach: 'unconfigured', real: null, type: null };
      return this.status();
    },

    async forget() {
      if (!configurable) throw new SharedError(403, 'SHARED_NOT_CONFIGURABLE', 'Le dossier partagé est fixé par la configuration.');
      for (const key of ['shared.root', 'shared.fs_root', 'shared.fs_type']) setSetting(key, null);
      mount = { at: -Infinity, root: null, reach: 'unconfigured', real: null, type: null };
      return this.status();
    },

    setDisplayName(value) {
      const name = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f,;\\]/g, ' ').trim().slice(0, 80) : '';
      setSetting('shared.display_name', name || null);
      return this.status();
    },

    async list(dir = '') {
      let located;
      try {
        located = await locate(dir, { allowRoot: true });
      } catch (error) {
        if (isOffline(error)) {
          relativeParts(dir, { allowRoot: true });
          const { reach: current = 'offline' } = error.extra ?? {};
          return { status: 503, body: { error: toSharedError(error).message, code: 'SHARED_OFFLINE', reach: current, dir, entries: cachedEntries(dir), truncated: false } };
        }
        throw toSharedError(error);
      }
      try {
        const { entries, total } = await io.call('readdir', [located.abs, MAX_SCAN], { timeoutMs: 15_000 });
        const byLowerName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
        const visible = entries
          .filter((entry) => !entry.isSymlink && (entry.isDir || entry.isFile) && !isTechnicalName(entry.name))
          .sort((a, b) => (a.isDir === b.isDir ? collator.compare(a.name, b.name) : a.isDir ? -1 : 1));
        const shown = visible.slice(0, MAX_LIST);
        // Les verrous sont dans le même dossier : on ne lit que ceux qui existent.
        const wanted = [];
        for (const entry of shown) {
          if (!entry.isFile) continue;
          const owner = byLowerName.get(ownerFileName(entry.name).toLowerCase());
          const libre = byLowerName.get(libreOfficeLockName(entry.name).toLowerCase());
          if (owner || libre) wanted.push({ entry, owner, libre });
        }
        const files = wanted.flatMap(({ owner, libre }) => [owner, libre].filter(Boolean).map((lockFile) => path.join(located.abs, lockFile.name)));
        const contents = files.length ? await io.call('readMany', [files, 4096]) : [];
        const locks = new Map();
        let index = 0;
        for (const { entry, owner, libre } of wanted) {
          const ownerBytes = owner ? contents[index++] : null;
          const libreBytes = libre ? contents[index++] : null;
          const lockPath = path.join(located.abs, libreOfficeLockName(entry.name));
          locks.set(entry.name, observe(lockPath, describeLock({ name: entry.name, owner: ownerBytes, libre: libreBytes, instance, user, host, now: clock() }), libreBytes));
        }
        const rows = new Map(db.prepare('SELECT * FROM shared_files').all()
          .filter((row) => parentOf(row.rel_path) === dir).map((row) => [row.rel_path, row]));
        return {
          dir,
          reach: 'ok',
          truncated: visible.length > MAX_LIST || total > MAX_SCAN,
          entries: shown.map((entry) => {
            const rel = joinRel(dir, entry.name);
            return {
              name: entry.name,
              path: rel,
              type: entry.isDir ? 'dir' : 'file',
              size: entry.isDir ? null : entry.size,
              mtime: isoOf(entry.mtimeMs),
              ext: entry.isDir ? '' : path.extname(entry.name).slice(1).toLowerCase(),
              lock: locks.get(entry.name) ?? null,
              local: entry.isDir ? null : localState(rows.get(rel) ?? null, entry),
            };
          }),
        };
      } catch (error) {
        throw toSharedError(error);
      }
    },

    async file(rel) {
      relativeParts(rel);
      let row = getRow(rel);
      let located;
      try {
        located = await locate(rel, { mayNotExist: true });
      } catch (error) {
        if (isOffline(error) && row && hasBlob(row.seen_hash || row.base_hash)) {
          return payload(rel, { source: 'cache', reach: error.extra?.reach || 'offline' });
        }
        throw toSharedError(error);
      }
      try {
        if (located.missing) {
          if (row && (row.draft_json || row.send_requested || row.state === 'conflict')) return payload(rel, { deleted: true });
          throw new SharedError(404, 'SHARED_NOT_FOUND', 'Fichier introuvable sur le dossier partagé.');
        }
        const stat = await io.call('stat', [located.abs]);
        if (!stat.isFile) throw new SharedError(400, 'SHARED_NOT_FILE', 'Ce n’est pas un fichier.');
        if (stat.size > MAX_FILE) throw new SharedError(413, 'SHARED_TOO_BIG', 'Fichier trop volumineux (100 Mo au plus).');
        if (!row || row.seen_size !== stat.size || row.seen_mtime_ms !== stat.mtimeMs || !hasBlob(row.seen_hash)) {
          const read = await io.call('readFile', [located.abs, MAX_FILE], { timeoutMs: transferTimeout(stat.size) });
          const bytes = Buffer.from(read.bytes);
          storeBlob(read.hash, bytes);
          addVersion(rel, read.hash, read.size, 'base', 'read');
          row = save(rel, { seen_hash: read.hash, seen_size: read.size, seen_mtime_ms: read.mtimeMs });
          prune(rel);
        }
        // Sans brouillon ni envoi en cours, la base suit le partage.
        if (!row.draft_json && !row.send_requested && row.state !== 'conflict' && row.base_hash !== row.seen_hash) {
          row = save(rel, { base_hash: row.seen_hash, state: '', note: '' });
        }
        const lock = await lockFor(located.abs);
        return payload(rel, { lock });
      } catch (error) {
        throw toSharedError(error);
      }
    },

    content(hash) {
      return readBlob(String(hash || ''));
    },

    /** Brouillon local : ne touche **jamais** le partage. */
    saveDraft(rel, body = {}) {
      relativeParts(rel);
      const { model, template_hash: templateHash, base_hash: baseHash } = body;
      if (!hasBlob(templateHash)) throw new SharedError(400, 'SHARED_BAD_TEMPLATE', 'Version de départ inconnue sur cet ordinateur.');
      if (baseHash !== undefined && baseHash !== null && !HASH_RE.test(baseHash)) throw new SharedError(400, 'SHARED_BAD_BASE', 'Version de base invalide.');
      const json = JSON.stringify(model ?? null);
      if (json.length > MAX_DRAFT) throw new SharedError(413, 'SHARED_DRAFT_TOO_BIG', 'Brouillon trop volumineux pour être gardé.');
      const row = getRow(rel);
      const fields = { draft_json: json, draft_updated_at: new Date(clock()).toISOString(), template_hash: templateHash };
      // La base n'est fixée qu'à la naissance du brouillon : c'est la version qu'il remplacera.
      if (!row?.draft_json) fields.base_hash = baseHash || row?.base_hash || templateHash;
      if (!row || !row.state || row.state === 'draft') fields.state = 'draft';
      save(rel, fields);
      return payload(rel);
    },

    /** Abandonne le brouillon ; ses octets (s'ils sont fournis) restent dans l'historique. */
    discardDraft(rel, bytes) {
      relativeParts(rel);
      const row = getRow(rel);
      if (row?.state === 'conflict') throw new SharedError(409, 'SHARED_CONFLICT_OPEN', 'Choisis d’abord comment régler le conflit.');
      if (bytes?.length) {
        const hash = sha256(bytes);
        storeBlob(hash, bytes);
        addVersion(rel, hash, bytes.length, 'mine', 'archived');
      }
      if (!row) return payload(rel);
      save(rel, {
        draft_json: null, draft_updated_at: null, template_hash: null, send_requested: 0, send_hash: null,
        state: '', note: '', base_hash: row.seen_hash || row.base_hash,
      });
      return payload(rel);
    },

    /** Envoi explicite : version locale d'abord, puis écriture gardée. */
    push(rel, base, input) {
      relativeParts(rel);
      const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
      if (bytes.length > MAX_FILE) throw new SharedError(413, 'SHARED_TOO_BIG', 'Fichier trop volumineux (100 Mo au plus).');
      if (base && !HASH_RE.test(base)) throw new SharedError(400, 'SHARED_BAD_BASE', 'Version de base invalide.');
      return exclusive(rel, async () => {
        const row = getRow(rel);
        if (row?.state === 'conflict') throw new SharedError(409, 'SHARED_CONFLICT_OPEN', 'Choisis d’abord comment régler le conflit.');
        const effectiveBase = row?.draft_json ? row.base_hash : base || row?.base_hash;
        if (!effectiveBase) throw new SharedError(400, 'SHARED_NOT_OPENED', 'Ouvre le fichier avant de l’envoyer.');
        const hash = sha256(bytes);
        storeBlob(hash, bytes);
        addVersion(rel, hash, bytes.length, 'mine', 'pending');
        save(rel, {
          base_hash: effectiveBase, send_hash: hash, send_requested: 1,
          send_started_at: new Date(clock()).toISOString(), state: 'pending', note: '',
        });
        return attempt(rel);
      });
    },

    resolve(rel, choice, theirs) {
      relativeParts(rel);
      if (!['mine', 'theirs', 'both'].includes(choice)) throw new SharedError(400, 'SHARED_BAD_CHOICE', 'Choix inconnu.');
      return exclusive(rel, async () => {
        const row = getRow(rel);
        if (row?.state !== 'conflict') throw new SharedError(409, 'SHARED_NO_CONFLICT', 'Aucun conflit à régler sur ce fichier.');
        if ((theirs || null) !== (row.theirs_hash || null)) {
          throw new SharedError(409, 'SHARED_STALE', 'Le fichier a encore changé : rouvre-le avant de choisir.');
        }
        const mine = readBlob(row.send_hash);
        if (!mine) throw new SharedError(500, 'SHARED_LOST', 'Ta version est introuvable sur cet ordinateur.');
        try {
          if (choice === 'mine') {
            if (row.theirs_deleted) {
              const located = await locate(rel, { mayNotExist: true });
              const created = await io.call('createExclusive', [located.abs, mine], { timeoutMs: transferTimeout(mine.length) });
              if (created.created) return written(rel, row, created);
              // Quelqu'un l'a recréé entre-temps : on relit et on repasse par la garde.
              save(rel, { state: 'pending', theirs_deleted: 0, send_requested: 1, base_hash: null });
              return attempt(rel);
            }
            save(rel, {
              base_hash: row.theirs_hash, send_requested: 1, send_started_at: new Date(clock()).toISOString(),
              state: 'pending', note: '', theirs_hash: null, theirs_deleted: 0,
            });
            return attempt(rel);
          }
          const copyPath = choice === 'both' ? await createCopy(rel, mine) : null;
          const state = choice === 'both' ? 'copied' : 'theirs';
          if (row.theirs_deleted) {
            db.prepare('DELETE FROM shared_files WHERE rel_path=?').run(rel);
            return { status: 200, body: { state, deleted: true, copyPath, file: null } };
          }
          save(rel, {
            base_hash: row.theirs_hash, draft_json: null, draft_updated_at: null, template_hash: null,
            send_hash: null, send_requested: 0, state: '', note: '', theirs_hash: null, theirs_deleted: 0,
          });
          return answer(200, rel, { state, hash: row.theirs_hash, copyPath });
        } catch (error) {
          throw toSharedError(error);
        }
      });
    },

    versions(rel) {
      relativeParts(rel);
      return {
        path: rel,
        versions: db.prepare(
          'SELECT id, hash, size, origin, state, author, created_at FROM shared_versions WHERE rel_path=? ORDER BY created_at DESC, rowid DESC LIMIT 100',
        ).all(rel),
      };
    },

    retryPending,
    acquireLock,
    releaseLock,
    expireLocks,

    /** Relier un projet à un sous-dossier du partage : le filtre de projet n'affiche que lui. */
    async linkProject(projectId, dir) {
      if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) {
        throw new SharedError(404, 'SHARED_NO_PROJECT', 'Projet introuvable.');
      }
      relativeParts(dir);
      try {
        const located = await locate(dir);
        const stat = await io.call('stat', [located.abs]);
        if (!stat.isDir) throw new SharedError(400, 'SHARED_NOT_DIR', 'Ce n’est pas un dossier.');
      } catch (error) {
        throw toSharedError(error);
      }
      db.prepare(`INSERT INTO shared_project_folders (project_id, rel_dir, updated_at) VALUES (?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET rel_dir=excluded.rel_dir, updated_at=excluded.updated_at`).run(projectId, dir, nowISO());
      return this.status();
    },

    unlinkProject(projectId) {
      db.prepare('DELETE FROM shared_project_folders WHERE project_id=?').run(projectId);
      return this.status();
    },

    /** Une version de l'historique redevient le brouillon — sans partir sur le partage. */
    restoreVersion(rel, id) {
      relativeParts(rel);
      const version = db.prepare('SELECT * FROM shared_versions WHERE id=? AND rel_path=?').get(id, rel);
      if (!version || !hasBlob(version.hash)) throw new SharedError(404, 'SHARED_NO_VERSION', 'Version introuvable sur cet ordinateur.');
      const row = getRow(rel);
      if (row?.state === 'conflict') throw new SharedError(409, 'SHARED_CONFLICT_OPEN', 'Choisis d’abord comment régler le conflit.');
      save(rel, {
        // Modèle vide : l'éditeur part tel quel des octets de cette version.
        draft_json: 'null',
        draft_updated_at: new Date(clock()).toISOString(),
        template_hash: version.hash,
        base_hash: row?.draft_json ? row.base_hash : row?.seen_hash || row?.base_hash || version.hash,
        state: !row?.state || row.state === 'draft' ? 'draft' : row.state,
      });
      addVersion(rel, version.hash, version.size, 'restored', 'archived');
      return payload(rel);
    },

    /**
     * « Ouvrir avec… » : le **vrai** fichier du partage (c'est la référence). Refusé
     * tant qu'un brouillon n'est pas envoyé — l'application ouvrirait l'ancienne
     * version. Notre verrou est rendu d'abord : l'application posera le sien.
     */
    async openTarget(rel) {
      relativeParts(rel);
      const row = getRow(rel);
      if (row?.draft_json && !row.send_requested) {
        throw new SharedError(409, 'SHARED_DRAFT_OPEN', 'Envoie ou abandonne d’abord ton brouillon : l’autre application ouvrirait la version du partage.');
      }
      let located;
      try {
        located = await locate(rel);
        const stat = await io.call('stat', [located.abs]);
        if (!stat.isFile) throw new SharedError(400, 'SHARED_NOT_FILE', 'Ce n’est pas un fichier.');
      } catch (error) {
        throw toSharedError(error);
      }
      await releaseLock(rel);
      return located.abs;
    },

    async stop() {
      if (timer) clearInterval(timer);
      // On rend la main avant de partir ; un partage figé ne retient pas la fermeture.
      await Promise.race([releaseAll().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      await io.close();
    },
  };
}
