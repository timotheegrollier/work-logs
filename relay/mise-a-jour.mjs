/**
 * Mise à jour automatique du relais du dossier partagé (docs/09-RELAIS.md, §29 et §37).
 *
 * Lancé sur la VM par `worklogs-relais-maj.timer` (toutes les 5 minutes, en root). Suit les
 * **releases publiées** de WorkLogs — celles que la CI a validées — et jamais `master` :
 * 1. dernière release GitHub ; rien à faire si elle n'est pas plus récente que `api/VERSION` ;
 * 2. préparer à côté (`.maj-X.Y.Z/`) : archive du tag, `npm ci`, le module du relais se
 *    charge. Un échec ici ne touche à rien et sera retenté au passage suivant ;
 * 3. basculer : relais arrêté, base sauvegardée, `api` → `api.precedent`, nouveau code en
 *    place, relais relancé. Il doit répondre sur /health **avec la nouvelle version** ;
 * 4. sinon retour arrière (code et base), et cette version est écartée jusqu'à la suivante,
 *    pour ne pas couper le relais toutes les 5 minutes.
 *
 * Ce fichier tourne seul sur la VM (`/opt/worklogs-relais/mise-a-jour.mjs`) : aucune
 * dépendance, et celui de la release le remplace après chaque mise à jour réussie.
 *
 * Usage : `node mise-a-jour.mjs [--simuler]` (`--simuler` : dire ce qui serait fait).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAUTS = {
  depot: 'timotheegrollier/work-logs',
  racine: '/opt/worklogs-relais',
  donnees: '/var/lib/worklogs-relais',
  etat: '/var/lib/worklogs-relais-maj',
  service: 'worklogs-relais',
  sante: 'http://127.0.0.1:8420/health',
  // Secondes laissées au relais relancé pour répondre avec la nouvelle version.
  essais: 30,
};

// Les fichiers de la base du relais (`relais.db` en WAL) ; `shared-blobs/` ne bouge pas.
const BASE = ['relais.db', 'relais.db-wal', 'relais.db-shm'];
const AGENT = { 'User-Agent': 'worklogs-relais-maj' };

const lancer = (commande, args, options = {}) =>
  execFileSync(commande, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });

/** Ce que la VM fait pour de vrai ; les tests en remplacent une partie. */
export const OUTILS = {
  async derniereRelease(depot) {
    const res = await fetch(`https://api.github.com/repos/${depot}/releases/latest`, {
      headers: { ...AGENT, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub répond ${res.status} pour la dernière release de ${depot}.`);
    return (await res.json()).tag_name;
  },
  async telecharger(depot, tag, fichier) {
    const res = await fetch(`https://github.com/${depot}/archive/refs/tags/${tag}.tar.gz`, {
      headers: AGENT,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Archive de ${tag} : GitHub répond ${res.status}.`);
    fs.writeFileSync(fichier, Buffer.from(await res.arrayBuffer()));
  },
  // Pas de scripts d'installation : express, cors et multer n'en ont pas besoin.
  installer(dossier) {
    lancer('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dossier });
  },
  // Le module se charge (dépendances comprises) sans démarrer le relais ; son erreur
  // éventuelle passe dans le message, donc dans le journal.
  charger(dossier) {
    lancer(process.execPath, ['--no-warnings', '--input-type=module', '-e', "await import('./src/relay.js')"], { cwd: dossier, stdio: ['ignore', 'inherit', 'pipe'] });
  },
  systemctl(action, service) {
    lancer('systemctl', [action, service]);
  },
  async sante(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  },
  attendre: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** `v0.52.0` → `0.52.0`, ou null pour tout autre nom de tag. */
export function versionDeTag(tag) {
  return /^v?(\d+\.\d+\.\d+)$/.exec(String(tag ?? ''))?.[1] ?? null;
}

/** Tri semver : `0.6.9` avant `0.6.10`, contrairement au tri texte. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function lireVersion(api) {
  try {
    return versionDeTag(fs.readFileSync(path.join(api, 'VERSION'), 'utf8').trim());
  } catch {
    return null;
  }
}

function lireEtat(dossier) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dossier, 'etat.json'), 'utf8'));
  } catch {
    return {};
  }
}

function ecrireEtat(dossier, etat) {
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(path.join(dossier, 'etat.json'), JSON.stringify(etat, null, 2) + '\n');
}

/** Copie qui garde propriétaire et droits : la base appartient à `worklogs-relais`, pas à root. */
function copier(source, cible) {
  const infos = fs.statSync(source);
  fs.copyFileSync(source, cible);
  fs.chownSync(cible, infos.uid, infos.gid);
  fs.chmodSync(cible, infos.mode & 0o7777);
}

function sauvegarderBase(donnees, sauvegarde) {
  fs.rmSync(sauvegarde, { recursive: true, force: true });
  fs.mkdirSync(sauvegarde, { recursive: true });
  for (const nom of BASE) if (fs.existsSync(path.join(donnees, nom))) copier(path.join(donnees, nom), path.join(sauvegarde, nom));
}

function restaurerBase(sauvegarde, donnees) {
  for (const nom of BASE) {
    fs.rmSync(path.join(donnees, nom), { force: true });
    if (fs.existsSync(path.join(sauvegarde, nom))) copier(path.join(sauvegarde, nom), path.join(donnees, nom));
  }
}

/** Remplace un fichier d'un coup (copie à côté puis renommage) : jamais à moitié écrit. */
function remplacer(source, cible) {
  const provisoire = `${cible}.nouveau`;
  fs.copyFileSync(source, provisoire);
  fs.chmodSync(provisoire, 0o644);
  fs.renameSync(provisoire, cible);
}

function ecrireDeploiement({ racine, donnees, etat, depot }, { version, precedente, le }) {
  const texte = `Relais WorkLogs — ce qui tourne dans ${racine}/api
Code : WorkLogs v${version} (release GitHub ${depot}), installé le ${le}
par la mise à jour automatique (worklogs-relais-maj.timer, docs/09-RELAIS.md).
Version précédente : ${precedente ? `v${precedente}` : 'inconnue'}, dans api.precedent ;
la base d'avant la mise à jour est dans ${etat}/base-avant-maj.

Revenir en arrière (le minuteur d'abord, sinon il réinstalle la release au passage suivant) :
  systemctl disable --now worklogs-relais-maj.timer
  systemctl stop worklogs-relais
  cd ${racine} && mv api api.casse && mv api.precedent api
  rm -f ${donnees}/relais.db ${donnees}/relais.db-wal ${donnees}/relais.db-shm
  cp -a ${etat}/base-avant-maj/. ${donnees}/
  systemctl start worklogs-relais
`;
  fs.writeFileSync(path.join(racine, 'DEPLOIEMENT.txt'), texte);
}

/** Le relais répond-il, et avec cette version ? (`null` : n'importe laquelle, les anciennes ne la disent pas.) */
async function attendreVersion(outils, options, version) {
  for (let essai = 0; essai < options.essais; essai++) {
    const sante = await outils.sante(options.sante);
    if (sante?.ok && (version === null || sante.version === version)) return true;
    await outils.attendre(1_000);
  }
  return false;
}

/**
 * Un passage du minuteur. Rend `{ statut }` : `a-jour`, `ecartee` (a déjà échoué, on attend
 * la suivante), `disponible` (`simuler`) ou `installee` ; lève une erreur sinon.
 */
export async function mettreAJour(reglages = {}) {
  const options = { ...DEFAUTS, ...reglages };
  const outils = { ...OUTILS, ...reglages.outils };
  const dire = reglages.journal ?? ((message) => console.log(message));
  const api = path.join(options.racine, 'api');

  const tag = await outils.derniereRelease(options.depot);
  const version = versionDeTag(tag);
  if (!version) throw new Error(`Dernière release au nom inattendu : « ${tag} ».`);
  const courante = lireVersion(api);
  const etat = lireEtat(options.etat);
  if (courante && compareVersions(version, courante) <= 0) {
    dire(`À jour : v${courante}.`);
    return { statut: 'a-jour', version: courante };
  }
  if (etat.echec?.version === version) {
    dire(`v${version} a échoué au dernier essai (${etat.echec.erreur}) : le relais reste en v${courante}, en attendant la suivante.`);
    return { statut: 'ecartee', version };
  }
  if (reglages.simuler) {
    dire(`v${version} disponible (en service : ${courante ? `v${courante}` : 'version inconnue'}) — rien n'est fait (--simuler).`);
    return { statut: 'disponible', version };
  }
  // Un relais déjà arrêté (partage démonté, VM qui redémarre) ferait accuser la nouvelle version.
  if (!(await outils.sante(options.sante))?.ok) {
    throw new Error(`Le relais ne répond pas sur ${options.sante} : rien n'est changé (systemctl status ${options.service}).`);
  }

  dire(`v${version} disponible (en service : ${courante ? `v${courante}` : 'version inconnue'}) : préparation.`);
  const preparation = path.join(options.racine, `.maj-${version}`);
  fs.rmSync(preparation, { recursive: true, force: true });
  fs.mkdirSync(preparation);
  try {
    const archive = path.join(preparation, 'source.tar.gz');
    const source = path.join(preparation, 'source');
    await outils.telecharger(options.depot, tag, archive);
    fs.mkdirSync(source);
    lancer('tar', ['-xzf', archive, '-C', source, '--strip-components=1', '--no-same-owner']);
    const neuf = path.join(source, 'api');
    for (const fichier of ['src/relay.js', 'package.json', 'package-lock.json']) {
      if (!fs.existsSync(path.join(neuf, fichier))) throw new Error(`Archive de ${tag} incomplète : api/${fichier} manque.`);
    }
    outils.installer(neuf);
    outils.charger(neuf);
    fs.writeFileSync(path.join(neuf, 'VERSION'), `${version}\n`);

    const precedent = path.join(options.racine, 'api.precedent');
    const sauvegarde = path.join(options.etat, 'base-avant-maj');
    outils.systemctl('stop', options.service);
    let bascule = false;
    try {
      sauvegarderBase(options.donnees, sauvegarde);
      fs.rmSync(precedent, { recursive: true, force: true });
      fs.renameSync(api, precedent);
      fs.renameSync(neuf, api);
      bascule = true;
      outils.systemctl('start', options.service);
      if (!(await attendreVersion(outils, options, version))) {
        throw new Error(`v${version} ne répond pas sur ${options.sante} après ${options.essais} s`);
      }
    } catch (erreur) {
      dire(`Échec de v${version} : ${erreur.message} — retour à v${courante ?? '?'}.`);
      try { outils.systemctl('stop', options.service); } catch { /* déjà arrêté */ }
      if (bascule) fs.renameSync(api, path.join(preparation, 'echec'));
      if (!fs.existsSync(api) && fs.existsSync(precedent)) fs.renameSync(precedent, api);
      restaurerBase(sauvegarde, options.donnees);
      outils.systemctl('start', options.service);
      dire(await attendreVersion(outils, options, null)
        ? `v${courante ?? '?'} répond de nouveau.`
        : `L'ancienne version ne répond pas non plus : systemctl status ${options.service}, journalctl -u ${options.service}.`);
      // Écartée seulement si c'est le nouveau code qui n'a pas démarré, pas une copie ratée.
      if (bascule) ecrireEtat(options.etat, { ...etat, echec: { version, erreur: erreur.message, le: new Date().toISOString() } });
      throw erreur;
    }

    // Le script de la release servira au passage suivant.
    const script = path.join(source, 'relay', 'mise-a-jour.mjs');
    if (fs.existsSync(script)) remplacer(script, path.join(options.racine, 'mise-a-jour.mjs'));
    const le = new Date().toISOString();
    ecrireEtat(options.etat, { version, precedente: courante, le });
    ecrireDeploiement(options, { version, precedente: courante, le });
    dire(`Relais mis à jour : v${courante ?? '?'} → v${version}.`);
    return { statut: 'installee', version, precedente: courante };
  } finally {
    fs.rmSync(preparation, { recursive: true, force: true });
  }
}

const lanceDirectement = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (lanceDirectement) {
  mettreAJour({ simuler: process.argv.includes('--simuler') }).catch((erreur) => {
    console.error(erreur.message);
    process.exitCode = 1;
  });
}
