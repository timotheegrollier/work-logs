import { Worker } from 'node:worker_threads';

/**
 * Entrées/sorties bornées sur le dossier partagé.
 *
 * Un montage SMB figé (VPN coupé, serveur éteint) peut bloquer un appel `fs`
 * pendant des minutes. Exécutés dans le pool de libuv ou dans le processus
 * principal d'Electron, ces appels gèleraient WorkLogs entier. Ils passent donc
 * par **un worker** qui fait des appels synchrones, un à la fois, sous délai :
 *
 * - délai dépassé ou erreur réseau → disjoncteur ouvert (`offline`), tout ce qui
 *   attend échoue aussitôt ; seule une sonde (`probe`) peut le refermer ;
 * - un worker resté bloqué est abandonné et remplacé — deux au plus, au-delà
 *   l'état passe à `blocked` jusqu'à ce que l'un d'eux rende la main.
 *
 * Le code du worker est inclus ici (`eval`) : aucun chemin de fichier à résoudre
 * dans l'archive de l'application empaquetée.
 */

const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const crypto = require('node:crypto');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const describe = (stat) => ({
  size: stat.size, mtimeMs: Math.round(stat.mtimeMs),
  isDir: stat.isDirectory(), isFile: stat.isFile(), isSymlink: stat.isSymbolicLink(),
});
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Lecture **séquentielle** (position courante, jamais d'offset explicite) : un
 * partage monté par GVFS (Nemo, « /run/user/…/gvfs ») refuse les lectures
 * positionnées (ESPIPE). Le descripteur est toujours frais, donc lu depuis 0.
 */
function readAll(fd, max = Infinity) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(65536);
    const read = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (!read) break;
    total += read;
    if (total > max) throw fail('EFBIG', 'fichier trop volumineux');
    chunks.push(chunk.subarray(0, read));
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

function readPath(file, max) {
  const fd = fs.openSync(file, 'r');
  try {
    return readAll(fd, max);
  } finally {
    fs.closeSync(fd);
  }
}

/** Écriture positionnée (même descripteur que la relecture). */
function writeAt(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
}

/** Écriture séquentielle, sur un descripteur fraîchement ouvert (donc en 0). */
function writeSequential(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}

const syncQuietly = (fd) => { try { fs.fsyncSync(fd); } catch {} };
/** Ce que GVFS (FUSE) répond aux opérations qu'il ne sait pas faire. */
const UNSUPPORTED = new Set(['ESPIPE', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EINVAL']);

function readSmall(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    const bytes = readAll(fd, Infinity).subarray(0, max);
    return { bytes, mtimeMs: Math.round(stat.mtimeMs) };
  } finally {
    fs.closeSync(fd);
  }
}

const startsWith = (whole, part) => part.length <= whole.length && Buffer.compare(whole.subarray(0, part.length), part) === 0;

/** Réécrit le fichier depuis zéro par un second descripteur (O_TRUNC), séquentiellement. */
function rewrite(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC);
  } catch (error) {
    if (error.code === 'EBUSY' || error.code === 'ETXTBSY') return { result: 'busy', code: error.code };
    if (error.code === 'EACCES' || error.code === 'EPERM') return { result: 'denied', code: error.code };
    throw error;
  }
  try {
    writeSequential(fd, bytes);
    syncQuietly(fd);
  } catch (error) {
    return { result: 'interrupted', code: error.code || 'EIO' };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  return null;
}

/**
 * Écriture gardée, **sur place** : on garde les droits NTFS, le propriétaire et
 * l'identité du fichier (un renommage par-dessus hériterait des droits du
 * dossier). Le même descripteur sert à relire avant d'écrire : si le contenu
 * n'est plus celui sur lequel on s'appuie, on n'écrit pas. Un montage qui refuse
 * la troncature ou l'écriture positionnée (GVFS) passe par une réécriture
 * séquentielle, toujours après la même vérification.
 */
function writeGuarded(file, input, base, mine, interrupted) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDWR);
  } catch (error) {
    if (error.code === 'EBUSY' || error.code === 'ETXTBSY') return { result: 'busy', code: error.code };
    if (error.code === 'EACCES' || error.code === 'EPERM') return { result: 'denied', code: error.code };
    if (error.code === 'ENOENT') return { result: 'missing' };
    if (UNSUPPORTED.has(error.code)) return writeWithoutReadWrite(file, bytes, base, mine, interrupted);
    throw error;
  }
  let truncated = false;
  let fallback = false;
  try {
    const stat = fs.fstatSync(fd);
    const current = readAll(fd);
    const hash = sha256(current);
    if (hash === mine) return { result: 'same', size: current.length, mtimeMs: Math.round(stat.mtimeMs) };
    if (hash !== base && !(interrupted && startsWith(bytes, current))) {
      return { result: 'changed', theirs: current, hash, size: current.length, mtimeMs: Math.round(stat.mtimeMs) };
    }
    try {
      fs.ftruncateSync(fd, 0);
      truncated = true;
      writeAt(fd, bytes);
      syncQuietly(fd);
    } catch (error) {
      if (!UNSUPPORTED.has(error.code)) throw error;
      fallback = true;
    }
  } catch (error) {
    if (truncated) return { result: 'interrupted', code: error.code || 'EIO' };
    throw error;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  if (fallback) {
    const failed = rewrite(file, bytes);
    if (failed) return failed;
  }
  return verify(file, mine);
}

/** Repli des montages qui refusent la lecture-écriture (certains GVFS). */
function writeWithoutReadWrite(file, bytes, base, mine, interrupted) {
  const current = readPath(file);
  const hash = sha256(current);
  const stat = fs.statSync(file);
  if (hash === mine) return { result: 'same', size: current.length, mtimeMs: Math.round(stat.mtimeMs) };
  if (hash !== base && !(interrupted && startsWith(bytes, current))) {
    return { result: 'changed', theirs: current, hash, size: current.length, mtimeMs: Math.round(stat.mtimeMs) };
  }
  return rewrite(file, bytes) ?? verify(file, mine);
}

/** Relecture : un collègue qui enregistre juste après nous se voit ici. */
function verify(file, mine) {
  const after = readPath(file);
  const stat = fs.statSync(file);
  const hash = sha256(after);
  if (hash !== mine) return { result: 'changed', theirs: after, hash, size: after.length, mtimeMs: Math.round(stat.mtimeMs) };
  return { result: 'written', size: after.length, mtimeMs: Math.round(stat.mtimeMs) };
}

const ops = {
  statfs: (file) => ({ type: Number(fs.statfsSync(file).type) }),
  stat: (file) => describe(fs.statSync(file)),
  realpath: (file) => fs.realpathSync(file),
  readdir(dir, max) {
    const names = fs.readdirSync(dir);
    const entries = [];
    for (const name of names.slice(0, max)) {
      try {
        entries.push({ name, ...describe(fs.lstatSync(dir + '/' + name)) });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return { entries, total: names.length };
  },
  readFile(file, max) {
    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size > max) throw fail('EFBIG', 'fichier trop volumineux');
      const bytes = readAll(fd, max);
      return { bytes, size: bytes.length, mtimeMs: Math.round(stat.mtimeMs), hash: sha256(bytes) };
    } finally {
      fs.closeSync(fd);
    }
  },
  readMany: (files, max) => files.map((file) => readSmall(file, max)),
  writeGuarded,
  createExclusive(file, input) {
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') return { created: false };
      throw error;
    }
    try {
      writeSequential(fd, bytes);
      syncQuietly(fd);
    } finally {
      fs.closeSync(fd);
    }
    const stat = fs.statSync(file);
    return { created: true, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  },
  /**
   * Renouvelle notre verrou : réécrit le fichier (sa date bouge) **seulement** s'il
   * porte encore notre marque. Disparu → recréé ; remplacé par un autre → « perdu ».
   */
  renewLock(file, input, marker) {
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const current = readSmall(file, 4096);
    if (!current) {
      try {
        const fd = fs.openSync(file, 'wx');
        try { writeSequential(fd, bytes); } finally { fs.closeSync(fd); }
        return { result: 'renewed' };
      } catch (error) {
        if (error.code === 'EEXIST') return { result: 'lost', bytes: readSmall(file, 4096)?.bytes ?? null };
        throw error;
      }
    }
    if (!Buffer.from(current.bytes).toString('utf8').includes(marker)) return { result: 'lost', bytes: current.bytes };
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC);
    try { writeSequential(fd, bytes); } finally { fs.closeSync(fd); }
    return { result: 'renewed' };
  },
  /** Retire un verrou seulement s'il porte encore notre marque (jamais celui d'un autre). */
  unlinkIfMarked(file, marker) {
    const current = readSmall(file, 4096);
    if (!current || !Buffer.from(current.bytes).toString('utf8').includes(marker)) return false;
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  },
  unlink(file) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  },
  // Pour les tests : un appel qui bloque comme un montage SMB figé.
  sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return true;
  },
};

parentPort.on('message', ({ id, op, args }) => {
  try {
    if (!Object.hasOwn(ops, op)) throw fail('EINVAL', 'opération inconnue');
    parentPort.postMessage({ id, result: ops[op](...args) });
  } catch (error) {
    parentPort.postMessage({ id, error: { code: error.code || 'EIO', message: error.message } });
  }
});
`;

/** Erreurs qui disent « le partage ne répond plus », pas « ce fichier pose problème ». */
const NETWORK_CODES = new Set(['ENOTCONN', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ETIMEDOUT',
  'ESTALE', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOMEDIUM', 'ESHUTDOWN']);

export class SharedIoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const offlineError = () => new SharedIoError('SHARED_OFFLINE', 'Le dossier partagé ne répond pas.');
const blockedError = () => new SharedIoError('SHARED_BLOCKED', 'Le dossier partagé ne répond plus : WorkLogs attend qu’il se libère.');

export function createSharedIo({ timeoutMs = 4000, maxStuck = 2 } = {}) {
  let worker = null;
  let nextId = 1;
  let inFlight = null;
  const queue = [];
  const stuck = new Set();
  let breaker = 'closed';
  let since = null;

  const spawn = () => {
    // `execArgv: []` : le worker n'hérite pas d'options comme `--input-type=module`,
    // qui feraient lire son code CommonJS comme un module ES.
    const current = new Worker(WORKER_SOURCE, { eval: true, execArgv: [] });
    current.on('message', (message) => {
      if (current !== worker) {
        // Un worker abandonné qui rend enfin la main : on le libère.
        stuck.delete(current);
        void current.terminate();
        return;
      }
      if (!inFlight || inFlight.id !== message.id) return;
      const call = inFlight;
      inFlight = null;
      clearTimeout(call.timer);
      if (message.error) {
        if (NETWORK_CODES.has(message.error.code)) open();
        call.reject(new SharedIoError(message.error.code, message.error.message));
      } else {
        call.resolve(message.result);
      }
      pump();
    });
    current.on('error', (error) => {
      if (current !== worker) return;
      worker = null;
      if (inFlight) {
        clearTimeout(inFlight.timer);
        inFlight.reject(new SharedIoError('EIO', error.message));
        inFlight = null;
      }
      pump();
    });
    // Après les écouteurs : ajouter un écouteur `message` ré-arme le port, et un
    // worker inactif retiendrait alors le processus (fermeture du desktop, tests).
    current.unref();
    return current;
  };

  const open = () => {
    if (breaker === 'closed') since = new Date().toISOString();
    breaker = stuck.size >= maxStuck ? 'blocked' : 'open';
  };

  /** Le worker courant ne répond plus : on l'abandonne, tout ce qui attend échoue. */
  const abandon = () => {
    if (worker) {
      stuck.add(worker);
      worker = null;
    }
    open();
    const pending = queue.splice(0);
    for (const call of pending) call.reject(breaker === 'blocked' ? blockedError() : offlineError());
  };

  function pump() {
    if (inFlight || !queue.length) return;
    const call = queue.shift();
    if (breaker !== 'closed' && !call.probe) {
      call.reject(breaker === 'blocked' ? blockedError() : offlineError());
      pump();
      return;
    }
    if (!worker) {
      if (stuck.size >= maxStuck) {
        breaker = 'blocked';
        call.reject(blockedError());
        pump();
        return;
      }
      worker = spawn();
    }
    inFlight = call;
    call.timer = setTimeout(() => {
      if (inFlight !== call) return;
      inFlight = null;
      call.reject(offlineError());
      abandon();
      pump();
    }, call.timeoutMs);
    worker.postMessage({ id: call.id, op: call.op, args: call.args });
  }

  return {
    /**
     * Appel borné. `probe` passe même disjoncteur ouvert : c'est la sonde qui
     * vérifie que le partage est revenu. Une sonde réussie referme le disjoncteur.
     */
    call(op, args = [], { timeoutMs: limit = timeoutMs, probe = false } = {}) {
      return new Promise((resolve, reject) => {
        queue.push({
          id: nextId++, op, args, probe, timeoutMs: limit,
          resolve: (value) => {
            if (probe && breaker !== 'closed') {
              breaker = 'closed';
              since = null;
            }
            resolve(value);
          },
          reject,
        });
        pump();
      });
    },
    state: () => ({ breaker: breaker === 'closed' ? 'closed' : stuck.size >= maxStuck ? 'blocked' : breaker, since, stuck: stuck.size }),
    async close() {
      const workers = [worker, ...stuck].filter(Boolean);
      worker = null;
      stuck.clear();
      for (const call of queue.splice(0)) call.reject(offlineError());
      if (inFlight) {
        clearTimeout(inFlight.timer);
        inFlight.reject(offlineError());
        inFlight = null;
      }
      // Un worker bloqué dans un appel système ne s'arrête qu'à la fin de cet appel :
      // on ne l'attend pas plus d'une seconde, la fermeture de WorkLogs ne doit pas geler.
      await Promise.race([
        Promise.all(workers.map((current) => current.terminate().catch(() => {}))),
        new Promise((resolve) => setTimeout(resolve, 1000).unref()),
      ]);
    },
  };
}

/** Délai d'une lecture ou écriture : 4 s, plus une seconde par Mo, 60 s au plus. */
export const transferTimeout = (bytes) => Math.min(60_000, 4000 + Math.ceil(bytes / (1024 * 1024)) * 1000);
