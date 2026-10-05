import path from 'node:path';

/**
 * Verrous du dossier partagé : ce que Word, Excel, LibreOffice et WorkLogs
 * laissent à côté d'un fichier ouvert. Fonctions pures — aucun accès disque ici,
 * `shared-service.js` leur passe les noms et les octets lus.
 *
 * Ces fichiers **informent** : seul un fichier ouvert côté Windows bloque
 * réellement l'écriture (Word et Excel ignorent les verrous des autres). Voir
 * `docs/05-DECISIONS.md` §25.
 */

const WORD = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf', 'odt']);
const EXCEL = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'csv', 'ods']);
const POWERPOINT = new Set(['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'pot', 'potx']);

const extensionOf = (name) => path.extname(name).slice(1).toLowerCase();

/** Application Office qui pose ce type de fichier propriétaire. */
export function officeApp(name) {
  const extension = extensionOf(name);
  if (WORD.has(extension)) return 'word';
  if (EXCEL.has(extension)) return 'excel';
  if (POWERPOINT.has(extension)) return 'powerpoint';
  return 'office';
}

/**
 * Nom du fichier propriétaire Office (`~$…`). Word raccourcit les noms longs :
 * 2 premiers caractères retirés si le nom de base en compte 8 ou plus, 1 s'il en
 * compte 7. Excel et PowerPoint gardent le nom complet. Même règle que LibreOffice
 * (`GenerateMSOLockFileURL`), à confirmer sur la version d'Office du TSE.
 */
export function ownerFileName(name) {
  if (!WORD.has(extensionOf(name))) return '~$' + name;
  const extension = path.extname(name);
  const base = name.slice(0, name.length - extension.length);
  const kept = base.length >= 8 ? base.slice(2) : base.length === 7 ? base.slice(1) : base;
  return '~$' + kept + extension;
}

export const libreOfficeLockName = (name) => `.~lock.${name}#`;

const windows1252 = new TextDecoder('windows-1252');
const utf16 = new TextDecoder('utf-16le');
const clean = (text) => text.replace(/[\x00-\x1f\x7f]/g, '').trim();

/**
 * Nom d'utilisateur Office inscrit dans un fichier propriétaire : 162 octets pour
 * Word, 165 pour Excel. Octet 0 = longueur du nom ANSI qui suit ; à l'octet 54
 * (Word) ou 55 (Excel), longueur sur deux octets puis le nom en UTF-16LE. On
 * préfère l'UTF-16 (accents exacts), repli sur l'ANSI, sinon `null`.
 */
export function parseOwnerFile(bytes) {
  if (!bytes || bytes.length < 2) return null;
  for (const offset of [54, 55]) {
    const length = bytes[offset];
    if (bytes.length < offset + 2 || bytes[offset + 1] !== 0 || length < 1 || length > 52) continue;
    const end = offset + 2 + length * 2;
    if (end > bytes.length) continue;
    const name = clean(utf16.decode(bytes.subarray(offset + 2, end)));
    if (name) return name;
  }
  const length = bytes[0];
  if (length >= 1 && length <= 53 && length < bytes.length) {
    const name = clean(windows1252.decode(bytes.subarray(1, 1 + length)));
    if (name) return name;
  }
  return null;
}

/** Champs d'un verrou LibreOffice : `\`, `,` et `;` y sont échappés par `\`. */
function splitLockFields(line) {
  const fields = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) {
      current += line[++i];
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else if (char === ';') {
      break;
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

const escapeField = (value) => String(value ?? '').replace(/[\\,;\r\n]/g, (char) => (char === '\r' || char === '\n' ? ' ' : '\\' + char));

/**
 * Verrou LibreOffice : une ligne `Nom,utilisateur,hôte,jj.mm.aaaa hh:mm,URL;`.
 * Le premier champ est vide quand LibreOffice n'a pas de nom d'utilisateur.
 */
export function parseLibreOfficeLock(bytes) {
  if (!bytes || !bytes.length) return null;
  const text = new TextDecoder('utf-8').decode(bytes).split(/\r?\n/)[0];
  const [name = '', user = '', host = '', date = '', url = ''] = splitLockFields(text);
  if (!name && !user && !host) return null;
  return { name: clean(name), user: clean(user), host: clean(host), date: clean(date), url: clean(url) };
}

const pad = (n) => String(n).padStart(2, '0');
/** Date au format des verrous LibreOffice, à l'heure locale de celui qui l'écrit. */
export const lockDate = (date) =>
  `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

/**
 * Verrou posé par WorkLogs, au format LibreOffice : LibreOffice et les autres
 * WorkLogs l'affichent (« Document en cours d'utilisation »). L'URL `worklogs:`
 * permet de reconnaître les nôtres, l'instance ceux de cet ordinateur.
 */
export function formatWorkLogsLock({ displayName, user, host, instance, nonce, date }) {
  return [`${displayName} (WorkLogs)`, user, host, lockDate(date), `worklogs:${instance}:${nonce}`]
    .map(escapeField).join(',') + ';';
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Décrit les verrous trouvés pour un fichier. `owner` = fichier `~$` (octets et
 * date), `libre` = `.~lock#`. Renvoie le plus parlant, ou `null`.
 * `self` = posé depuis cet ordinateur ; `stale` = probablement abandonné.
 */
export function describeLock({ name, owner = null, libre = null, instance = '', user = '', host = '', now = Date.now() }) {
  if (libre) {
    const parsed = parseLibreOfficeLock(libre.bytes);
    if (parsed) {
      const since = libre.mtimeMs ? new Date(libre.mtimeMs).toISOString() : null;
      const old = libre.mtimeMs ? now - libre.mtimeMs > DAY : false;
      if (parsed.url.startsWith('worklogs:')) {
        const [, lockInstance = '', nonce = ''] = parsed.url.split(':');
        return {
          app: 'worklogs',
          by: parsed.name.replace(/ \(WorkLogs\)$/, '') || parsed.user || 'quelqu’un',
          since,
          self: Boolean(instance) && lockInstance === instance,
          nonce,
          stale: old,
        };
      }
      return {
        app: 'libreoffice',
        by: parsed.name || parsed.user || 'quelqu’un',
        since,
        self: Boolean(user) && parsed.user === user && parsed.host === host,
        stale: old,
      };
    }
  }
  if (owner) {
    return {
      app: officeApp(name),
      by: parseOwnerFile(owner.bytes) || 'quelqu’un',
      since: owner.mtimeMs ? new Date(owner.mtimeMs).toISOString() : null,
      self: false,
      stale: false,
    };
  }
  return null;
}

const APP_LABELS = { word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint', office: 'Office', libreoffice: 'LibreOffice', worklogs: 'WorkLogs' };
export const lockAppLabel = (app) => APP_LABELS[app] || 'une autre application';

/** Fichiers techniques jamais montrés : verrous, temporaires Office et LibreOffice, vignettes. */
export function isTechnicalName(name) {
  if (name.startsWith('.') || name.startsWith('~$')) return true;
  if (/^~.*\.tmp$/i.test(name) || /^lu.*\.tmp$/i.test(name)) return true;
  if (/^[0-9a-f]{8}(\.tmp)?$/i.test(name)) return true;
  return ['thumbs.db', 'desktop.ini', '$recycle.bin', 'system volume information'].includes(name.toLowerCase());
}
