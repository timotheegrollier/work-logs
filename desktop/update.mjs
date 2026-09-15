/**
 * Stratégie de mise à jour par format installé (voir docs/07-RELEASES.md §7) :
 * - AppImage : electron-updater (différentiel via blockmap) — voir main.mjs.
 * - Paquet système (deb/rpm) : PackageKit (`pkcon`) lit les mises à jour sans
 *   autorisation, `pkexec` installe avec (polkit demande le mot de passe, un clic
 *   suffit) ; sinon consigne dnf/apt + page de release.
 * - Dev (sources) : simple signalement.
 * Ce module reste sans dépendance : détection, planification et décision.
 */
import fs from 'node:fs';

export const UPDATE_REPO = 'timotheegrollier/work-logs';
export const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;
export const RPM_REPO_URL = 'https://timotheegrollier.github.io/work-logs/rpm';
export const DEB_REPO_URL = 'https://timotheegrollier.github.io/work-logs/deb';
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
 * Commande d'installation privilégiée : `pkexec` + le gestionnaire natif.
 *
 * **Pourquoi plus `pkcon update` ?** Ses deux formes échouent sur une vraie
 * session — reproduit sur Linux Mint 22 (Cinnamon, agent polkit bien enregistré) :
 *
 *   printf 'y\n' | pkcon --cache-age 1 update worklogs
 *     → Erreur fatale: user declined simulation            (code 7, en 0,5 s)
 *   pkcon --noninteractive --cache-age 1 update worklogs
 *     → État: Attente de l'authentification
 *       Erreur fatale: Failed to obtain authentication      (code 7)
 *
 * Sans `--noninteractive`, pkcon exige un **vrai terminal** pour sa confirmation :
 * alimenter son entrée standard ne suffit pas, il refuse sa propre simulation
 * avant même de demander quoi que ce soit à polkit. Avec, il marque la
 * transaction non interactive et polkit refuse sans jamais afficher de dialogue.
 * Il n'existe pas de troisième forme : ce chemin est sans issue depuis une
 * application graphique.
 *
 * `pkexec` est fait exactement pour ça : il demande l'autorisation à l'agent
 * polkit de la session, puis exécute la commande en root. Vérifié sur la machine
 * de production (Mint 22) : 0.8.0 → 0.9.0, code 0.
 *
 * `Dpkg::Use-Pty=0` évite que dpkg réclame un pseudo-terminal : sans lui, la
 * sortie est noyée sous les retours chariot de la barre de progression.
 */
export function privilegedInstallCommand(manager) {
  return {
    file: 'pkexec',
    args: manager === 'apt'
      ? ['/usr/bin/apt-get', '-o', 'Dpkg::Use-Pty=0', 'install', '-y', '--only-upgrade', SYSTEM_PACKAGE]
      : ['/usr/bin/dnf', 'upgrade', '-y', SYSTEM_PACKAGE],
  };
}

/** `pkexec` présent = l'application peut demander l'autorisation administrateur. */
export function hasPkexec({ existsSync = fs.existsSync } = {}) {
  return existsSync('/usr/bin/pkexec');
}

/**
 * Cet échec d'installation est-il un refus d'autorisation ?
 *
 * `pkexec` sort en **126** quand l'utilisateur a fermé le dialogue. Son **127**
 * est ambigu (`man pkexec`) : « not authorized », « authentification impossible »
 * *et* « erreur d'exécution » y tombent ensemble. Seul le message tranche, d'où
 * la lecture de la sortie en plus du code.
 *
 * Le piège à ne pas réintroduire : « user declined simulation » (pkcon) n'est
 * **pas** un refus d'autorisation, c'est pkcon qui renonce faute de terminal.
 * L'ancienne expression attrapait « declined » et annonçait « autorisation non
 * accordée » à quelqu'un à qui aucune fenêtre n'avait rien demandé.
 */
export function isAuthorizationFailure({ code, output = '' }) {
  if (code === 126) return true;
  return /not authorized|non autoris|authentication failed|échec de l['\u2019]authentification|obtain authentication|request dismissed/i
    .test(String(output));
}

/**
 * Interroge les mises à jour via PackageKit (même vue que l'installateur).
 */
export function pkconUpdatesArgs() {
  return ['--noninteractive', '--plain', 'get-updates'];
}

/**
 * Lit la phase d'une installation apt/dnf depuis sa sortie cumulée.
 * Résout vers `{ phase, percent }` ou null si rien d'exploitable.
 *
 * Aucun des deux n'annonce de pourcentage exploitable hors terminal : `percent`
 * reste null et le bandeau affiche une barre indéterminée, ce qu'il sait faire.
 * Les marqueurs sont bilingues parce que la commande hérite de la locale
 * système via polkit (relevé : sortie en français sur la machine de production).
 */
export function parseManagerProgress(output) {
  const DOWNLOAD = /^(?:Get:|Réception de |Downloading|Téléchargement)/i;
  const INSTALL = /^(?:Preparing to unpack|Préparation du dépaquetage|Unpacking|Dépaquetage|Setting up|Paramétrage|Running transaction|Upgrading|Mise à niveau|Installing|Installation)/i;
  let phase = null;
  for (const line of String(output).split('\n')) {
    const text = line.trim();
    if (DOWNLOAD.test(text)) phase = 'download';
    else if (INSTALL.test(text)) phase = 'install';
  }
  return phase === null ? null : { phase, percent: null };
}

/** Recharge les métadonnées (prouvé en conteneur : `get-updates`, même avec
 * `--cache-age 1`, relit sinon un cache périmé — seul `refresh force` recharge). */
export function pkconRefreshArgs() {
  return ['--noninteractive', 'refresh', 'force'];
}

/**
 * Extrait la version candidate de `worklogs` de la sortie `pkcon -p get-updates`,
 * ou null si aucune mise à jour n'est proposée.
 *
 * Les deux dorsales ne écrivent pas pareil — relevé en conteneur :
 *   dnf  : `Available   worklogs-0.6.8-1.x86_64 (wl)`        (révision `-1` puis arch)
 *   apt  : `Normal      worklogs-0.6.13.amd64 (worklogs-stable-)`  (pas de révision)
 * L'ancienne expression exigeait la révision : elle ne pouvait rien trouver sur
 * Debian/Mint, même dépôt apt configuré.
 */
export function parsePkconCandidate(output) {
  const match = new RegExp(`\\b${SYSTEM_PACKAGE}-(\\d+\\.\\d+\\.\\d+)(?:-\\d+)?\\.[a-z0-9_]+\\s*\\(`, 'i')
    .exec(String(output));
  return match ? match[1] : null;
}

/**
 * Que faire après le pré-vol PackageKit. Isolé ici parce que c'est exactement
 * là que Mint cassait : `pkcon get-updates` sort en **5** quand il n'y a rien à
 * installer (« nothing useful was done »), et le code traitait tout code non nul
 * comme « interrogation impossible » — puis tentait quand même l'installation,
 * qui échouait forcément.
 *
 * - 'ready'    : le gestionnaire propose bien la version attendue, on peut installer.
 * - 'none'     : rien de proposé (aucun dépôt configuré, ou déjà à jour) — repli manuel.
 * - 'mismatch' : il propose autre chose, métadonnées périmées — on s'arrête.
 */
export function pkconProbeOutcome({ code, output, expected }) {
  const candidate = parsePkconCandidate(output);
  if (candidate === expected) return { decision: 'ready', candidate };
  if (candidate) return { decision: 'mismatch', candidate };
  // Rien trouvé : pas de dépôt configuré, ou déjà à jour, ou pkcon a refusé de
  // répondre. Les trois mènent au même repli, jamais à une installation.
  return { decision: 'none', candidate: null, probeFailed: code !== 0 };
}

/**
 * Gestionnaire de paquets du système, pour parler la bonne langue dans les
 * messages et proposer la bonne commande. `existsSync` injectable pour les tests.
 */
export function packageManager({ existsSync = fs.existsSync } = {}) {
  if (existsSync('/usr/bin/dnf')) return 'dnf';
  if (existsSync('/usr/bin/apt-get')) return 'apt';
  return null;
}

/** Commande qui lit la version installée du paquet système, selon la dorsale. */
export function installedVersionCommand(manager) {
  return manager === 'apt'
    ? { file: 'dpkg-query', args: ['-W', '-f', '${Version}', SYSTEM_PACKAGE] }
    : { file: 'rpm', args: ['-q', '--qf', '%{VERSION}', SYSTEM_PACKAGE] };
}

/** URL du dépôt à proposer, et commande d'activation, selon la dorsale. */
export function repoHint(manager) {
  if (manager === 'apt') {
    return {
      url: DEB_REPO_URL,
      update: 'sudo apt update && sudo apt install --only-upgrade worklogs',
      enable: `sudo curl -fsSL -o /etc/apt/sources.list.d/worklogs.list ${DEB_REPO_URL}/worklogs.list`,
    };
  }
  return {
    url: RPM_REPO_URL,
    update: 'sudo dnf update worklogs',
    enable: `sudo curl -fsSL -o /etc/yum.repos.d/worklogs.repo ${RPM_REPO_URL}/worklogs.repo`,
  };
}

/**
 * La version installée correspond-elle à celle attendue ?
 * `rpm -q --qf %{VERSION}` sort `0.6.13` ; `dpkg-query -W -f ${Version}` peut
 * sortir `0.6.13` ou `0.6.13-1` selon l'empaqueteur — on compare donc la partie
 * amont, sans la révision Debian.
 */
export function installedMatches(output, expected) {
  const found = String(output).trim().split('\n')[0]?.trim() ?? '';
  return found === expected || found.replace(/-\d+$/, '') === expected;
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
