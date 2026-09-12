/**
 * Stratégie de mise à jour par format installé (voir docs/07-RELEASES.md §7) :
 * - AppImage : electron-updater (différentiel via blockmap) — voir main.mjs.
 * - Paquet système (deb/rpm) : PackageKit (`pkcon`) si présent — polkit demande
 *   le mot de passe, un clic suffit ; sinon consigne dnf/apt + page de release.
 * - Dev (sources) : simple signalement.
 * Ce module reste sans dépendance : détection, planification et décision.
 */
import fs from 'node:fs';

export const UPDATE_REPO = 'timotheegrollier/work-logs';
export const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;
export const RPM_REPO_URL = 'https://timotheegrollier.github.io/work-logs/rpm';
/** Nom du paquet système (deb et rpm — vérifié : `rpm -q worklogs`, `--name worklogs` côté fpm). */
export const SYSTEM_PACKAGE = 'worklogs';
/** Revérification périodique en tâche de fond (l'ouverture vérifie déjà). */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * D'où vient l'exécutable : 'appimage' (variable APPIMAGE posée par le
 * runtime), 'system' (paquet deb/rpm sous /opt) ou 'dev' (sources, unpacked).
 * Paramètres injectables pour les tests.
 */
export function installKind({ appimage = process.env.APPIMAGE, execPath = process.execPath } = {}) {
  if (appimage) return 'appimage';
  if (execPath.startsWith('/opt/')) return 'system';
  return 'dev';
}

/** « v1.2.3 » → [1, 2, 3], ou null si le tag n'est pas une version stable. */
export function parseVersion(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag).trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** true si latest est strictement plus récente que current. */
export function isNewer(latest, current) {
  const next = parseVersion(latest);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] !== now[i]) return next[i] > now[i];
  }
  return false;
}

/**
 * Interroge la dernière release GitHub publiée. Résout vers
 * `{ version, url }` si elle est plus récente que `currentVersion`,
 * vers null sinon (à jour, hors ligne, ou réponse inattendue : on ne
 * bloque jamais le démarrage pour ça). `fetchImpl` n'existe que pour
 * les tests.
 */
export async function checkForUpdate({ currentVersion, fetchImpl = fetch, timeoutMs = 10_000, onError = () => {} } = {}) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'worklogs-desktop' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    onError(`réseau: ${String(error?.message || error).slice(0, 200)}`);
    return null;
  }
  if (!response.ok) {
    onError(`HTTP ${response.status}`);
    return null;
  }
  let release;
  try {
    release = await response.json();
  } catch (error) {
    onError(`JSON: ${String(error?.message || error).slice(0, 200)}`);
    return null;
  }
  if (!release || typeof release.tag_name !== 'string' || !isNewer(release.tag_name, currentVersion)) return null;
  return {
    version: release.tag_name.replace(/^v/, ''),
    url: `${RELEASES_URL}/tag/${release.tag_name}`,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
  };
}

/** Âge en minutes d'une release, ou null si inconnu/futur. */
export function releaseAgeMinutes(publishedAt, nowMs = Date.now()) {
  if (!publishedAt) return null;
  const age = Math.floor((nowMs - Date.parse(publishedAt)) / 60000);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

/** PackageKit présent = mise à jour système en un clic (polkit gère le mot de passe). */
export function hasPackageKit({ existsSync = fs.existsSync } = {}) {
  return existsSync('/usr/bin/pkcon');
}

/**
 * Transaction de mise à jour (`update`, pas `install` : le paquet est déjà
 * installé puisqu'on tourne depuis — prouvé en conteneur, `install` créait
 * des conflits de fichiers).
 */
export function pkconInstallArgs() {
  return ['--noninteractive', '--cache-age', '1', 'update', SYSTEM_PACKAGE];
}

/**
 * Interroge les mises à jour via PackageKit (même vue que l'installateur).
 */
export function pkconUpdatesArgs() {
  return ['--noninteractive', '--plain', 'get-updates'];
}

/**
 * Lit la progression d'une transaction pkcon depuis sa sortie cumulée
 * (lignes `Status: …` et `Percentage: NN`, observées en conteneur Fedora).
 * Résout vers `{ phase, percent }` ou null si rien d'exploitable.
 * `phase` vaut 'download' pendant le téléchargement, 'install' sinon.
 */
export function parsePkconProgress(output) {
  let status = null;
  let percent = null;
  for (const line of String(output).split('\n')) {
    const statusMatch = /^\s*Status:\s*(.+?)\s*$/.exec(line);
    if (statusMatch) status = statusMatch[1];
    const percentMatch = /^\s*Percentage:\s*(\d+)\s*$/.exec(line);
    if (percentMatch) percent = Math.min(100, Math.max(0, Number(percentMatch[1])));
  }
  if (status === null && percent === null) return null;
  return { phase: /download/i.test(status ?? '') ? 'download' : 'install', percent };
}

/** Recharge les métadonnées (prouvé en conteneur : `get-updates`, même avec
 * `--cache-age 1`, relit sinon un cache périmé — seul `refresh force` recharge). */
export function pkconRefreshArgs() {
  return ['--noninteractive', 'refresh', 'force'];
}

/**
 * Extrait la version candidate de `worklogs` de la sortie `pkcon -p get-updates`
 * (format texte `Available\\tworklogs-0.6.8-1.x86_64 (wl)`), ou null si aucune
 * mise à jour n'est proposée.
 */
export function parsePkconCandidate(output) {
  const match = /worklogs-(\d[\w.]*)-\d+\.\w+ \(/.exec(String(output));
  return match ? match[1] : null;
}

/** La version installée correspond-elle à celle attendue ? (`rpm -q` ne sort qu'une ligne). */
export function installedMatches(rpmOutput, expected) {
  return String(rpmOutput).trim().split('\n')[0]?.trim() === expected;
}

/**
 * Revérifie `tick` toutes les `intervalMs` sans chevauchement (un tick lent
 * ne déclenche jamais deux vérifications en parallèle). Résout vers une
 * fonction d'arrêt. `timer` n'existe que pour les tests.
 */
export function startPoll({ intervalMs = POLL_INTERVAL_MS, tick, timer = { setInterval, clearInterval } } = {}) {
  let busy = false;
  const id = timer.setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => timer.clearInterval(id);
}

/** Faut-il proposer `found` à un utilisateur en `current` ayant refusé `dismissed` ? */
export function shouldOfferUpdate(found, current, dismissed) {
  return Boolean(found) && found !== dismissed && isNewer(found, current);
}

/**
 * Journal des vérifications (`update.log` dans le dossier de données) : sans ça,
 * un échec silencieux est indiagnosticable. Rotation simple à ~50 Ko.
 */
export function logUpdateEvent(dataDir, message) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = `${dataDir}/update.log`;
    let existing = '';
    try {
      const stat = fs.statSync(file);
      if (stat.size > 50 * 1024) {
        const tail = fs.readFileSync(file, 'utf8').slice(-4000);
        existing = tail.slice(tail.indexOf('\n') + 1);
      } else {
        existing = fs.readFileSync(file, 'utf8');
      }
    } catch { /* premier lancement : le fichier n'existe pas */ }
    fs.writeFileSync(file, `${existing}[${new Date().toISOString()}] ${message}\n`);
  } catch { /* le log ne doit jamais casser l'application */ }
}
