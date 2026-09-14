# Desktop Linux et CI/CD — dossier technique

Dernière mise à jour : **2026-09-14**. **Le lot est terminé et en production** : 19 releases
publiées (`v0.2.0` → `v0.6.12`), les trois workflows tournent réellement sur GitHub, les
paquets s'installent sur les trois cibles CI. Tout est sur **`master`** (la branche
`codex/linux-desktop-releases` a été absorbée). Seule la **recette manuelle sur une vraie
session graphique** reste à faire — voir §4.

Pour **publier**, ce n'est pas ici : [07-RELEASES.md](07-RELEASES.md).
Les sections §1 et §6 gardent leur valeur : ce sont les bugs réels et les pièges vécus,
à ne pas réintroduire.

## 1. Bugs résolus lors du déblocage initial

Le lot précédent s'était arrêté avec `check.sh` rouge : le test Electron du téléchargement
expirait après 30 s sur `page.waitForEvent('download')`. Cette reprise a **résolu ce blocage
et trois autres bugs découverts en creusant**, puis validé les paquets sur les trois cibles
CI (Ubuntu 24.04, Fedora 43, Fedora 44) dans des conteneurs jetables. Machine de reprise :
**Fedora 44**, pas Mint — confirme que la fiche de passation d'origine tient sur une autre
machine, comme prévu.

### 1.1 Diagnostic du blocage : une limite de Playwright, pas une panne

Le téléchargement fonctionne réellement côté Electron (`will-download` se déclenche, le
fichier est écrit avec le bon contenu) : instrumenté directement sur `session.defaultSession`,
il se termine en `done:completed`. Mais **`page.waitForEvent('download')` de Playwright ne se
déclenche jamais** pour une ressource servie par un protocole personnalisé (`worklogs://`)
intercepté via `protocol.handle`. C'est une limite d'intégration Electron/Playwright, pas un
défaut applicatif. `desktop/e2e/desktop.spec.ts` observe donc directement `will-download` au
niveau session (fonction `downloadNext`), comme le ferait un test qui ne peut pas piloter la
boîte de dialogue native. Les 4 tests desktop passent maintenant en ~4 s au lieu de expirer
après 30 s.

### 1.2 Bug trouvé en creusant : nom de fichier suggéré cassé pour les protocoles personnalisés

En instrumentant `will-download`, `item.getFilename()` renvoyait `"download"` au lieu du vrai
nom, **y compris pour un nom ASCII simple**, dès que le `Content-Disposition` contenait le
paramètre étendu `filename*=UTF-8''...` — pourtant strictement conforme RFC 6266. Un script de
test isolé (`session.protocol.handle` + plusieurs en-têtes) a montré qu'Electron ne décode
correctement **ni** `filename*=` **ni** `filename="…"` avec des octets non-ASCII bruts pour
les téléchargements servis par un protocole personnalisé : le nom retombe sur `"download"`
dans les deux cas, alors qu'un nom ASCII pur fonctionne. `desktop/main.mjs` corrige donc le
nom **lui-même** dans un nouveau handler `will-download` : il relit `item.getContentDisposition()`
(disponible, correct, juste ignoré par Electron pour le nom suggéré) et appelle
`item.setSaveDialogOptions({ defaultPath })` avec le nom décodé. Sans ce correctif, un
utilisateur réel aurait vu « download » pré-rempli dans la boîte de sauvegarde pour **toute**
pièce jointe, accentuée ou non.

### 1.3 Bug corrigé en même temps : l'API accents (RFC 6266)

Le test `api/test/files.test.js` (« conserve les accents du nom transmis par le navigateur »)
n'avait jamais tourné dans la suite complète. Il attendait `filename*=UTF-8''pi%C3%A8ce` dans
le `Content-Disposition` ; `res.download()` d'Express (via le module `content-disposition`)
n'émet ce paramètre étendu **que** si le nom n'est pas représentable en Latin-1 — ce qui
n'est jamais le cas des accents français courants (`é`, `è`…). `api/src/app.js` construit donc
lui-même l'en-tête (`attachmentHeader`), avec systématiquement `filename` (repli ASCII) et
`filename*` (UTF-8). Documenté dans une vraie limite connue de la bibliothèque
([jshttp/content-disposition#27](https://github.com/jshttp/content-disposition/issues/27)),
qui cite explicitement les téléchargements Electron comme cas mal couvert.

Vérifié en même temps : la conversion latin1→UTF-8 des noms de fichiers **uploadés**
(busboy ne comprend pas `filename*` en multipart, donc ne produit jamais un nom déjà décodé
avec des caractères hors Latin-1 — le correctif existant est sûr dans tous les cas réels).

### 1.4 Bug corrigé, trouvé par un effet de bord du 1.3 : chemin relatif et `res.sendFile`

Remplacer `res.download(file, filename)` par `res.setHeader(...) + res.sendFile(file)` a fait
échouer en 500 le test e2e navigateur « joindre un fichier… » : `res.download()` résout le
chemin en absolu via `path.resolve()` avant d'appeler `sendFile` en interne ; `res.sendFile()`
**exige** un chemin déjà absolu et lève sinon `TypeError: path must be absolute or specify
root`. `playwright.config.ts` lance l'API e2e avec `DATA_DIR=./.e2e-data` (relatif), ce qui
déclenchait l'erreur. Corrigé par `res.sendFile(path.resolve(file))`.

### 1.5 Bug critique de packaging trouvé en testant les paquets réels : ALSA sur Ubuntu 24.04/Mint 22.x

En installant le `.deb` construit dans un conteneur `ubuntu:24.04` propre (base de
`mint-22-base` dans la CI), l'application **ne démarrait pas du tout** :
```
worklogs: symbol lookup error: worklogs: undefined symbol: snd_device_name_get_hint, version ALSA_0.9
```
Cause : sur Ubuntu 24.04 (transition « t64 »), le paquet virtuel `libasound2` déclaré en
dépendance est satisfait par **deux** paquets concurrents — `libasound2t64` (la vraie lib ALSA)
et `liboss4-salsa-asound2` (une couche de compatibilité OSS qui n'implémente pas tous les
symboles). `apt` a choisi le second. C'est un bug Ubuntu connu et documenté
([LP #2069153](https://bugs.launchpad.net/bugs/2069153),
[electron-builder #9539](https://github.com/electron-userland/electron-builder/issues/9539)) qui
touche beaucoup d'apps Electron packagées pour Debian sur les distributions post-t64. Corrigé
dans `electron-builder.yml` par une dépendance alternative Debian, dans l'ordre de préférence :
`'libasound2t64 | libasound2'` (Ubuntu 22.04 n'a pas `libasound2t64` et retombe sur
`libasound2`, qui existe encore là-bas). **Sans ce correctif, l'application ne se serait pas
lancée du tout sur une vraie install Mint 22.x/Ubuntu 24.04**, seul format `deb` concerné
(RPM utilise `alsa-lib`, qui n'a pas cette ambiguïté sur Fedora 43/44).

## 2. Résultats réellement observés

Décomptes du **2026-09-14** pour `check.sh` ; le reste date de la campagne de validation
du 2026-09-11 et n'a pas été rejoué depuis.

| Vérification | Résultat |
|---|---|
| `./scripts/check.sh` complet | **CHECK OK** — types, 61 tests API, 61 tests front, 16 tests serveur desktop, 10 tests des scripts de release, build, 12 tests navigateur, **5 tests application desktop** (165 au total). Reproduit aussi dans des conteneurs Ubuntu 22.04 fraîchement provisionnés lors de la validation initiale |
| `npm run desktop:dist` (DEB+RPM+AppImage) | Construit sans erreur une fois `ar`/`rpmbuild`/`fakeroot` disponibles sur la machine de build |
| `node scripts/verify-package.mjs` | Passe : contenu attendu présent, aucune donnée personnelle, version cohérente |
| Installation **DEB** sur `ubuntu:24.04` (base Mint 22.x) | Installe et lance après le correctif ALSA (1.5). 4/4 tests desktop passent sur `/opt/WorkLogs/worklogs` |
| Installation **RPM** sur `fedora:43` | Installe et lance. 4/4 tests desktop passent |
| Installation **RPM** sur `fedora:44` | Installe et lance. 4/4 tests desktop passent |
| **AppImage** extraite, sur les 3 images ci-dessus | 4/4 tests desktop passent à chaque fois (donc **24/24** au total sur les 3 cibles × 2 formats) |
| GitHub Actions (`ci.yml`, `release.yml`, `rpm-repo.yml`) | **Exécutés en continu depuis le 2026-09-11** : 29 succès sur les 30 derniers runs (l'échec du 12/09 sur « fenêtre maximisée » a été corrigé par le commit suivant, `435645a`) |
| Releases publiées | **19**, de `v0.2.0` (11/09 18:54) à `v0.6.12` (12/09 23:18), avec SHA256SUMS et attestation de provenance |
| Recette manuelle sur vraie session desktop | **Toujours pas faite** — aucun agent n'a eu accès à un vrai bureau Cinnamon/GNOME (voir §4) |

Tous les tests d'installation ci-dessus ont tourné dans des conteneurs Docker/Podman jetables,
comme le fait `scripts/test-linux-package.sh` (non modifié — voir §3 pour une note d'exécution
locale). Aucune règle du projet n'a été assouplie pour obtenir ces résultats : les bugs 1.2 à
1.5 sont de vrais correctifs, pas des contournements de test.

## 3. Note d'exécution locale (SELinux) — ne concerne pas la CI

Sur une machine Fedora avec SELinux *enforcing* (le cas de cette reprise), les montages
`docker run -v host:container` de `scripts/test-linux-package.sh` échouent par défaut
(« Permission denied ») car podman n'étiquette pas automatiquement les volumes pour SELinux.
**Le script n'a pas été modifié** : sur les runners GitHub Actions (Ubuntu, sans SELinux), il
s'exécute tel quel. Pour reproduire en local sur Fedora/SELinux, ajouter `:z` (label partagé)
aux montages d'une copie de travail du script, et remplacer le montage du `node` hôte par une
installation de Node fraîche dans le conteneur (le `node`/`npm` d'un hôte Fedora ne fonctionne
pas correctement une fois monté tel quel dans un conteneur Ubuntu — liens symboliques absolus
qui ne survivent pas au changement de racine).

## 4. Ce qu'il reste à faire

1. **Recette manuelle réelle** — le seul point de la liste d'origine encore ouvert, et le plus
   important. Sur Mint 22.x et Fedora 43/44 si possible, avec une vraie session graphique :
   installer le paquet, vérifier icône et raccourci, éditer une entrée, joindre un fichier,
   l'ouvrir depuis la boîte « Enregistrer sous » (**vérifier que le nom proposé est le bon** —
   c'est le correctif 1.2, jamais vu avec de vrais yeux), exporter, imprimer via la vraie boîte
   système, fermer, rouvrir, vérifier que les données ont survécu, puis dérouler un cycle de
   mise à jour complet depuis le dépôt dnf. Tout le reste a été validé en conteneur ou sous
   Xvfb, ce qui ne dit rien du rendu ni des dialogues natifs.
2. **Node aligné sur `.nvmrc`** : le fichier demande 24.20.0, la machine de développement a
   24.13.0, `jsdom@30` réclame ≥ 24.15.0. Les tests passent malgré l'avertissement
   `EBADENGINE`, mais l'écart finira par coûter une session de débogage.
3. **Licence** : toujours `UNLICENSED` (cf. `05-DECISIONS.md`). À trancher avant toute
   diffusion publique.
4. **Signature GPG du dépôt dnf** : aujourd'hui `gpgcheck=0`, acceptable en usage personnel.

## 5. Carte des changements (rappel, inchangée depuis la précédente passation)

| Fichiers | Rôle |
|---|---|
| `desktop/main.mjs` | fenêtre, instance unique, protocole `worklogs://app`, liens externes, impression, arrêt, **+ correction du nom de fichier suggéré au téléchargement (1.2)** |
| `desktop/preload.cjs` | bridge `onBeforeClose`, sans exposition générale d'IPC ou Node |
| `desktop/server.mjs` | Express/SQLite réutilisés, port éphémère 127.0.0.1, jeton, CSP, fermeture |
| `desktop/test/server.test.mjs` | refus sans jeton, persistance, arrêt du serveur |
| `desktop/e2e/desktop.spec.ts` | 4 parcours Electron, **observation du téléchargement corrigée (1.1)** |
| `api/src/app.js` | **en-tête `Content-Disposition` reconstruit (1.3), chemin absolu pour `sendFile` (1.4)** |
| `electron-builder.yml` | DEB/RPM/AppImage et jeu d'icônes hicolor (16→512 px depuis `desktop/icon.svg`), **dépendance ALSA corrigée pour Ubuntu 24.04+ (1.5)** |
| `scripts/stage-desktop.mjs` | préparation `.desktop-app/`, code autorisé et dépendances API depuis leur lockfile |
| `scripts/verify-package.mjs` | vérification ASAR : contenu requis, version, absence de données personnelles |
| `scripts/check-release.mjs` | format semver et égalité version/tag |
| `scripts/test-linux-package.sh` | installation native puis essais AppImage dans un conteneur jetable — **non modifié**, validé manuellement (§2, §3) |
| `.github/workflows/ci.yml` | tests → packaging → matrice Ubuntu 24.04/Fedora 43/Fedora 44 — **en service** |
| `.github/workflows/release.yml` | réutilise la CI, SHA256SUMS, attestation, brouillon/publication — **en service** |
| `.github/workflows/rpm-repo.yml` | dépôt dnf sur `gh-pages`, déclenché par la fin de « Release Linux » |
| `.github/dependabot.yml` | propositions mensuelles npm et GitHub Actions |
| `desktop/update.mjs` | détection du format installé, PackageKit (`pkcon`), electron-updater |
| `scripts/check-release.mjs` | semver, égalité version/tag, **et synchronisation de `package-lock.json`** |

Cette carte décrit le déblocage initial ; les fonctionnalités ajoutées ensuite
(mise à jour intégrée, dépôt dnf, polish de l'interface) sont documentées dans
[07-RELEASES.md](07-RELEASES.md) §7.

## 6. Pièges déjà rencontrés (cumulatif avec la passation précédente)

- **ESM/ready**, **relais HTTP**, **origine stable**, **sandbox test**, **packaging DEB
  gzip/xz** : voir la version précédente de ce document dans l'historique Git, toujours vrais,
  non repris ici pour éviter la redite.
- **Accents et Electron** : Electron ne décode fiablement **ni** `filename*=` (RFC 5987) **ni**
  les octets non-ASCII bruts de `filename="…"` pour un téléchargement servi par
  `protocol.handle`. Ne pas compter sur le nom que Electron déduit seul
  (`item.getFilename()`) dès qu'un nom contient un caractère non-ASCII : le relire depuis
  `item.getContentDisposition()` côté main process si besoin (fait dans `main.mjs`).
- **`res.download()` vs `res.sendFile()`** : le premier résout le chemin en absolu
  (`path.resolve`), pas le second. Toujours passer un chemin déjà absolu à `res.sendFile()`.
- **Dépendances virtuelles Debian post-t64** (Ubuntu 24.04, Debian 13+) : un paquet qui déclare
  `libasound2`, `libgconf-2-4` ou d'autres libs migrées peut se voir installer un mauvais
  fournisseur si plusieurs paquets « Provides: » le même nom virtuel. Vérifier après tout
  changement de version cible avec `apt-cache showpkg <paquet>` et préférer une dépendance
  alternative explicite (`nouveau-nom | ancien-nom`) plutôt que de se fier à la résolution par
  défaut d'apt.
- **SELinux et podman en local** : voir §3, ne concerne que le poste de développement, pas la CI.
- **`page.waitForEvent('download')` avec un protocole personnalisé Electron** : ne se déclenche
  jamais dans cette configuration (`protocol.handle`, scheme privileged `stream: true`).
  Observer `will-download` sur `session.defaultSession` directement plutôt que l'API haut
  niveau de Playwright quand le téléchargement traverse un protocole personnalisé.
- **Environnements de test Electron jetables** : après de multiples manipulations manuelles
  d'un même conteneur (changement d'utilisateur, permissions setuid ajoutées à la main sur
  `chrome-sandbox`, réinstallations successives de libs), un test peut échouer pour des raisons
  propres à cet état accumulé et non reproductibles dans un conteneur frais. Avant de conclure
  à un bug produit, reproduire dans un conteneur vierge.

## 7. Données et commandes de travail (inchangé)

| Élément | Emplacement par défaut |
|---|---|
| Web | `api/data/worklogs.db` et `api/data/uploads/` |
| Desktop | `${XDG_DATA_HOME:-$HOME/.local/share}/worklogs/worklogs.db` et `uploads/` |
| Profil et thème | `~/.config/worklogs/`, chemin appData Electron |
| Préparation packaging | `.desktop-app/`, ignoré par Git |
| Paquets | `release/`, ignoré par Git |

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

## 8. Références consultées (cumulatif)

- [Electron 44.3.0](https://releases.electronjs.org/release/v44.3.0)
- [Formats Linux electron-builder](https://www.electron.build/v26/docs/linux/)
- [jshttp/content-disposition#27 — filename* et Latin-1](https://github.com/jshttp/content-disposition/issues/27)
- [electron/electron#44375 — liens `download` et `will-download`](https://github.com/electron/electron/issues/44375)
- [Launchpad #2069153 — `liboss4-salsa-asound2` squatte `libasound2`](https://bugs.launchpad.net/bugs/2069153)
- [electron-builder#9539 — dépendances par défaut et transition t64](https://github.com/electron-userland/electron-builder/issues/9539)
