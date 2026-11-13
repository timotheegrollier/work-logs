# Desktop Linux et CI/CD — référence du pipeline

Dernière mise à jour : **2026-11-12**. Ce document décrit ce qui existe : la chaîne, les cinq
workflows, leurs durées mesurées, ce qui est publié et où, les secrets, le packaging desktop et
les défauts connus. Pour **publier**, suivre [07-RELEASES.md](07-RELEASES.md) : le pas à pas, les
vérifications et les remèdes sont là-bas, pas ici.

Au 2026-11-12, `gh release list -L 200` compte 98 releases, de `v0.2.0` à `v0.75.0`, publiée à
12:03 UTC (sans `-L`, la commande n'en affiche que 30). **`gh release list` fait foi.** Les faits ci-dessous
viennent du code de `8e345d0` et de lectures seules sur GitHub, le 2026-11-10 puis le 2026-11-12.
Les dossiers `.github/` et `scripts/` sont identiques entre `e3e2d10` (v0.74.0) et `8e345d0`
(v0.75.0).

Les sections §9 à §11 gardent les bugs réels et les pièges vécus du desktop : ne pas les
réintroduire.

## 1. La chaîne

```
push d'une branche ──► CI Linux
pull request ────────► CI Linux (second run, en plus de celui du push)
push sur master ─────► CI Linux
                  ├──► PWA (chemins filtrés) ─────────► GitHub Pages, par artefact
                  └──► PWA Cloudflare (chemins filtrés) ► Worker worklogs-google (le téléphone)
tag vX.Y.Z ──────────► Release Linux : precheck ── CI verte sur master pour ce commit ?
                                          ├─ oui ─► release ──────────────► GitHub Release
                                          └─ non ─► validate (ci.yml) ─► release
fin de « Release Linux » ─► Dépôts ─► branche gh-pages (rpm/, deb/), lue par raw.githubusercontent.com
release publiée ─► relais de la VM (minuteur de 5 min) · applications desktop (releases/latest)
```

Trois conséquences :
- La PWA suit le push sur master, pas le tag. Le 2026-11-10 à 16:39, Pages et Cloudflare
  servaient déjà `0.74.0` alors que la dernière release était `v0.73.0`.
- La PWA n'attend pas la CI. Le 2026-11-12, `db6e5d6` était en ligne sur la PWA à 09:58, et sa
  CI a échoué à 10:09 (D6).
- Seule une CI verte **sur master** ouvre le chemin rapide du tag. Une CI verte sur une branche
  ou une PR ne suffit pas (`release.yml:45-47`).

## 2. Les workflows

| Fichier | Nom sur GitHub | Déclencheurs | Jobs | Concurrence | Publie |
|---|---|---|---|---|---|
| `.github/workflows/ci.yml` | CI Linux | `push` sur toute branche, `pull_request`, `workflow_call` (entrée `ref`) | `validate`, puis `packages` × 3 | `ci-<workflow>-<ref>` ; un nouveau push annule le run en cours de la même ref, sauf sur un tag | rien (artefact `linux-packages`) |
| `.github/workflows/release.yml` | Release Linux | `push` d'un tag `v*`, `workflow_dispatch` (entrée `tag`) | `precheck`, `validate` si besoin, `release` | `release-<tag>`, sans annulation | GitHub Release |
| `.github/workflows/repos.yml` | Dépôts | `workflow_run` à la fin de « Release Linux », `workflow_dispatch` (entrée `tag`) | `repos` | `gh-pages`, sans annulation | `gh-pages/rpm/`, `gh-pages/deb/` |
| `.github/workflows/pwa.yml` | PWA | `push` sur master filtré par chemins, `workflow_dispatch` | `deploy` | `pages`, sans annulation | GitHub Pages |
| `.github/workflows/pwa-cloudflare.yml` | PWA Cloudflare | `push` sur master filtré par chemins, `workflow_dispatch` (entrée `force`, lue par aucune étape : D10) | `deploy-cloudflare` | `pwa-cloudflare`, sans annulation | Worker `worklogs-google` |

Les deux PWA partent sur `web/**`, `scripts/emit-sw.mjs`, `package.json`, `package-lock.json` et
leur propre fichier de workflow. `scripts/pwa-sw.mjs` ne déclenche que Pages (D7), et
`oauth-proxy/**` que Cloudflare. Le commit de version modifie `package.json` : il redéploie
toujours les deux PWA.

Deux workflows existent côté GitHub sans fichier dans `.github/workflows/`. `Dependabot Updates`
suit `.github/dependabot.yml` : chaque mois, les actions GitHub de la racine et npm sur `/`,
`/api` et `/web`, cinq PR ouvertes au plus. `pages-build-deployment` reste listé, mais ne tourne
plus depuis que Pages publie par artefact (dernier run le 2026-11-10 à 11:28).

### 2.1 CI Linux (`ci.yml`)

Le job `validate` (« Types, tests, paquets et installation ») tourne sur `ubuntu-22.04`, 25 min
au plus, avec `WORKLOGS_TEST_NO_SANDBOX=1`. Ses étapes, dans l'ordre :
1. checkout de `inputs.ref` (vide hors appel) ; Node de `.nvmrc` (24.20.0) ; cache npm des trois
   lockfiles ;
2. `npm ci && npm --prefix api ci && npm --prefix web ci` ;
3. cache de `~/.cache/ms-playwright`, `~/.cache/electron` et `~/.cache/electron-builder`, clé
   calculée sur `package-lock.json` ;
4. `npx playwright install --with-deps chromium`, puis
   `sudo apt-get update && sudo apt-get install -y xvfb rpm` ;
5. `./scripts/check.sh` (§6) ;
6. `node scripts/check-release.mjs`, avec le tag en argument quand la ref en est un ;
7. `npm run desktop:dist`, qui refait le build web puis lance
   `electron-builder --linux --x64 --publish never` ;
8. `node scripts/verify-package.mjs` ;
9. `node scripts/appimage-blockmap.mjs`, puis présence de `release/latest-linux.yml` et d'un
   `.blockmap` ;
10. envoi de l'artefact `linux-packages`, et de `test-reports` (`test-results/`,
    `playwright-report/`) en cas d'échec.

Le job `packages` (« Installation et lancement — `<distribution>` ») attend `validate`. Il tourne
sur `ubuntu-24.04`, 25 min au plus, sans `fail-fast`. Sa matrice : `mint-22-base` (image
`ubuntu:24.04`, deb), `fedora-43` et `fedora-44` (rpm). Chaque job télécharge `linux-packages` et
lance `./scripts/test-linux-package.sh <image> <format>`. Le script installe le vrai paquet dans
un conteneur jetable, joue les 19 tests Electron sur `/opt/WorkLogs/worklogs`, puis les rejoue sur
l'AppImage extraite. Le test « démarre en fenêtre maximisée » est sauté faute de gestionnaire de
fenêtres : chaque passage compte 18 réussites et 1 test sauté. L'AppImage est testée extraite
(`--appimage-extract`) : son montage FUSE n'est jamais exercé.

La CI ne lit que deux secrets, `GOOGLE_DESKTOP_CLIENT_ID` et `GOOGLE_DESKTOP_CLIENT_SECRET`, et à
la seule étape `desktop:dist`. Sans eux (fork, par exemple), le paquet demande une configuration
Google manuelle.

Une PR lance deux runs pour le même commit, un par événement, dans deux groupes de concurrence.
Un nouveau push sur master annule la CI de master en cours : les runs 42207180075, 42039922946 et
42042480562 ont fini ainsi, en `cancelled`.

### 2.2 Release Linux (`release.yml`)

- `precheck` (« Commit déjà validé ? ») : 5 min au plus, sans checkout. Il lit le SHA du tag
  (`git/matching-refs/tags/<tag>`, champ `object.sha`). Il cherche ensuite un run « CI Linux » de
  ce SHA, en `success`, dont la branche est `master`. Ses sorties : `skip`, `run-id`, `sha`.
- `validate` : seulement si `skip` ne vaut pas `true`. Il appelle `ci.yml` avec le tag pour `ref`
  et `secrets: inherit` : tests, paquets et trois installations.
- `release` (« Attester et publier les trois paquets ») : seulement si `precheck` a réussi, et si
  `skip` vaut `true` ou si `validate` a réussi. 10 min au plus, permissions `contents: write`,
  `id-token: write`, `attestations: write` et `actions: read`. Ses étapes : checkout du tag en
  `fetch-depth: 0` ; `node scripts/check-release.mjs "$TAG"` ; paquets du run courant (chemin
  plein) ou `gh run download <run-id> -n linux-packages -D release` (chemin rapide) ;
  `SHA256SUMS` ; attestation de provenance du `.deb`, du `.rpm`, de l'AppImage, du `.blockmap` et
  de `latest-linux.yml` ; notes par `scripts/release-notes.mjs` ; brouillon créé avec
  `--verify-tag` s'il n'existe pas, refus si la release est déjà publiée ; envoi des six fichiers
  en `--clobber` ; publication `--draft=false --latest`, sur un `push` seulement
  (`--prerelease --latest=false` si le tag contient `-`).

Un `workflow_dispatch` s'arrête donc au brouillon. Sa fin déclenche quand même « Dépôts » (D1).
Sur un tag dont la release est déjà publiée, il échoue sur « Une release publiée ne doit pas être
remplacée. » (lecture du code, non exécuté). Un brouillon existant est repris tel quel : ses
notes ne sont pas régénérées.

Les trente dernières releases mesurées ont pris le chemin rapide. Le dernier chemin plein date de
la `v0.43.0`, le 2026-10-05 : 11,2 min (run 37289678916).

### 2.3 Dépôts (`repos.yml`)

Le job `repos` tourne si le run déclencheur a réussi, ou sur un dispatch. Il a 35 min au plus.
`TAG` vaut `github.event.workflow_run.head_branch` (le nom du tag poussé) ou l'entrée `tag`.
`PAGES` vaut `https://raw.githubusercontent.com/timotheegrollier/work-logs/gh-pages`. Ses étapes :
1. checkout de master en `fetch-depth: 0`, pas du tag ;
2. garde-fou « release vraiment publiée » : il affiche toujours « arrêt » et n'arrête rien (D1) ;
3. clone de `gh-pages` (profondeur 1) dans `.pages`, puis `gh release download` du `.rpm` et du
   `.deb` du tag ;
4. garde-fou des 100 Mo sur les `.deb` (D4) ;
5. rétention : `scripts/prune-repo.mjs` avec `KEEP: 1`, une seule version par dépôt depuis
   `4b5e3c5` (2026-11-10) ;
6. index : `repodata/` refait de zéro, `scripts/build-rpm-repo.sh`, `scripts/build-deb-repo.sh`,
   puis `worklogs.repo` (`gpgcheck=0`) et `worklogs.list` (`[trusted=yes]`) ;
7. test dnf dans `fedora:44`, puis test apt dans `ubuntu:24.04`, sur le dépôt local ; avec une
   seule version gardée, chacun installe au lieu de mettre à niveau (D3) ;
8. commit `depots: <tag> (dnf + apt, <KEEP> versions gardées)` et push sur `gh-pages` ;
9. `node scripts/verify-repo.mjs "$TAG" "$PAGES"` : 10 min au plus, un essai toutes les 15 s ;
10. échec explicite si le dépôt apt a été sauté.

Seul `github.token` sert. « Dépôts » démarre 2 à 4 s après la fin de « Release Linux ».

### 2.4 PWA (`pwa.yml`) et PWA Cloudflare (`pwa-cloudflare.yml`)

Les deux construisent `web/` avec `VITE_PWA=1`, `VITE_GOOGLE_CLIENT_ID` (variable, sinon secret
`GOOGLE_WEB_CLIENT_ID`) et `VITE_GOOGLE_TOKEN_PROXY` (variable `GOOGLE_TOKEN_PROXY_URL`). Le build
émet `sw.js` à la version de `package.json` racine.
- PWA : `configure-pages@v5`, `upload-pages-artifact@v3` sur `web/dist`, puis `deploy-pages@v4`,
  dans l'environnement `github-pages` (branches autorisées : `master` et `gh-pages`). Ces trois
  actions sont référencées par tag ; toutes les autres actions du pipeline sont épinglées par SHA.
- PWA Cloudflare : refus explicite si `CLOUDFLARE_API_TOKEN` ou `CLOUDFLARE_ACCOUNT_ID` manque ;
  `wrangler` à la version du lockfile racine (4.156.0) ;
  `cd oauth-proxy && npx --yes "wrangler@$WRANGLER" deploy`. Le Worker sert `../web/dist` en
  assets, et `/token` passe par le Worker avant les assets (`oauth-proxy/wrangler.toml`).

## 3. Durées mesurées

Durée d'un run : fin moins création, attente de runner comprise. Trente derniers runs de chaque
workflow, relevés le 2026-11-10 :

| Workflow | Événement | Runs verts | Médiane | Min – max |
|---|---|---|---|---|
| CI Linux | push de branche | 9 | 13,8 min | 11,4 – 15,6 |
| CI Linux | push sur master | 11 | 14,0 min | 12,4 – 15,4 |
| CI Linux | pull_request | 3 | 14,7 min | 14,5 – 15,1 |
| Release Linux | tag, chemin rapide | 30 | 2,7 min | 2,0 – 9,1 |
| Dépôts | workflow_run | 24 | 4,9 min | 3,6 – 17,6 |
| Dépôts | workflow_dispatch | 4 | 6,1 min | 5,5 – 10,0 |
| PWA | push sur master | 26 | 0,7 min | 0,5 – 3,0 |
| PWA Cloudflare | push sur master | 26 | 0,6 min | 0,5 – 0,9 |

Par job, en médiane sur les runs verts : `validate` 10,8 min (8,6 – 12,5) ; chaque job `packages`
2,6 à 2,8 min (2,3 – 5,1) ; `precheck` 4 s ; `release` 2,4 min (1,7 – 8,8) ; `repos` 4,9 min
(3,5 – 17,5). Par étape, en médiane : `check.sh` 390 s, `desktop:dist` 184 s, test d'un paquet
139 à 142 s. Le checkout en `fetch-depth: 0` prend 114 s dans `release` (74 – 494) et 113 s dans
`repos` (80 – 868). `verify-repo` prend 7 s.

Du tag à la fin de « Dépôts », sur les quinze releases `v0.59.0` à `v0.73.0` : 7,4 min en médiane
(6,2 – 26,7), mesures antérieures au passage des dépôts en raw. Le chemin plein n'a pas été
mesuré depuis la `v0.43.0`. La somme des médianes
actuelles donne environ 16 min : c'est une estimation, pas une mesure.

Publication de la v0.74.0, le 2026-11-10 (heures UTC) :

| Étape | Run | Début → fin | Durée |
|---|---|---|---|
| CI de la branche | 42852749513 | 16:15:45 → 16:29:29 | 13,7 min |
| CI de master, même commit | 42855202592 | 16:30:26 → 16:51:00 | 20,6 min |
| PWA et PWA Cloudflare | 42855202880, 42855202615 | 16:30:26 → 16:31:04 | moins d'une minute |
| Release Linux, chemin rapide | 42858904711 | 16:51:50 → 16:57:39 | 5,8 min |
| Dépôts | 42859929288 | 16:57:43 → 17:02:27 | 4,7 min |

La CI de master a duré 20,6 min parce que son job `mint-22-base` a pris 11,6 min. Dans son
conteneur, le téléchargement des paquets Ubuntu s'est arrêté 267 s entre deux fichiers, puis
91 s. Le job `release` a passé 299 s de ses 338 s au checkout (D8). `verify-repo` a réussi au
premier essai, en 5 s. De la poussée de la branche aux dépôts vérifiés, la v0.74.0 a pris
47 minutes.

Publication de la v0.75.0 (`8e345d0`), le 2026-11-12 (heures UTC) : CI de la branche 11:34:00 →
11:45:40 (run 43210249477, 11,7 min) ; CI de master 11:46:12 → 12:00:19 (run 43211980667,
14,1 min) ; PWA et PWA Cloudflare 11:46:12 → 11:46:46 ; Release Linux, chemin rapide, 12:00:58 →
12:03:42 (run 43214088962, 2,7 min, dont 130 s de checkout) ; Dépôts 12:03:45 → 12:07:51 (run
43214501102, 4,1 min, `verify-repo` au premier essai, en 3 s). De la poussée de la branche aux
dépôts vérifiés : 34 minutes.

## 4. Ce qui est publié, et où

| Où | Quoi | Écrit par | Lu par |
|---|---|---|---|
| GitHub Release `vX.Y.Z` | `.deb`, `.rpm`, `.AppImage`, `.AppImage.blockmap`, `latest-linux.yml`, `SHA256SUMS` ; l'attestation des cinq premiers n'est pas un fichier de la release : elle est rangée dans les attestations du dépôt, retrouvée par l'empreinte du fichier (`gh api repos/timotheegrollier/work-logs/attestations/sha256:<empreinte>`) | Release Linux | téléchargement manuel ; electron-updater (AppImage) ; applications desktop et relais, par `releases/latest` |
| branche `gh-pages`, dossier `rpm/` | le `.rpm` de la dernière version, `repodata/`, `worklogs.repo` | Dépôts | dnf |
| branche `gh-pages`, dossier `deb/` | le `.deb` de la dernière version, `Packages`, `Packages.gz`, `Release`, `worklogs.list` | Dépôts | apt |
| `https://timotheegrollier.github.io/work-logs/` | la PWA | PWA | miroir de la PWA |
| `https://worklogs-google.cocodexcocoder.workers.dev/` | la PWA à `/`, le relais de jetons Google à `/token` | PWA Cloudflare | le téléphone |
| VM du relais | le relais du dossier partagé | son minuteur, à partir de la release ([09-RELAIS.md](09-RELAIS.md)) | la PWA, par Tailscale |

Depuis `5ae1a21` (2026-11-10), les dépôts sont servis par
`https://raw.githubusercontent.com/timotheegrollier/work-logs/gh-pages/{rpm,deb}`, avec
`cache-control: max-age=300`. GitHub Pages ne les sert plus :
`https://timotheegrollier.github.io/work-logs/deb/Packages` répond 404 (D2). La racine de
`gh-pages` garde des fichiers de l'ancienne PWA (`index.html`, `sw.js`, `assets/`…). Ils ne sont
plus mis à jour, et Pages ne les sert plus.

Paquets de la v0.74.0 : `.deb` 98 223 364 octets (93,7 Mio, xz), `.rpm` 88 064 981 octets
(84,0 Mio, xz), `.AppImage` 124 252 387 octets (118,5 Mio), `.blockmap` 131 457 octets. Le `.deb`
garde 6 634 236 octets de marge sous la limite de 100 Mio d'un fichier git (D4).

Artefacts d'Actions : `linux-packages` (14 jours, 310 145 729 octets mesurés le 2026-11-10),
`test-reports` et `package-reports-<distribution>` (14 jours, en cas d'échec), `github-pages`
(1 jour). La rétention par défaut du dépôt est de 90 jours.

## 5. Secrets, variables et réglages du dépôt

Noms seulement, relevés le 2026-11-12 :

| Nom | Nature | Utilisé par |
|---|---|---|
| `GOOGLE_DESKTOP_CLIENT_ID`, `GOOGLE_DESKTOP_CLIENT_SECRET` | secrets | CI Linux, étape `desktop:dist` ; aussi le `validate` du chemin plein (`secrets: inherit`) |
| `GOOGLE_WEB_CLIENT_ID` | secret (une variable du même nom passerait avant) | PWA, PWA Cloudflare |
| `GOOGLE_TOKEN_PROXY_URL` | variable | PWA, PWA Cloudflare |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secrets | PWA Cloudflare |
| `GITHUB_TOKEN` | jeton automatique d'Actions | Release Linux, Dépôts |
| `GOOGLE_CLIENT_SECRET` | secret du Worker Cloudflare, hors GitHub | relais de jetons (`/token`) |

Réglages lus le 2026-11-12 : dépôt public, branche par défaut `master`. **`master` n'est pas
protégée** : l'API répond « Branch not protected », et aucun ruleset n'existe. **L'auto-merge est
désactivé** (`allow_auto_merge: false`). Les fusions par commit, rebase et squash sont permises.
Rien sur GitHub n'empêche donc une poussée directe sur master. Seul le chemin de
[07-RELEASES.md](07-RELEASES.md) §3 protège master, et la PWA qui en part.

Réglages lus le 2026-11-10 : permissions par défaut des workflows en lecture, actions de toute
origine autorisées, épinglage par SHA non exigé. Pages publie en `build_type: workflow`. Son
`status: errored` vient du dernier build de branche, antérieur au passage en artefact : le site
répond normalement.

## 6. Scripts du pipeline

| Script | Rôle | Appelé par |
|---|---|---|
| `scripts/check.sh` | types (web, desktop), tests API, front, desktop unitaires, scripts, Worker, relais, build, Playwright, Electron ; finit par « CHECK OK — tout est vert. » | CI `validate`, poste |
| `scripts/check-release.mjs` | version `X.Y.Z` ou `X.Y.Z-(alpha\|beta\|rc).N`, tag égal à `v<version>`, `package-lock.json` aligné à ses deux endroits | CI, job `release`, poste |
| `scripts/stage-desktop.mjs` | prépare `.desktop-app/` : liste fermée de fichiers, garde-fou des imports de `desktop/`, client Google intégré si les secrets sont là, `npm ci --omit=dev --ignore-scripts` | `npm run desktop:dist` |
| `scripts/verify-package.mjs` | lit l'ASAR : refuse `api/data`, `.env`, `.git`, `.db`, `.sqlite`, exige 8 fichiers, compare la version à `package.json` | CI |
| `scripts/appimage-blockmap.mjs` | produit le `.blockmap` externe de l'AppImage avec le module d'electron-builder | CI |
| `scripts/test-linux-package.sh` | `docker run` jetable : installe le paquet, lance Xvfb, joue `npm run test:desktop` sur l'installé puis sur l'AppImage extraite | job `packages`, poste |
| `scripts/build-rpm-repo.sh` | `createrepo_c --update`, sans delta RPM ; `repos.yml` supprime `repodata/` juste avant, donc `--update` ne réutilise rien | Dépôts |
| `scripts/build-deb-repo.sh` | dépôt apt plat : `Packages`, `Packages.gz`, `Release` | Dépôts |
| `scripts/prune-repo.mjs` | garde les N dernières versions, en tri semver ; garde tout fichier sans version ; N vaut 3 par défaut, `repos.yml` passe 1 | Dépôts |
| `scripts/verify-repo.mjs` | vérifie à l'adresse publique les index, leurs empreintes et les deux paquets, 10 min au plus | Dépôts, poste |
| `scripts/release-notes.mjs` | notes en anglais depuis `git log PREV..TAG --no-merges` | job `release`, poste |
| `scripts/emit-sw.mjs`, `scripts/pwa-sw.mjs` | `sw.js` versionné comme `package.json`, précache de tout le build ; version `X.Y.Z` stricte | `npm --prefix web run build` |
| `scripts/workflows.test.mjs` | tests statiques de `pwa-cloudflare.yml` et de `repos.yml` seulement (D15) | `check.sh` |

`check.sh` prend un écran virtuel avec metacity ou muffin s'ils sont installés, sinon l'écran
courant, sinon `xvfb-run -a`. Le 2026-11-13, après la v0.75.0, il a compté 329 tests API,
1 372 tests front (dont un échec attendu, `web/src/test/setup.test.tsx`), 49 desktop unitaires,
49 scripts, 8 Worker, 11 relais, 117 navigateur et 20 Electron, soit 1 954 tests. Vitest tourne avec
`maxWorkers: 4` et `retry: 1` (`web/vite.config.ts`).

## 7. Packaging desktop

- `electron-builder.yml` lit l'application dans `.desktop-app/` et écrit dans `release/`. Les
  cibles sont deb, rpm et AppImage, en x64, nommées `WorkLogs-${version}-linux-${arch}.${ext}`.
- deb et rpm sont compressés en xz. En gzip, le `.deb` pesait 116 Mo, au-delà de ce que git
  accepte ; le passage en xz date de `c894205` (2026-09-14).
- Le deb dépend de `'libasound2t64 | libasound2'`, pas de `libasound2` seul (§9.5).
- L'AppImage déclare `executableArgs: []`, ce qui retire le `--no-sandbox` qu'electron-builder
  ajoute par défaut.
- `publish: github` produit `latest-linux.yml` pour electron-updater. La CI construit en
  `--publish never` : c'est `release.yml` qui envoie les fichiers.
- `.desktop-app/` contient `api/src`, `api/package.json`, `web/dist`, une liste fermée de
  `desktop/` (`main.mjs`, `preload.cjs`, `server.mjs`, `update.mjs`, `google.mjs`,
  `google-view.mjs`, `open-file.mjs`, `shared-mount.mjs`, `icon.png`), le client Google intégré
  s'il existe, et les dépendances de l'API plus `electron-updater`. Un module de `desktop/`
  importé mais absent de la liste arrête le build (garde-fou de `scripts/stage-desktop.mjs`).
- `desktop/icon.svg` est la source des icônes. Les PNG de 16 à 512 px sont générés en local et
  committés dans `desktop/icons/` : la CI n'a besoin d'aucun outil graphique.
- Versions dans `package-lock.json` au 2026-11-12 : Electron 44.4.5, electron-builder 26.18.0,
  electron-updater 6.8.11, wrangler 4.156.0.

Les fichiers du desktop, en une ligne chacun (l'architecture est décrite dans
[01-ARCHITECTURE.md](01-ARCHITECTURE.md)) :

| Fichier | Rôle |
|---|---|
| `desktop/main.mjs` | fenêtre, instance unique, protocole `worklogs://app`, liens externes, impression, arrêt, nom des téléchargements (§9.2), mises à jour |
| `desktop/preload.cjs` | pont `window.worklogsDesktop`, sans accès Node ni IPC général |
| `desktop/server.mjs` | l'API Express et SQLite sur 127.0.0.1, port éphémère, jeton |
| `desktop/update.mjs` | format installé, pré-vol PackageKit, commande `pkexec`, décisions de mise à jour |
| `desktop/google.mjs`, `desktop/google-view.mjs` | connexion Google, vue Google intégrée (`WebContentsView`) |
| `desktop/open-file.mjs`, `desktop/shared-mount.mjs` | « Ouvrir avec… », montage du dossier partagé |
| `desktop/test/*.test.mjs` | 49 tests unitaires (`npm run test:desktop:unit`) |
| `desktop/e2e/desktop.spec.ts` | 19 parcours Electron (`npm run test:desktop`) |

## 8. Défauts connus du pipeline

Relevés le 2026-11-10, revérifiés le 2026-11-12 sur le code de `8e345d0`. Aucun n'est corrigé ici.
Chaque défaut donne son effet pour qui publie, puis la conduite à tenir en attendant sa
correction.

**D1. Le garde-fou de « Dépôts » n'arrête rien** (`repos.yml:52-59`). `--jq -e` fait échouer
`gh release view` (« accepts at most 1 arg(s), received 2 »). `exit 0` ne termine que l'étape, pas
le job. Chaque run affiche donc « pas de .rpm dans vX.Y.Z, arrêt », puis publie : c'était encore
le cas pour la v0.74.0. Un brouillon, ou une ref qui n'est pas un tag, ne serait pas arrêté non
plus. Après un dispatch de « Release Linux » lancé depuis master, `TAG` vaudrait `master`, la
branche de ce run : le garde-fou le laisserait passer, mais l'étape suivante échouerait sur
`gh release download master` (« release not found »), sans rien publier. Aucun de ces cas n'a été observé : `repos.yml` n'existait pas lors des deux
seuls dispatchs (2026-09-11).
*Effet :* ce message n'indique aucune panne, et rien ne protège les dépôts d'un run déclenché à
tort. *En attendant :* ignorer ce message ; ne pas lancer « Release Linux » en
`workflow_dispatch` ; avant un dispatch de « Dépôts », vérifier que la release est publiée
(`gh release view vX.Y.Z --json isDraft`).

**D2. Les postes activés avant le 2026-11-10 ne reçoivent plus rien** (`5ae1a21`,
`repos.yml:46`, `desktop/update.mjs:14-15`). Leur `worklogs.list` ou `worklogs.repo` vise
`https://timotheegrollier.github.io/work-logs/`, qui répond 404 depuis le passage en artefact.
Aucune migration automatique n'existe. *Effet :* apt et dnf restent sur l'ancienne version ; le
poste du propriétaire est resté en 0.73.0 jusqu'au remède du 2026-11-12. *En attendant :* remède
une fois par poste, en tête de [07-RELEASES.md](07-RELEASES.md) ; symptôme et preuve au §7.4 de
ce même document. Aucune mise à jour ne peut corriger un poste seule.

**D3. Le test de mise à niveau est devenu une simple installation** (`repos.yml:34,123,143`).
Avec `KEEP: 1`, la version précédente n'est plus dans le dépôt de test. L'installation de
`PREV` échoue en silence (`2>/dev/null`), et le script passe à une installation directe.
*Effet :* une régression de mise à niveau (scripts du paquet, conflit de fichiers) n'est plus
vue par la CI ; le run de la v0.74.0 ne journalise que « Installing worklogs-0:0.74.0 ». *En
attendant :* vérifier la mise à niveau sur un vrai poste après chaque release (07 §5).

**D4. Un `.deb` de plus de 100 Mo supprimerait le dernier `.deb` publié**
(`repos.yml:83-86,106,156`). Le garde-fou efface tous les `.deb` du clone, y compris celui déjà
publié. `git add -A rpm deb` retire alors ce fichier de `gh-pages`, alors que l'index apt reste
celui de la version précédente. Lecture du code, non observé depuis le passage en xz. *Effet :*
les postes apt ne verraient plus de mise à jour, et une nouvelle installation prendrait une 404.
*En attendant :* lire la taille du `.deb` dans la CI de branche ou dans la release
(`gh release view vX.Y.Z --json assets`) ; la marge était de 6 634 236 octets sur la v0.74.0.

**D5. Les pré-releases sont inatteignables** (`scripts/check-release.mjs:4`,
`release.yml:123-124`, `scripts/pwa-sw.mjs:5`, `scripts/release-notes.mjs:98`,
`scripts/verify-repo.mjs:116`). `check-release.mjs` accepte `X.Y.Z-rc.N`, et `release.yml` prévoit
`--prerelease`. Le build web, les notes et `verify-repo` refusent pourtant ces versions.
L'application desktop les ignore aussi (`parseVersion` de `desktop/update.mjs`). *Effet :* un
tag `vX.Y.Z-rc.N` échouerait dans la CI. *En attendant :* ne publier que des versions `X.Y.Z`.

**D6. Les deux PWA publient sans attendre la CI** (`pwa.yml:6-18`, `pwa-cloudflare.yml:8-21`).
*Effet :* le téléphone reçoit chaque push sur master qui touche ses chemins, même si la CI échoue
ensuite. `895378c` et `712d53a` ont été publiés avec une CI rouge. Le 2026-11-12, `db6e5d6` était
en ligne à 09:58, onze minutes avant l'échec de sa CI (une instabilité, cette fois). *En
attendant :* ne jamais pousser sur master un commit dont la CI de branche n'est pas verte
(07 §3).

**D7. Un changement de `scripts/pwa-sw.mjs` redéploie Pages, pas Cloudflare**
(`pwa.yml:11`, `pwa-cloudflare.yml:11-20`). `emit-sw.mjs` importe pourtant `pwa-sw.mjs`. *Effet :*
ce changement seul n'atteint pas le téléphone. *En attendant :* lancer « PWA Cloudflare » à la
main après un tel changement (`gh workflow run pwa-cloudflare.yml`).

**D8. `fetch-depth: 0` télécharge l'historique binaire de `gh-pages`** (`release.yml:73,86`,
`repos.yml:50`). Ce réglage récupère toutes les branches, et `gh-pages` porte les paquets de
toutes les versions dans son historique. Le réglage n'est pas superflu pour autant : sans
l'historique ni les tags, `scripts/release-notes.mjs` ne trouve pas `PREV`, et la note se réduit en
silence au commit de version, avec un lien `compare/...vX.Y.Z` cassé. Une correction doit écarter
`gh-pages`, pas l'historique de master ni les tags. *Effet :* le checkout fait l'essentiel du chemin
rapide : 299 s sur les 338 s du job `release` de la v0.74.0, dont le délai est de 10 min ; 122 s
dans « Dépôts ». *En attendant :* compter 5 à 6 min du tag à la release publiée. Si le job
`release` expire au checkout, le relancer par `gh run rerun <id> --failed` (cas non observé).

**D9. `precheck` ne vérifie pas que l'artefact existe encore** (`release.yml:45-51,98`,
`ci.yml:85`). L'artefact `linux-packages` vit 14 jours. Lecture du code, non observé. *Effet :*
un tag posé plus de 14 jours après la CI verte de master échouerait au téléchargement, au lieu de
reconstruire. *En attendant :* taguer peu après la CI verte de master ; passé 14 jours, poser un
tag annoté (`git tag -a`), qui force le chemin plein (vécu avec la v0.13.0, 07 §4), ou taguer un
commit plus récent de master, après sa propre CI verte.

**D10. L'entrée `force` de « PWA Cloudflare » n'est lue par aucune étape**
(`pwa-cloudflare.yml:22-26`). *Effet :* aucun ; un dispatch reconstruit et redéploie toujours.
*En attendant :* rien à faire.

**D11. La clause `github.event_name != 'workflow_call'` paraît inopérante** (`ci.yml:18`). Dans
un workflow réutilisé, `github.event_name` reste celui de l'appelant (documentation GitHub ; non
vérifié en exécution). *Effet :* aucun aujourd'hui, car le chemin plein passe une ref de tag, que
la seconde clause protège de l'annulation. *En attendant :* ne pas compter sur cette clause si la
CI réutilisée reçoit un jour une ref de branche.

**D12. Des commentaires du pipeline sont faux.** `release.yml:22-23` annonce « the same
6 minutes » (14,0 min mesurées). `electron-builder.yml:47` annonce « ~87 Mo » (93,7 Mio).
`repos.yml:30-33` justifie `KEEP` par Pages, qui ne lit plus `gh-pages`. `pwa-cloudflare.yml:5-7`
annonce le groupe de concurrence de « Dépôts » et « PWA », alors que `:33-35` en définit un
propre. `desktop/main.mjs:226` parle du « workflow et Pages ». `pwa-cloudflare.yml:31-32`
dit que « PWA » déploie `gh-pages` (les commentaires semblables de `scripts/workflows.test.mjs`,
lignes 22-23 et 48 en `8e345d0`, sont corrigés depuis). `repos.yml:5-6`
annonce que le garde-fou écarte les brouillons (D1). `scripts/appimage-blockmap.mjs:3-5` dit
qu'electron-updater télécharge `{fichier}.blockmap` ; pour une AppImage, `AppImageUpdater` lit le
blockmap embarqué dans l'AppImage (`blockMapSize` de `latest-linux.yml`), jamais le fichier publié
(lecture d'electron-updater 6.8.9, installé ici ; non vérifié en exécution). *Effet :* un lecteur
du code est induit en erreur. *En
attendant :* se fier au code et aux mesures du §3, pas à ces commentaires.

**D13. `apt-get update` n'a pas de nouvelle tentative dans les conteneurs de test**
(`scripts/test-linux-package.sh:18` ; aussi `repos.yml:142`, le test apt de « Dépôts », qui
laisserait alors les dépôts non publiés après la release ; et sur les runners, `ci.yml:49` et
`repos.yml:101` ; lecture du code). *Effet :* un miroir Ubuntu en cours de synchronisation rend
le job `mint-22-base` rouge (run 42806355689 : « Mirror sync in progress? », alors que le même
commit était vert sur master). Un miroir lent allonge aussi ce job sans le faire échouer (v0.74.0,
§3). *En attendant :* lire `gh run view <id> --log-failed` ; si le miroir est en cause,
`gh run rerun <id> --failed`.

**D14. Un test front est instable** (`web/src/App.test.tsx:185`, « un reclassement distant
actualise projet et catégorie… »). Il a échoué dans les runs 40360827503 (2026-10-26) et
42603062893 (2026-11-09). Ces runs n'ont pas été relancés (une seule tentative) ; le même commit
était vert dans la CI `pull_request` lancée en même temps (40360836241, 42603072431). `retry: 1` de vitest, ajouté le
2026-11-10 (`4b5e3c5`), le masque probablement ; non réévalué depuis. Cause trouvée le
2026-11-12, non corrigée : le test dit vrai. Dans `web/src/components/EntryEditor.tsx`,
`autosave.onState` est branché par un `useEffect` passif (l. 272-278). Une frappe arrivée avant ce
branchement laisse l'état à « enregistré » alors qu'une révision attend. L'effet de reclassement
(l. 209-224) saute alors `autosave.update`, et l'envoi suivant réécrit l'ancien projet et
l'ancienne catégorie, comme dans les deux runs (projet `p`, catégorie nulle). Un harnais
déterministe, hors CI, l'a reproduit à chaque passage, et passe quand ce branchement se fait
dans un `useLayoutEffect` (correctif non appliqué). *Effet :* un échec isolé de ce test ne
prouve pas une régression du lot testé : il signale ce défaut existant. *En attendant :*
relancer, et signaler s'il revient.

**D15. Les tests de workflows ne couvrent que deux fichiers sur cinq**
(`scripts/workflows.test.mjs:13-84`). Rien ne teste `ci.yml`, `release.yml`, `pwa.yml`, ni le
garde-fou de « Dépôts ». *Effet :* une erreur dans ces fichiers n'apparaît qu'à l'exécution sur
GitHub. *En attendant :* après toute modification d'un workflow, valider le YAML (07 §6) et suivre
son premier run.

**D16. Le fichier `CNAME` de la racine est invalide et inutilisé.** Il contient un chemin
(`worklogs.github.io/work-logs`), l'API Pages répond `cname: null`, et rien dans `.github/`,
`scripts/` ou `web/public/` ne le lit. *Effet :* aucun. *En attendant :* ne pas s'en servir pour
un domaine.

## 9. Bugs résolus lors du déblocage initial (2026-09-11)

Le lot d'origine s'était arrêté avec `check.sh` rouge : le test Electron du téléchargement
expirait après 30 s sur `page.waitForEvent('download')`. La reprise a **résolu ce blocage et trois
autres bugs découverts en creusant**, puis validé les paquets sur les trois cibles de la CI
(Ubuntu 24.04, Fedora 43, Fedora 44) dans des conteneurs jetables. Machine de reprise :
**Fedora 44**, pas Mint, ce qui a confirmé que la fiche de passation tenait sur une autre machine.

### 9.1 Diagnostic du blocage : une limite de Playwright, pas une panne

Le téléchargement fonctionne réellement côté Electron : `will-download` se déclenche, et le
fichier est écrit avec le bon contenu. Instrumenté directement sur `session.defaultSession`, il se
termine en `done:completed`. Mais **`page.waitForEvent('download')` de Playwright ne se déclenche
jamais** pour une ressource servie par un protocole personnalisé (`worklogs://`) intercepté via
`protocol.handle`. C'est une limite d'intégration Electron/Playwright, pas un défaut applicatif.
`desktop/e2e/desktop.spec.ts` observe donc directement `will-download` au niveau de la session
(fonction `downloadNext`), comme le ferait un test qui ne peut pas piloter la boîte de dialogue
native. Les 4 tests desktop de l'époque passaient alors en 4 s environ, au lieu d'expirer.

### 9.2 Nom de fichier suggéré cassé pour les protocoles personnalisés

En instrumentant `will-download`, `item.getFilename()` renvoyait `"download"` au lieu du vrai nom,
**y compris pour un nom ASCII simple**, dès que le `Content-Disposition` contenait le paramètre
étendu `filename*=UTF-8''...`, pourtant conforme à la RFC 6266. Un script de test isolé
(`session.protocol.handle` et plusieurs en-têtes) a montré qu'Electron ne décode correctement
**ni** `filename*=` **ni** `filename="…"` avec des octets non-ASCII bruts pour un téléchargement
servi par un protocole personnalisé. Le nom retombe sur `"download"` dans les deux cas, alors
qu'un nom ASCII pur fonctionne. `desktop/main.mjs` corrige donc le nom **lui-même** dans un
handler `will-download` : il relit `item.getContentDisposition()`, disponible et correct, puis
appelle `item.setSaveDialogOptions({ defaultPath })` avec le nom décodé. Sans ce correctif, la
boîte de sauvegarde aurait proposé « download » pour **toute** pièce jointe, accentuée ou non.

### 9.3 L'API et les accents (RFC 6266)

Le test `api/test/files.test.js` (« conserve les accents du nom transmis par le navigateur »)
n'avait jamais tourné dans la suite complète. Il attendait `filename*=UTF-8''pi%C3%A8ce` dans le
`Content-Disposition`. `res.download()` d'Express, via le module `content-disposition`, n'émet ce
paramètre étendu **que** si le nom n'est pas représentable en Latin-1, ce qui n'est jamais le cas
des accents français courants. `api/src/app.js` construit donc lui-même l'en-tête
(`attachmentHeader`), avec toujours `filename` (repli ASCII) et `filename*` (UTF-8). C'est une
limite connue de la bibliothèque
([jshttp/content-disposition#27](https://github.com/jshttp/content-disposition/issues/27)), qui
cite les téléchargements Electron comme cas mal couvert.

La conversion latin1 → UTF-8 des noms de fichiers **envoyés** a été vérifiée en même temps.
Busboy ne comprend pas `filename*` en multipart : il ne produit donc jamais un nom déjà décodé
avec des caractères hors Latin-1, et le correctif existant est sûr dans tous les cas réels.

### 9.4 Chemin relatif et `res.sendFile`

Remplacer `res.download(file, filename)` par `res.setHeader(...)` et `res.sendFile(file)` a fait
échouer en 500 le parcours navigateur « joindre un fichier… ». `res.download()` résout le chemin
en absolu avant d'appeler `sendFile`. `res.sendFile()` **exige** un chemin déjà absolu, et lève
sinon `TypeError: path must be absolute or specify root`. `playwright.config.ts` lance l'API des
parcours avec `DATA_DIR=./.e2e-data`, un chemin relatif. Corrigé par
`res.sendFile(path.resolve(file))`.

### 9.5 ALSA sur Ubuntu 24.04 et Mint 22.x : l'application ne démarrait pas

Installé dans un conteneur `ubuntu:24.04` propre (base de `mint-22-base` dans la CI), le `.deb`
**ne démarrait pas du tout** :
```
worklogs: symbol lookup error: worklogs: undefined symbol: snd_device_name_get_hint, version ALSA_0.9
```
Sur Ubuntu 24.04 (transition « t64 »), le paquet virtuel `libasound2` est satisfait par **deux**
paquets concurrents : `libasound2t64`, la vraie bibliothèque ALSA, et `liboss4-salsa-asound2`, une
couche de compatibilité OSS qui n'implémente pas tous les symboles. `apt` avait choisi le second.
C'est un bug Ubuntu connu ([LP #2069153](https://bugs.launchpad.net/bugs/2069153),
[electron-builder #9539](https://github.com/electron-userland/electron-builder/issues/9539)). Il
touche beaucoup d'applications Electron empaquetées pour Debian après la transition t64. Corrigé
dans `electron-builder.yml` par une dépendance alternative, dans l'ordre de préférence :
`'libasound2t64 | libasound2'`. Ubuntu 22.04 n'a pas `libasound2t64` et retombe sur `libasound2`.
Le RPM n'est pas concerné : `alsa-lib` n'a pas cette ambiguïté sur Fedora 43 et 44.

## 10. Pièges du desktop (cumulatif)

- **`app.whenReady()` et ESM** : un `await app.whenReady()` au niveau supérieur de `main.mjs`
  bloquait le démarrage. Le code utilise `void app.whenReady().then(async () => ...)`. De même,
  `electron-updater` est en CommonJS : `main.mjs` l'importe par défaut, puis prend `autoUpdater`
  dans l'objet importé (`desktop/main.mjs:12-14`, electron-builder#7976).
- **Relais HTTP** : `net.fetch` de Chromium, avec les en-têtes de la requête personnalisée,
  échouait en `net::ERR_FAILED`. Le handler de `worklogs://` utilise le `fetch` de Node, avec le
  jeton (`x-worklogs-token`) et le `Content-Type` nécessaire.
- **Origine stable** : la fenêtre charge `worklogs://app`. Ne pas revenir à un port HTTP
  aléatoire comme origine sans traiter la persistance du thème et du `localStorage`.
- **Sandbox** : `sandbox: true`, isolation de contexte et Node désactivé dans le renderer.
  `WORKLOGS_TEST_NO_SANDBOX=1` sert uniquement aux tests en CI et en conteneur.
- **Accents et Electron** : Electron ne décode fiablement **ni** `filename*=` (RFC 5987) **ni** les
  octets non-ASCII bruts de `filename="…"` pour un téléchargement servi par `protocol.handle`. Ne
  pas compter sur `item.getFilename()` dès qu'un nom contient un caractère non-ASCII : le relire
  depuis `item.getContentDisposition()` côté main process (fait dans `main.mjs`).
- **`res.download()` contre `res.sendFile()`** : le premier résout le chemin en absolu, pas le
  second. Toujours passer un chemin absolu à `res.sendFile()`.
- **Dépendances virtuelles Debian après t64** (Ubuntu 24.04, Debian 13 et plus) : un paquet qui
  déclare `libasound2`, `libgconf-2-4` ou une autre bibliothèque migrée peut recevoir un mauvais
  fournisseur si plusieurs paquets fournissent le même nom virtuel. Vérifier après tout changement
  de cible avec `apt-cache showpkg <paquet>`, et préférer une alternative explicite
  (`nouveau-nom | ancien-nom`) à la résolution par défaut d'apt.
- **`page.waitForEvent('download')` avec un protocole personnalisé** : ne se déclenche jamais dans
  cette configuration (`protocol.handle`, schéma privilégié `stream: true`). Observer
  `will-download` sur `session.defaultSession` directement (§9.1).
- **Clavier desktop et focus DOM** (complément du 2026-10-27) : les dialogues de l'application
  passent par `ask()`, qui rend le focus au contenu web. Une vue Google peut aussi garder le
  clavier natif alors qu'un champ WorkLogs conserve le focus DOM : le champ de nom de catégorie a
  été reproduit dans cet état sous Electron et Xvfb. Recliquer dessus sans changer de champ ne
  produit aucun `focusin`, et l'ancien correctif ne reprenait pas le clavier. `keyboard-claim.ts`
  écoute donc aussi `pointerdown` en capture sur les champs et contenus éditables ; le pont
  desktop rend le clavier sans déplacer la sélection. Les boutons et zones non éditables ne le
  réclament pas, et aucun écouteur n'existe hors desktop. Le test Electron vérifie
  **`webContents.isFocused()`** de WorkLogs et de Google avant et après le vrai clic : une simple
  frappe Playwright court-circuite cette frontière et ne prouverait rien (rouge sans
  `pointerdown`, vert avec). Un test unitaire couvre le clic dans le même champ, l'éditeur riche
  imbriqué et le retrait des deux écouteurs.
- **Premier focus du document Google** (2026-11-12) : `desktop/e2e/desktop.spec.ts:625` a échoué
  une fois sur `mint-22-base` (run 43196102796), parce que le focus posé pendant le chargement de
  la vue s'est perdu. La relance du même commit est passée. Depuis `c843275`, les préconditions
  reposent le focus à chaque essai ; les vérifications qui suivent un masquage ou un retour de la
  fenêtre restent faites une seule fois.
- **Recette « titres 4–6 »** (`e2e/rich-document.spec.ts`) : après `page.reload()`, l'éditeur de
  document était parfois absent, et une autre entrée s'ouvrait (1 échec sur 80 sur un poste, plus
  sur les agents de CI). Deux correctifs mesurés puis abandonnés (rouvrir le document ; attendre
  la version finale côté serveur) portaient le taux à 5 sur 80. Aujourd'hui, aucun réessai n'est
  configuré (ni dans `playwright.config.ts` ni dans ce fichier), et le test vérifie que le
  serveur a enregistré le document avant de recharger. Le taux d'échec actuel n'a pas été
  remesuré.
- **Environnements de test Electron jetables** : après de multiples manipulations d'un même
  conteneur (changement d'utilisateur, setuid posé à la main sur `chrome-sandbox`,
  réinstallations de bibliothèques), un test peut échouer pour des raisons propres à cet état
  accumulé. Avant de conclure à un bug produit, reproduire dans un conteneur vierge.
- **SELinux et podman en local** : voir §11 ; ne concerne que le poste de développement.

## 11. Note d'exécution locale (SELinux) — ne concerne pas la CI

Sur une machine Fedora avec SELinux *enforcing*, les montages `docker run -v host:container` de
`scripts/test-linux-package.sh` échouent par défaut (« Permission denied »), car podman n'étiquette
pas les volumes pour SELinux. **Le script n'a pas été modifié** : sur les runners GitHub Actions
(Ubuntu, sans SELinux), il s'exécute tel quel. Pour reproduire en local sur Fedora, ajouter `:z`
aux montages d'une copie de travail du script. Remplacer aussi le montage du `node` hôte par une
installation de Node dans le conteneur : le `node` d'un hôte Fedora, monté tel quel dans un
conteneur Ubuntu, casse sur ses liens symboliques absolus.

## 12. Ce qu'il reste à faire

1. **Recette manuelle sur une vraie session graphique** : icône et raccourci, nom proposé par la
   boîte « Enregistrer sous » (correctif §9.2), impression par la vraie boîte système,
   persistance après fermeture. Ces points restent ouverts dans `00-HANDOVER.md`, et n'ont pas
   été revérifiés pour ce document. La mise à jour intégrée a été vérifiée sur la Mint 22 de
   production (0.8.0 → 0.9.0, voir `desktop/update.mjs`). Sur une vraie session Fedora : non
   vérifié.
2. **Défauts du pipeline** : D1 à D16 (§8) attendent leur correction.
3. **Licence** : toujours `UNLICENSED` (voir `05-DECISIONS.md`). À trancher avant toute diffusion
   publique.
4. **Signature des dépôts** : `gpgcheck=0` côté dnf et `[trusted=yes]` côté apt, acceptables en
   usage personnel.

Node n'est plus en écart : la machine de développement est en 24.20.0, comme `.nvmrc` (relevé le
2026-11-12).

## 13. Données et commandes de travail

| Élément | Emplacement par défaut |
|---|---|
| Web | `api/data/worklogs.db` et `api/data/uploads/` |
| Desktop | `${XDG_DATA_HOME:-$HOME/.local/share}/worklogs/worklogs.db` et `uploads/` |
| Journal des mises à jour | `~/.local/share/worklogs/update.log` |
| Profil et thème | `~/.config/worklogs/`, dossier appData d'Electron |
| Préparation du packaging | `.desktop-app/`, ignoré par Git |
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
gh run download <id> -n linux-packages -D release   # paquets d'une CI, 14 jours
```

## 14. Références consultées (cumulatif)

- [Electron 44.3.0](https://releases.electronjs.org/release/v44.3.0), version approuvée à
  l'origine (44.4.5 au 2026-11-12, par Dependabot)
- [Formats Linux d'electron-builder](https://www.electron.build/v26/docs/linux/)
- [jshttp/content-disposition#27 — filename* et Latin-1](https://github.com/jshttp/content-disposition/issues/27)
- [electron/electron#44375 — liens `download` et `will-download`](https://github.com/electron/electron/issues/44375)
- [Launchpad #2069153 — `liboss4-salsa-asound2` squatte `libasound2`](https://bugs.launchpad.net/bugs/2069153)
- [electron-builder#9539 — dépendances par défaut et transition t64](https://github.com/electron-userland/electron-builder/issues/9539)
