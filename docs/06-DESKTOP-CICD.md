# Reprendre le desktop Linux et la CI/CD

Dernière mise à jour : **2026-09-11**. **Travail en cours, non livré.**
Branche : **`codex/linux-desktop-releases`**.

## 1. Demande et point d’arrêt

L’utilisateur veut une application desktop pour **Linux Mint et Fedora**, des builds
**DEB, RPM, AppImage**, une pipeline CI/CD complète (tests, préparation et publication
des releases), et les docs/notes à jour. Il a explicitement validé Electron **44.3.0** et
electron-builder **26.15.3**. La première cible retenue est x86_64, Mint 22.x et Fedora 43/44.

Il a ensuite demandé **d’arrêter, pousser sur GitHub et documenter pour un autre agent**.
Ce checkpoint n’est pas une release publiable. Le dépôt avait déjà des changements V2
non commités : docs réorganisées, scripts, CSS et tests e2e. Ils sont inclus car ce lot
s’appuie dessus. Les données SQLite/uploads ne sont pas versionnées. `master` n’est pas
fusionné. Le commit de pause comporte **`[skip ci]`** pour sauvegarder sans lancer une chaîne
connue comme incomplète. Aucun tag ni GitHub Release n’est créé.

## 2. Reprise en quelques commandes

Lire `00-HANDOVER.md`, `AGENTS.md`, puis ce document. Sur une autre machine :

```bash
git clone git@github.com:timotheegrollier/work-logs.git
cd work-logs
git switch codex/linux-desktop-releases
# Si nvm est installé : nvm install && nvm use
npm ci
npm --prefix api ci
npm --prefix web ci
npx playwright install chromium
npm run build
xvfb-run -a npm run test:desktop -- --grep fichiers
```

Ce dernier test est **rouge au checkpoint**. C’est le premier problème à résoudre.
Sur la machine d’origine : `/home/timo/WorkLogs`, Linux Mint **22.3**, Node **24.13.0**,
npm **11.6.2**. `.nvmrc` prépare Node **24.20.0** pour la CI. Xvfb est installé.
`rpmbuild` manque sur l’hôte. Docker fonctionne et `ubuntu:22.04` a été téléchargée pour
un éventuel build RPM en conteneur. Aucune nouvelle dépendance applicative n’est autorisée
au-delà des deux ajouts déjà validés, sans accord prévu par AGENTS.

## 3. Carte des changements

| Fichiers | Rôle |
|---|---|
| `desktop/main.mjs` | fenêtre, instance unique, protocole `worklogs://app`, liens externes, impression, arrêt |
| `desktop/preload.cjs` | bridge `onBeforeClose`, sans exposition générale d’IPC ou Node |
| `desktop/server.mjs` | Express/SQLite réutilisés, port éphémère 127.0.0.1, jeton, CSP, fermeture |
| `desktop/test/server.test.mjs` | refus sans jeton, persistance, arrêt du serveur |
| `desktop/e2e/desktop.spec.ts` | 4 parcours Electron, réutilisés pour le binaire empaqueté |
| `playwright.desktop.config.ts`, `tsconfig.desktop.json` | runner/typecheck desktop |
| `web/src/autosave.ts` et son test | écritures sérialisées, dernières frappes, flush global |
| `EntryEditor.tsx`, `App.tsx` | sauvegarde au changement d’entrée et avant fermeture desktop |
| `web/public/theme.js`, `web/index.html` | thème avant React, sans script inline interdit par la CSP |
| `api/src/app.js`, `api/test/files.test.js` | correction/test des noms de fichiers accentués en multipart |
| `electron-builder.yml`, `desktop/icon.*` | DEB/RPM/AppImage et icône carnet |
| `scripts/stage-desktop.mjs` | préparation `.desktop-app/`, code autorisé et dépendances API depuis leur lockfile |
| `scripts/verify-package.mjs` | vérification ASAR : contenu requis, version, absence de données personnelles |
| `scripts/check-release.mjs` | format semver et égalité version/tag |
| `scripts/test-linux-package.sh` | installation native puis essais AppImage dans un conteneur jetable |
| `.github/workflows/ci.yml` | tests → packaging → matrice Ubuntu 24.04/Fedora 43/Fedora 44 |
| `.github/workflows/release.yml` | réutilise la CI, SHA256SUMS, attestation, brouillon/publication |
| `.github/dependabot.yml` | propositions mensuelles npm et GitHub Actions |

La version racine est **0.2.0**, préparatoire et non publiée. Les sous-paquets web/api
restent à 0.1.0 ; le desktop prend sa version à la racine. Le dépôt n’avait pas de licence :
le manifeste indique `UNLICENSED`, sans attribuer une licence libre. À décider pour la
diffusion finale si nécessaire.

## 4. Résultats réellement observés

| Vérification | Résultat et limites |
|---|---|
| `check.sh` **avant ce lot** | **CHECK OK**, 60 API + 52 front + 12 navigateur |
| Front après autosave | **55/55 passés**, dont 3 nouveaux tests de file de sauvegarde |
| Serveur desktop | **1/1 passé** |
| Build web et types desktop | passés après leurs modifications |
| Electron : fenêtre/isolation/liens externes | passé |
| Electron : fermeture immédiate + thème au redémarrage | passé |
| Electron : PDF + refus de fermer si sauvegarde échouée | passé |
| Electron : fichiers et export | **échoue**, détail ci-dessous |
| Nouveau test API des accents | écrit, pas encore exécuté dans la suite API complète |
| DEB/AppImage | première construction exploratoire produite ; reconstruction suivante interrompue au checkpoint |
| Vérification ASAR | passée sur la première archive, avant les derniers ajustements ; à refaire |
| RPM | configuré, pas construit/validé |
| Installation Mint/Fedora/AppImage | pas exécutée |
| GitHub Actions / attestations / publication | fichiers préparés, pas exécutés ni validés |
| `check.sh` après ce lot | **pas vert** : le parcours desktop connu échoue |

Ne pas remplacer les assertions pour obtenir artificiellement un vert. La présence d’une
configuration RPM ne prouve pas le fonctionnement sous Fedora.

### Blocage : téléchargement via le protocole personnalisé

Le test `fichiers joints et export JSON fonctionnent dans l’application empaquetée`
attend `page.waitForEvent('download')`, clique `pièce.txt` et expire après 30 secondes.
L’upload fonctionne et le lien **avec son nom accentué** apparaît. L’export JSON, situé
plus loin dans le test, **n’a pas encore été vérifié**.

`protocol.handle('worklogs', ...)` renvoie la réponse du serveur HTTP privé qui appelle
`res.download`. Le test règle `item.setSavePath(...)` dans
`session.defaultSession.on('will-download', ...)`, mais attend ensuite l’événement de
la page Playwright. **À distinguer** : panne réelle de téléchargement ou limitation de
l’observation Playwright sur un protocole custom.

Prochaine démarche : tracer `will-download` et `DownloadItem` côté main, contrôler le
fichier disque et son contenu, vérifier le geste réel et l’export. Si un traitement
desktop spécifique est nécessaire, garder le bridge étroit et les adresses validées,
préserver le web, puis tester le comportement de bout en bout.

## 5. Pièges déjà rencontrés et points à revoir

- **ESM/ready** : `await app.whenReady()` au niveau supérieur de `main.mjs` bloquait le
  démarrage. Le code utilise `void app.whenReady().then(async () => ...)`.
- **Relais HTTP** : `net.fetch` Chromium avec les headers de la requête custom échouait
  avec `net::ERR_FAILED`. Le `fetch` Node utilise maintenant le jeton et le Content-Type
  nécessaire. GET/PUT et uploads passent.
- **Origine stable** : ne pas revenir à un port HTTP aléatoire comme origine de la fenêtre
  sans traiter la persistance du thème/localStorage.
- **Accents** : Busboy lit les noms multipart en latin1. Le correctif UTF-8 fait passer
  l’assertion `pièce.txt`. Revoir aussi les noms Unicode déjà décodés/RFC 5987 : la conversion
  ne doit pas tronquer un caractère hors latin1. Le nouveau test API doit être exécuté.
- **Sandbox** : `sandbox: true`, isolation et Node désactivé dans le renderer.
  `WORKLOGS_TEST_NO_SANDBOX=1` sert uniquement aux tests CI/conteneurs.
  AppImage configure `executableArgs: []` pour retirer le `--no-sandbox` par défaut du builder.
  Contrôler le lanceur réellement produit et le comportement Mint/AppArmor et Fedora.
- **Packaging** : DEB utilise maintenant gzip car xz prenait plusieurs minutes. Refaire
  les trois formats après tous les changements. Installer les outils RPM ou les utiliser
  dans un conteneur jetable. Ne pas publier les fichiers exploratoires restants.
- **Tests sur paquets** : valider les chemins `/opt/WorkLogs/worklogs` et `AppRun`, les
  dépendances système, l’installation, le lancement et la préservation des données.
- **Données web** : aucun import automatique vers le desktop. Prévoir une reprise via
  copie SQLite cohérente avec WAL et uploads, sans écraser une base desktop existante.
- **Arrêt** : revoir si nécessaire seconde instance, annulation, rechargement, erreur disque
  et arrêt système. Les tests existants vérifient la fermeture normale et l’échec de sauvegarde.

## 6. Données et commandes de travail

| Élément | Emplacement par défaut |
|---|---|
| Web | `api/data/worklogs.db` et `api/data/uploads/` |
| Desktop | `${XDG_DATA_HOME:-$HOME/.local/share}/worklogs/worklogs.db` et `uploads/` |
| Profil et thème | `~/.config/worklogs/`, chemin appData Electron |
| Préparation packaging | `.desktop-app/`, ignoré par Git |
| Paquets | `release/`, ignoré par Git |
| Tests | répertoires jetables `/tmp/worklogs-desktop-*` et rapports `test-results/` |

```bash
npm run desktop
npm run test:desktop:unit
npm run typecheck:desktop
npm run build
xvfb-run -a npm run test:desktop
./scripts/check.sh
npm run desktop:pack
npm run desktop:dist
node scripts/verify-package.mjs
WORKLOGS_EXECUTABLE="$PWD/release/linux-unpacked/worklogs" xvfb-run -a npm run test:desktop
./scripts/test-linux-package.sh ubuntu:24.04 deb
./scripts/test-linux-package.sh fedora:43 rpm
./scripts/test-linux-package.sh fedora:44 rpm
```

Les tests renseignent `WORKLOGS_DATA_DIR` et `WORKLOGS_PROFILE_DIR` pour isoler les données.
Ne jamais les pointer vers les données personnelles. Le script `backup.sh` historique
sauvegarde encore **le mode web uniquement**. Les ports web 8410/8411 et e2e 8412 sont conservés.

## 7. CI/CD prévue — à éprouver

La CI démarre sur push de branche et PR, exécute `check.sh`, construit les trois formats,
inspecte l’ASAR et teste les paquets installés dans Ubuntu 24.04 (base Mint 22.x), Fedora
43 et Fedora 44. L’AppImage est extraite et testée sur chaque environnement. Cela ne remplace
pas une recette Cinnamon/Wayland sur une vraie session desktop.

Les actions sont épinglées sur des SHA récupérés depuis leurs tags officiels. Test/build
ont `contents: read`. Seul le job release demande les droits d’écriture, attestations et OIDC.

`release.yml` démarre sur **tag `v*`**, réexécute la CI et impose l’égalité avec la version
racine. Il calcule SHA256SUMS, crée une attestation et un brouillon, charge les trois formats,
puis publie après succès. Les suffixes `-rc.N`, `-beta.N`, `-alpha.N` produisent une prérelease.
Le lancement manuel prend un tag existant et conserve le brouillon. Les releases déjà
publiées ne sont pas remplacées.

**Ne pas pousser de tag avant validation.** Faire d’abord un commit de correction sans
`[skip ci]` sur cette branche pour exercer les workflows :

```bash
gh run list --branch codex/linux-desktop-releases
gh run view RUN_ID --log-failed
```

Permissions, attestations, erreurs/reruns et publication effective restent à tester.
Le lancement manuel sera normalement disponible dans l’interface GitHub lorsque le
workflow sera sur la branche par défaut ; ne pas fusionner un lot rouge pour contourner cela.

## 8. Ordre conseillé pour terminer

1. Reproduire et résoudre/vérifier le téléchargement Electron, puis l’export JSON.
2. Exécuter le test API des accents et vérifier les cas Unicode déjà décodés.
3. Rendre **`./scripts/check.sh` entièrement vert**, sans ignorer le desktop.
4. Reconstruire DEB/RPM/AppImage ; vérifier l’ASAR et le binaire empaqueté.
5. Exécuter les trois essais de distribution, y compris chaque AppImage.
6. Faire une recette réelle : installation, icône/raccourci, édition, fermeture,
   redémarrage, fichiers, export, impression, conservation des données après mise à jour.
7. Documenter reprise des données web, installation finale et sauvegarde desktop.
8. Pousser sans skip CI, corriger les runs GitHub et vérifier la chaîne de release.
9. Mettre à jour les résultats de ce document et le handover avant de livrer.

## 9. Journaux locaux utiles — non versionnés

- `/tmp/worklogs-desktop-baseline.log` : recette initiale verte.
- `/tmp/worklogs-desktop-web-tests.log` : 55 tests front passés.
- `/tmp/worklogs-desktop-e2e-next.log` : 3 parcours Electron verts, échec initial des accents.
- `/tmp/worklogs-desktop-download.log` : échec actuel sur `page.waitForEvent('download')`.
- `/tmp/worklogs-desktop-pack.log` : première construction DEB/AppImage exploratoire.
- `/tmp/worklogs-desktop-pack-final.log` : reconstruction commencée puis arrêtée au checkpoint.

Ces logs peuvent disparaître. Les fichiers de `release/` peuvent être périmés, partiels
ou absents : **reconstruire**, ne pas publier directement. Le mot « final » du nom de log
n’est pas une validation.

## 10. Références consultées

- [Electron 44.3.0](https://releases.electronjs.org/release/v44.3.0)
- [ESM dans Electron](https://www.electronjs.org/docs/latest/tutorial/esm)
- [Cycle de vie Electron](https://www.electronjs.org/docs/latest/api/app)
- [Electron avec Playwright](https://playwright.dev/docs/api/class-electron)
- [Formats Linux electron-builder](https://www.electron.build/v26/docs/linux/)
- [Attestations GitHub Actions](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
