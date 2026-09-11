/**
 * Vérification des mises à jour au démarrage, sans dépendance externe.
 *
 * Pourquoi pas electron-updater : ce serait une nouvelle dépendance (accord
 * requis par les règles du projet) pour un gain nul sur deb/rpm, qu'une
 * application ne peut pas auto-installer sans les droits root — la mise à
 * jour passe de toute façon par apt/dnf ou par le téléchargement manuel.
 * Ce module se contente donc de signaler la nouveauté et d'ouvrir la page
 * de release en un clic, quel que soit le format installé.
 */

export const UPDATE_REPO = 'timotheegrollier/work-logs';
export const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;
export const RPM_REPO_URL = 'https://timotheegrollier.github.io/work-logs/rpm';

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
export async function checkForUpdate({ currentVersion, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'worklogs-desktop' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let release;
  try {
    release = await response.json();
  } catch {
    return null;
  }
  if (!release || typeof release.tag_name !== 'string' || !isNewer(release.tag_name, currentVersion)) return null;
  return { version: release.tag_name.replace(/^v/, ''), url: `${RELEASES_URL}/tag/${release.tag_name}` };
}
