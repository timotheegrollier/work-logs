# Releases — processus complet (lire avant de publier)

Dernière mise à jour : **2026-09-14**. **19 releases publiées**, de `v0.2.0` (11/09) à
`v0.6.12` (12/09) — `gh release list` fait foi.
Notes de release **en anglais**, générées par `scripts/release-notes.mjs`.

## 1. Carte du pipeline

```
commit sur master ──► CI Linux ──► tag vX.Y.Z ──► Release Linux ──► GitHub Release publiée
                       (push)         (push)         (precheck → validate? → release)
```

| Étape | Workflow | Durée typique |
|---|---|---|
| CI sur `master` (job `validate` : types, 61 tests API, 61 tests front, 16 tests serveur desktop, 10 tests scripts, build, 12 tests navigateur, 5 tests desktop, `desktop:dist`, `verify-package` ; puis matrice `packages` : install + lancement sur Ubuntu 24.04 / Fedora 43 / 44, natif + AppImage) | `ci.yml` | ~6 min |
| `precheck` : le commit tagué a-t-il déjà une CI verte sur master ? | `release.yml` | ~20 s |
| `validate` (pleine) : **seulement si `precheck` répond non** | `ci.yml` réutilisé | ~6 min |
| `release` : SHA256SUMS, attestation de provenance, notes, upload, publication | `release.yml` | ~1–2 min |

Fast path habituel (tag posé juste après une CI verte) : **tag → publié en ~2 min**.
Sans fast path : ~8 min. Les deux chemins publient exactement les mêmes artefacts.
Mesuré sur la v0.4.1 : dispatch 20:51:42 → brouillon complet 20:52:45 (~63 s).

## 2. Règles de versionnage

- `package.json` racine seule fait foi (`api`/`web` restent en `0.1.0`).
- **`package-lock.json` doit suivre.** Il porte la version à deux endroits et npm ne les met à
  jour que via `npm version` : un bump à la main dans `package.json` laisse le lock en arrière.
  C'est arrivé — constaté le 2026-09-14 avec **huit versions d'écart** (lock en `0.4.2`,
  manifeste en `0.6.12`). `scripts/check-release.mjs` refuse désormais ce cas, avec la commande
  de remédiation dans le message (6 tests dans `scripts/check-release.test.mjs`).
- `vX.Y.Z` : Y+1 pour une fonctionnalité (icône, mise à jour au démarrage…), Z+1 pour
  correctifs/docs/process. `scripts/check-release.mjs` refuse un tag ≠ version.
- Ne jamais réécrire une release publiée : le workflow refuse d'écraser (`isDraft` testé).

## 3. Publier une release (pas à pas)

```bash
./scripts/check.sh                                  # doit finir par « CHECK OK »
git commit … && git push origin master              # 1. CI verte sur master (attendre)
npm version X.Y.Z --no-git-tag-version              # 2. bump package.json ET package-lock.json
node scripts/check-release.mjs vX.Y.Z               # 3. semver, tag, lockfile synchronisé
git commit -am "release: passe en X.Y.Z" && git push # 4. la CI re-valide le bump (attendre)
git tag vX.Y.Z && git push origin vX.Y.Z            # 5. déclenche Release Linux
gh run watch <id>                                   #    fast path : ~2 min
gh release view vX.Y.Z --json assets --jq '.assets[].name'
```

Ne pas éditer `package.json` à la main : `npm version` met les deux fichiers d'accord, et
`--no-git-tag-version` l'empêche de commiter et de taguer tout seul (le tag doit venir
**après** une CI verte, c'est ce qui rend le fast path sûr — §4).

La note est générée, pas écrite à la main. Vérifier le rendu après publication ;
retouche possible sans republier : `gh release edit vX.Y.Z --notes-file /tmp/notes.md`.

## 4. Fast path : pourquoi c'est sûr

Notre processus ne tage **que** le HEAD de master **après** sa CI verte. `precheck`
vérifie ce fait via l'API GitHub (commit du tag → run `CI Linux` en succès sur
`master`) au lieu de le supposer :

- `skip=true` → on réutilise les paquets du run vert (`gh run download`, rétention
  14 jours), pas de rebuild.
- `skip=false` (tag sur un commit non testé) → `validate` complète, puis `release`
  utilise les artefacts frais du run courant. Aucun cas ne publie sans CI verte.
- Garde-fous : `release` exige `precheck == success ET (skip OU validate == success)` ;
  `fetch-depth: 0` pour que `--verify-tag` et les notes voient tout l'historique.

Permissions minimales : `precheck`/`release` ajoutent `actions: read` (lecture des runs
et téléchargement inter-runs), indispensable au fast path.

Deux leçons de la mise au point (v0.4.1, ne pas réintroduire) :
- `precheck` n'a pas de checkout (volontaire : 0 s) — donc `gh` n'a aucun contexte
  de dépôt : `gh run list` exige `-R "$GITHUB_REPOSITORY"`, sinon
  « failed to determine base repo ».
- En revanche `gh api` ne connaît pas `-R` (l'endpoint contient déjà le dépôt) —
  passer `-R` à `gh api` échoue avec « unknown shorthand flag ».

## 5. Notes de release (`scripts/release-notes.mjs`)

`node scripts/release-notes.mjs vX.Y.Z --release-dir release` imprime le Markdown :
chapeau anglais + tableau de téléchargement (tailles lues dans `release/`) +
sections `What's new` / `Fixes` / `Dependencies` / `Other changes` triées depuis
`git log PREV..TAG --no-merges` + lien `compare/...`. Sections vides omises.
Les sujets de commits sont repris tels quels ; tout le reste est en anglais.

Testé : `scripts/release-notes.test.mjs` (4 tests, exécutés dans `check.sh` via
`node --test scripts/*.test.mjs`). Vérifier le rendu à la main avant de taguer :
`node scripts/release-notes.mjs vX.Y.Z | head -40`.

## 6. Tester le processus sans publier

- `workflow_dispatch` sur `Release Linux` avec un tag existant : rejoue la
  vérification et prépare un **brouillon** sans publier (le step de publication ne
  tourne que sur `push` de tag). Idéal pour valider un changement de workflow.
- Logique `precheck` rejouable en local : voir §4 (deux appels `gh`, ~10 s).
- YAML : `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"`.

## 7. Mises à jour sans tout retélécharger (depuis la 0.5.0)

Trois circuits selon le format installé (détecté par `installKind()` dans
`desktop/update.mjs` : variable `APPIMAGE`, chemin sous `/opt`, sinon dev) :

| Installé via | Mise à jour | Téléchargé |
|---|---|---|
| `.rpm` + dépôt dnf | dialogue « Mettre à jour maintenant » → PackageKit (`pkcon`, mot de passe via polkit) → « Redémarrer » ; revérifié toutes les 5 min en tâche de fond | paquet complet (~83 Mo) |
| `.deb` + dépôt apt **(depuis la 0.7.0)** | même circuit, dorsale apt de PackageKit | paquet complet (~121 Mo) |
| `.AppImage` | dialogue « Mettre à jour » → téléchargement **différentiel** → « Redémarrer » | seuls les blocs modifiés (~1–5 Mo) |
| Paquet système sans dépôt activé | page de téléchargement, avec la commande d'activation du dépôt | paquet complet |

Le workflow **« Dépôts »** (`repos.yml`, ex-`rpm-repo.yml`) publie les deux dépôts à chaque
release et **ne garde que les 3 dernières versions** (`scripts/prune-repo.mjs`).

### Dépôt apt (Debian, Ubuntu, Linux Mint)

```bash
sudo curl -fsSL -o /etc/apt/sources.list.d/worklogs.list \
  https://timotheegrollier.github.io/work-logs/deb/worklogs.list
sudo apt update && sudo apt install --only-upgrade worklogs
```
Dépôt **plat** (`Packages` + `Release` à la racine, d'où le `/` final dans le `.list`),
non signé — `[trusted=yes]`, même choix que `gpgcheck=0` côté dnf.

> **Contrainte à surveiller.** GitHub refuse tout fichier de plus de **100 Mo** dans un dépôt
> git. Le `.deb` en gzip pesait 116 Mo : impossible à publier, donc pas de dépôt apt. Il est
> passé en **xz** (`electron-builder.yml`) et tombe à **93 Mo** — il ne reste que **7 Mo de
> marge**, et le build gagne ~3 min. Si une version dépasse la limite, le workflow publie
> quand même le dépôt dnf, saute le dépôt apt et **finit en rouge** pour le signaler.
> Il faudra alors alléger le paquet ou héberger les `.deb` hors de gh-pages.
Construit par `scripts/build-deb-repo.sh`, testé install **puis** upgrade dans un
conteneur `ubuntu:24.04` (la base de Mint 22.x) à chaque release.

### Dépôt dnf

- Contenu : tous les `.rpm` gardés + `repodata/` + `worklogs.repo`, sur la branche
  `gh-pages` (servi par GitHub Pages : `https://timotheegrollier.github.io/work-logs/rpm/`).
- Construction : `scripts/build-rpm-repo.sh <dir>` (`createrepo_c --update`).
- Workflow `rpm-repo.yml` : déclenché par la FIN de « Release Linux »
  (`workflow_run`, pas `release`) — voir pièges. Il télécharge le RPM de la
  release + celui de la précédente, construit le repodata,
  **teste install + update dans un conteneur Fedora jetable**, puis pousse sur `gh-pages`.
- **Pas de delta RPMs** : `makedeltarpm` ne lit pas les payloads produits par fpm
  (« payload read failed », vérifié avec 0.4.1/0.4.2 alors que `rpm -K` les valide).
  Le dépôt apporte quand même l'essentiel : plus de navigateur ni de réinstall manuelle.
- Dépôt non signé (`gpgcheck=0`, usage personnel) — la signature GPG reste une piste.
- Activation côté utilisateur (une fois) :
  ```bash
  sudo curl -o /etc/yum.repos.d/worklogs.repo https://timotheegrollier.github.io/work-logs/rpm/worklogs.repo
  sudo dnf update worklogs
  ```

### AppImage auto (electron-updater, dépendance approuvée)

- `electron-builder.yml` déclare `publish: github` → génère `latest-linux.yml` à
  chaque build. Le `.blockmap` externe (indispensable au delta : sans lui,
  repli silencieux sur le téléchargement complet) est produit par
  `scripts/appimage-blockmap.mjs` (réutilise le module du builder, 7 s, ~130 Ko).
- CI : `desktop:dist` → blockmap → assert `latest-linux.yml` + `*.blockmap` →
  artefact `linux-packages`. La release les uploade et les atteste avec le reste.
- `desktop/main.mjs` (AppImage packagée uniquement) : `checkForUpdates` à
  l'ouverture → dialogue « Mettre à jour » → `downloadUpdate` (différentiel) →
  dialogue « Redémarrer » → `quitAndInstall`. Échec → repli sur le dialogue
  classique. Contournements ESM documentés dans le code (electron-builder#7976).
- `stage-desktop.mjs` fusionne `electron-updater` + fermeture transitive depuis le
  lock racine (flat ou niché selon les versions, comme npm) — `verify-package.mjs`
  exige `/node_modules/electron-updater/package.json` dans l'asar (garde-fou
  ajouté après l'incident `update.mjs` manquant de la 0.3.0).

## 8. Pièges connus (vécus, ne pas réintroduire)

- **Events stériles de GITHUB_TOKEN** : une release créée/publiée avec GITHUB_TOKEN
  ne redéclenche AUCUN workflow (anti-boucle GitHub). `rpm-repo.yml` écoute donc la
  fin de « Release Linux » (`workflow_run` + garde-fou : conclusion success, tag `v*`,
  release non-brouillon avec RPM), jamais `release: published/released`.
- **Polling update** (`desktop/update.mjs` + `main.mjs`, depuis la 0.6.0 ; toutes les
  5 min depuis la 0.6.4) : `startPoll`
  sans chevauchement, mémoire du refus (`dismissedVersion`), garde `systemUpdating`.
- **Cache PackageKit menteur** (vécu deux fois) : prouvé en conteneur Fedora que
  `get-updates`, même avec `--cache-age 1`, relit un cache périmé — seul
  `pkcon refresh force` recharge vraiment. Le pré-vol fait donc refresh puis
  `get-updates`, et `parsePkconCandidate` lit le vrai format texte
  (`worklogs-0.6.8-1.x86_64 (wl)`, pas des `;`) : sans candidat exact, aucune
  installation. Le redémarrage n'est proposé qu'après `rpm -q == attendu`
  (`installedMatches`, testé) — sinon erreur explicite, jamais de faux succès.

- **`pkcon get-updates` sort en 5 quand il n'y a rien à installer** (« nothing useful
  was done »), pas en 0. Le pré-vol traitait tout code non nul comme « interrogation
  impossible » **et sautait sa propre garde**, puis tentait quand même l'installation :
  c'est ce qui cassait Mint. `pkconProbeOutcome` décide désormais ready/none/mismatch,
  et « none » bascule sur le repli manuel. Ne jamais revenir à un test sur le seul code
  de sortie.
- **Le format de `get-updates` diffère selon la dorsale** — relevé en conteneur :
  dnf `worklogs-0.6.8-1.x86_64 (wl)`, apt `worklogs-0.6.13.amd64 (worklogs-stable-)`.
  L'expression d'origine exigeait la révision `-1` et ne trouvait donc jamais rien sur
  Debian. Toute évolution du parseur doit couvrir les deux formats (tests dédiés).
- **Rétention des dépôts** : sans purge, gh-pages avait atteint **1,3 Go** (16 RPM jamais
  supprimés), au-delà de la limite d'1 Go d'un site GitHub Pages. `prune-repo.mjs` garde
  les 3 dernières versions ; son tri est en semver, pas en texte (sinon `0.6.9` passerait
  après `0.6.10` et la purge supprimerait la mauvaise).
- **Liste fermée de `stage-desktop.mjs`** : tout nouveau fichier sous `desktop/` doit y
  être ajouté, sinon l'app installée plante à l'import (fenêtres jamais ouvertes,
  timeouts `firstWindow` dans les 3 jobs paquets — vu sur la 0.3.0).
- **Express 5** : casse le téléchargement des pièces jointes (test e2e `worklogs.spec.ts:134`
  en timeout). Rester en Express 4 jusqu'à un lot de migration dédié.
- **Test brouillon** (`App.test.tsx:139`) : affirmer via `waitFor`, jamais sur le premier
  rendu — l'éditeur recharge via HTTP, le test est sinon dépendant du timing (rouge en CI,
  vert en local).
- **DEB en gzip, pas xz** : xz prend plusieurs minutes sur 280 Mo de payload (choix vitesse
  assumé ; 97 % du poids est le runtime Electron, pas notre code — 2,3 Mo d'asar).
- **`WORKLOGS_SKIP_UPDATE_CHECK=1`** dans les e2e : l'app packagée ne doit jamais toucher
  le réseau pendant la recette.
- **Icônes** : `desktop/icon.svg` est la source ; PNG 16→512 px générés en local
  (ImageMagick + RSVG) et committés — la CI n'a besoin d'aucun outil graphique.
  `desktop/icon.png` (512) reste pour l'icône de fenêtre (`main.mjs` + stage + asar).
- **Dépendances** : zéro ajout npm sans accord explicite (Electron 44.3.0 et
  electron-builder 26.15.3 approuvés). Les bumps dependabot se mergent après CI verte ;
  fermer avec un commentaire motivé si incompatibilité réelle (cf. Express 5).
