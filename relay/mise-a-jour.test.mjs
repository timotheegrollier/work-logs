import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTILS, compareVersions, mettreAJour, versionDeTag } from './mise-a-jour.mjs';

const ici = path.dirname(fileURLToPath(import.meta.url));
const lire = (...morceaux) => fs.readFileSync(path.join(...morceaux), 'utf8');
const ecrire = (fichier, contenu) => {
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, contenu);
};

test('versionDeTag et compareVersions : semver, pas texte', () => {
  assert.equal(versionDeTag('v0.52.0'), '0.52.0');
  assert.equal(versionDeTag('0.52.0'), '0.52.0');
  assert.equal(versionDeTag('v0.52.0-rc.1'), null);
  assert.equal(versionDeTag(undefined), null);
  assert.deepEqual(['0.51.9', '0.51.10', '0.9.0'].sort(compareVersions), ['0.9.0', '0.51.9', '0.51.10']);
});

describe('mise à jour automatique du relais', () => {
  let base;
  let racine;
  let donnees;
  let etat;
  let archives;
  let appels;
  let enService; // la version qui répond sur /health ; null = relais arrêté
  let cassees; // versions qui ne démarrent pas
  let release;
  let journal;

  /** Une archive comme celles de GitHub : un dossier `work-logs-X.Y.Z/` en tête. */
  function publier(version, { sansRelay = false } = {}) {
    const dossier = path.join(base, 'sources', `work-logs-${version}`);
    if (!sansRelay) ecrire(path.join(dossier, 'api', 'src', 'relay.js'), `// relais ${version}\n`);
    ecrire(path.join(dossier, 'api', 'package.json'), '{}\n');
    ecrire(path.join(dossier, 'api', 'package-lock.json'), '{}\n');
    ecrire(path.join(dossier, 'relay', 'mise-a-jour.mjs'), `// script ${version}\n`);
    ecrire(path.join(dossier, 'web', 'index.html'), '<!doctype html>\n');
    const archive = path.join(base, `v${version}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', path.join(base, 'sources'), `work-logs-${version}`]);
    archives[`v${version}`] = archive;
  }

  const outils = () => ({
    derniereRelease: async () => release,
    telecharger: async (_depot, tag, fichier) => fs.copyFileSync(archives[tag], fichier),
    installer: (dossier) => {
      appels.push('npm ci');
      ecrire(path.join(dossier, 'node_modules', 'express', 'index.js'), '');
    },
    charger: () => appels.push('charger'),
    systemctl: (action) => {
      appels.push(action);
      if (action === 'stop') enService = null;
      if (action !== 'start') return;
      const version = lire(racine, 'api', 'VERSION').trim();
      if (cassees.has(version)) return;
      enService = version;
      // Une version neuve migre la base en démarrant.
      if (version !== '0.51.0') fs.writeFileSync(path.join(donnees, 'relais.db'), `base migrée par ${version}`);
    },
    sante: async () => (enService ? { ok: true, service: 'worklogs-relais', version: enService } : null),
    attendre: async () => {},
  });
  const lancer = (reglages = {}) =>
    mettreAJour({ racine, donnees, etat, essais: 3, journal: (message) => journal.push(message), outils: outils(), ...reglages });

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-relais-maj-'));
    racine = path.join(base, 'opt');
    donnees = path.join(base, 'data');
    etat = path.join(base, 'etat');
    ecrire(path.join(racine, 'api', 'src', 'relay.js'), '// relais 0.51.0\n');
    ecrire(path.join(racine, 'api', 'VERSION'), '0.51.0\n');
    ecrire(path.join(racine, 'mise-a-jour.mjs'), '// script 0.51.0\n');
    ecrire(path.join(donnees, 'relais.db'), 'base 0.51.0');
    ecrire(path.join(donnees, 'relais.db-wal'), 'wal 0.51.0');
    archives = {};
    appels = [];
    journal = [];
    enService = '0.51.0';
    cassees = new Set();
    release = 'v0.51.0';
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  test('à jour, ou release plus ancienne : rien ne bouge', async () => {
    assert.deepEqual(await lancer(), { statut: 'a-jour', version: '0.51.0' });
    release = 'v0.50.0';
    assert.equal((await lancer()).statut, 'a-jour', 'jamais de retour en arrière tout seul');
    assert.deepEqual(appels, []);
    assert.equal(lire(racine, 'api', 'src', 'relay.js'), '// relais 0.51.0\n');
  });

  test('--simuler : dit ce qui serait fait, sans rien toucher', async () => {
    publier('0.52.0');
    release = 'v0.52.0';
    assert.deepEqual(await lancer({ simuler: true }), { statut: 'disponible', version: '0.52.0' });
    assert.deepEqual(appels, []);
    assert.match(journal.join('\n'), /v0\.52\.0 disponible \(en service : v0\.51\.0\)/);
  });

  test('nouvelle release : préparée à côté, basculée, vérifiée sur /health, script remplacé', async () => {
    publier('0.52.0');
    release = 'v0.52.0';
    assert.deepEqual(await lancer(), { statut: 'installee', version: '0.52.0', precedente: '0.51.0' });

    assert.deepEqual(appels, ['npm ci', 'charger', 'stop', 'start'], 'préparé avant d’arrêter le relais');
    assert.equal(enService, '0.52.0');
    assert.equal(lire(racine, 'api', 'src', 'relay.js'), '// relais 0.52.0\n');
    assert.equal(lire(racine, 'api', 'VERSION'), '0.52.0\n');
    assert.ok(fs.existsSync(path.join(racine, 'api', 'node_modules', 'express')));
    assert.equal(lire(racine, 'api.precedent', 'src', 'relay.js'), '// relais 0.51.0\n', 'retour arrière possible');
    assert.equal(lire(racine, 'mise-a-jour.mjs'), '// script 0.52.0\n', 'le script de la release servira au passage suivant');
    assert.equal(lire(etat, 'base-avant-maj', 'relais.db'), 'base 0.51.0');
    assert.equal(lire(etat, 'base-avant-maj', 'relais.db-wal'), 'wal 0.51.0');
    assert.equal(JSON.parse(lire(etat, 'etat.json')).version, '0.52.0');
    assert.match(lire(racine, 'DEPLOIEMENT.txt'), /WorkLogs v0\.52\.0[\s\S]*v0\.51\.0, dans api\.precedent[\s\S]*disable --now worklogs-relais-maj\.timer[\s\S]*rm -f \S+\/relais\.db \S+\/relais\.db-wal[\s\S]*cp -a/, 'retour à la main : la base d’avant, sans le journal WAL de la nouvelle');
    assert.deepEqual(fs.readdirSync(racine).sort(), ['DEPLOIEMENT.txt', 'api', 'api.precedent', 'mise-a-jour.mjs'], 'pas de reste de préparation');
    assert.match(journal.at(-1), /v0\.51\.0 → v0\.52\.0/);

    // La suivante remplace api.precedent : une seule version d'avance sur le disque.
    publier('0.52.1');
    release = 'v0.52.1';
    assert.equal((await lancer()).statut, 'installee');
    assert.equal(lire(racine, 'api.precedent', 'VERSION'), '0.52.0\n');
  });

  test('la nouvelle version ne répond pas : code et base reviennent, version écartée jusqu’à la suivante', async () => {
    publier('0.52.0');
    publier('0.52.1');
    cassees.add('0.52.0');
    release = 'v0.52.0';
    // Elle migre la base puis ne répond pas : sans restauration, l'ancien code tomberait sur une base modifiée.
    const demarrer = outils().systemctl;
    const systemctl = (action) => {
      demarrer(action);
      if (action === 'start' && lire(racine, 'api', 'VERSION').trim() === '0.52.0') fs.writeFileSync(path.join(donnees, 'relais.db'), 'base abîmée');
    };
    await assert.rejects(lancer({ outils: { ...outils(), systemctl } }), /v0\.52\.0 ne répond pas/);

    assert.equal(enService, '0.51.0', 'l’ancienne version est relancée');
    assert.equal(lire(racine, 'api', 'src', 'relay.js'), '// relais 0.51.0\n');
    assert.equal(lire(racine, 'api', 'VERSION'), '0.51.0\n');
    assert.equal(lire(donnees, 'relais.db'), 'base 0.51.0');
    assert.equal(lire(donnees, 'relais.db-wal'), 'wal 0.51.0');
    assert.equal(lire(racine, 'mise-a-jour.mjs'), '// script 0.51.0\n');
    const { echec, version: installee } = JSON.parse(lire(etat, 'etat.json'));
    assert.equal(echec.version, '0.52.0');
    assert.match(echec.erreur, /ne répond pas/);
    assert.equal(installee, undefined, 'aucune mise à jour réussie à consigner');
    assert.deepEqual(fs.readdirSync(racine).sort(), ['api', 'mise-a-jour.mjs'], 'l’ancien code est revenu en place, la version cassée est effacée');
    assert.match(journal.join('\n'), /retour à v0\.51\.0[\s\S]*v0\.51\.0 répond de nouveau/);

    // Passage suivant : on ne recoupe pas le relais pour la même version.
    appels = [];
    assert.deepEqual(await lancer(), { statut: 'ecartee', version: '0.52.0' });
    assert.deepEqual(appels, []);
    assert.match(journal.at(-1), /reste en v0\.51\.0/);

    // Le correctif publié passe.
    release = 'v0.52.1';
    assert.equal((await lancer()).statut, 'installee');
    assert.equal(enService, '0.52.1');
    assert.deepEqual(Object.keys(JSON.parse(lire(etat, 'etat.json'))).sort(), ['le', 'precedente', 'version'], 'l’échec est oublié');
  });

  test('/health répond, mais pas avec la nouvelle version : retour arrière', async () => {
    // Un relais lancé à la main garde le port 8420 : le service neuf ne peut pas l'ouvrir,
    // et c'est l'ancien code qui répond encore.
    publier('0.52.0');
    cassees.add('0.52.0');
    release = 'v0.52.0';
    const sante = async () => ({ ok: true, service: 'worklogs-relais' });
    await assert.rejects(lancer({ outils: { ...outils(), sante } }), /v0\.52\.0 ne répond pas/);
    assert.equal(lire(racine, 'api', 'VERSION'), '0.51.0\n');
    assert.equal(JSON.parse(lire(etat, 'etat.json')).echec.version, '0.52.0');
  });

  test('échec pendant la préparation : le relais n’est pas arrêté, retenté au passage suivant', async () => {
    publier('0.52.0');
    release = 'v0.52.0';
    const installer = () => { throw new Error('npm ci : registre injoignable'); };
    await assert.rejects(lancer({ outils: { ...outils(), installer } }), /registre injoignable/);
    assert.deepEqual(appels, []);
    assert.equal(enService, '0.51.0');
    assert.equal(lire(racine, 'api', 'VERSION'), '0.51.0\n');
    assert.equal(fs.existsSync(path.join(etat, 'etat.json')), false, 'pas écartée : ce n’est pas la faute de la version');
    assert.deepEqual(fs.readdirSync(racine).sort(), ['api', 'mise-a-jour.mjs']);

    assert.equal((await lancer()).statut, 'installee');
  });

  test('archive incomplète : refusée avant d’arrêter le relais', async () => {
    publier('0.52.0', { sansRelay: true });
    release = 'v0.52.0';
    await assert.rejects(lancer(), /incomplète : api\/src\/relay\.js manque/);
    assert.deepEqual(appels, []);
    assert.equal(enService, '0.51.0');
  });

  test('relais déjà arrêté : on n’y touche pas (la nouvelle version serait accusée à tort)', async () => {
    publier('0.52.0');
    release = 'v0.52.0';
    enService = null;
    await assert.rejects(lancer(), /ne répond pas.*rien n'est changé/);
    assert.deepEqual(appels, []);
    assert.equal(fs.existsSync(path.join(etat, 'etat.json')), false);
  });

  test('le vrai chargement du module : refuse un relais qui ne se charge pas', () => {
    OUTILS.charger(path.join(ici, '..', 'api'));
    const casse = path.join(base, 'casse');
    ecrire(path.join(casse, 'src', 'relay.js'), "import './absent.js';\n");
    assert.throws(() => OUTILS.charger(casse), /Cannot find module .*absent\.js/);
  });
});

test('unités systemd : le minuteur lance le script installé, en root, toutes les 5 minutes', () => {
  const service = lire(ici, 'worklogs-relais-maj.service');
  const minuteur = lire(ici, 'worklogs-relais-maj.timer');
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/env node \/opt\/worklogs-relais\/mise-a-jour\.mjs$/m);
  assert.doesNotMatch(service, /^User=/m, 'root : il arrête et relance worklogs-relais');
  assert.match(service, /^ReadWritePaths=\/opt\/worklogs-relais \/var\/lib\/worklogs-relais$/m);
  assert.match(minuteur, /^OnUnitActiveSec=5min$/m);
  assert.match(minuteur, /^WantedBy=timers\.target$/m);
});
