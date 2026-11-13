# Releases — publier une version (lire avant de publier)

Dernière mise à jour : **2026-11-12**. Au 2026-11-12, `gh release list -L 200` compte 98 releases, de
`v0.2.0` à `v0.75.0`, publiée à 12:03 UTC (sans `-L`, la commande n'en affiche que 30).
**`gh release list` fait foi.** Les notes de release sont en anglais, générées par
`scripts/release-notes.mjs`.

Ce document décrit le geste de publier : versionnage, pas à pas, vérifications, remèdes. Le
pipeline lui-même (workflows, jobs, durées mesurées, artefacts, secrets, défauts D1 à D16) est
décrit dans [06-DESKTOP-CICD.md](06-DESKTOP-CICD.md).

## Avant tout : les postes activés avant le 2026-11-10 ne reçoivent plus les mises à jour

Depuis `5ae1a21` (2026-11-10), les dépôts apt et dnf sont servis par
`raw.githubusercontent.com`. L'ancienne adresse `https://timotheegrollier.github.io/work-logs/`
répond 404 pour les dépôts (06, D2). Un poste activé avant cette date ne voit donc plus aucune
version. Le 2026-11-12, le poste du propriétaire restait ainsi en 0.73.0, alors que la v0.74.0
était publiée, et la mise à jour ne s'installait pas. Aucune mise à jour ne peut corriger ce poste
seule, puisqu'il n'en reçoit plus. Remède, une fois par poste :

```bash
# Debian, Ubuntu, Linux Mint — appliqué et vérifié le 2026-11-12 (0.73.0 → 0.74.0)
cat /etc/apt/sources.list.d/worklogs.list      # « timotheegrollier.github.io » : poste concerné
sudo curl -fsSL -o /etc/apt/sources.list.d/worklogs.list \
  https://raw.githubusercontent.com/timotheegrollier/work-logs/gh-pages/deb/worklogs.list
sudo apt update && sudo apt install --only-upgrade worklogs

# Fedora — même cause ; remède non essayé sur un vrai poste
cat /etc/yum.repos.d/worklogs.repo
sudo curl -fsSL -o /etc/yum.repos.d/worklogs.repo \
  https://raw.githubusercontent.com/timotheegrollier/work-logs/gh-pages/rpm/worklogs.repo
sudo dnf upgrade --refresh worklogs
```

Ces commandes servent aussi à activer le dépôt sur un nouveau poste. Le symptôme exact et une
vérification sans root sont au §7.4.

## 1. Le chemin en une vue

Une publication enchaîne ces attentes. Les médianes viennent des trente derniers runs de chaque
workflow, relevés le 2026-11-10 (06 §3). La dernière colonne donne la mesure de la v0.74.0.

| Pas (§3) | Ce qui part | Attente médiane | v0.74.0 |
|---|---|---|---|
| 3. poussée de la branche | CI Linux | 13,8 min | 13,7 min |
| 6. avance rapide de master | CI Linux ; PWA et PWA Cloudflare, sans attendre la CI | 14,0 min pour la CI, moins d'une minute pour les PWA | 20,6 min pour la CI |
| 8. tag | Release Linux, chemin rapide | 2,7 min | 5,8 min |
| fin de « Release Linux » | Dépôts | 4,9 min | 4,7 min |
| dépôts publiés | cache de raw.githubusercontent.com (`max-age=300`) | jusqu'à 5 min | ancien index encore rendu à 17:03 |
| release publiée | relais de la VM, applications desktop | minuteur de 5 min ; au lancement puis toutes les 5 min | relais encore en 0.73.0 à 17:03 |

De la poussée de la branche aux dépôts vérifiés, la v0.74.0 a pris 47 minutes, et la v0.75.0
34 minutes (06 §3).

## 2. Versionnage et notes de release

- `package.json` racine seule fait foi ; `api/` et `web/` restent en `0.1.0`.
- **`package-lock.json` doit suivre.** Il porte la version à deux endroits, que npm ne met à jour
  que par `npm version`. Un bump à la main dans `package.json` laisse le lockfile en arrière. Le
  2026-09-14, l'écart atteignait **huit versions** (lockfile en `0.4.2`, manifeste en `0.6.12`).
  `scripts/check-release.mjs` refuse désormais ce cas, et son message donne la commande de remède
  (7 tests dans `scripts/check-release.test.mjs`).
- `vX.Y.Z` : Y+1 pour une fonctionnalité, Z+1 pour des correctifs, de la documentation ou du
  processus. `check-release.mjs` refuse un tag différent de la version.
- Seules les versions `X.Y.Z` traversent tout le pipeline. Une pré-release (`-rc.N`) casse le
  build web, les notes et `verify-repo` (06, D5).
- Choisir le numéro **après** avoir relu l'état (§3, pas 0). Le 2026-10-08, une « v0.51.1 » se
  préparait alors que la v0.52.0 venait de sortir. Pendant le rebase, une autre session a poussé
  « release: passe en 0.53.0 », et le lot est finalement sorti en v0.54.0. Un numéro peut aussi
  manquer : `v0.66.0` n'existe pas.
- Ne jamais réécrire une release publiée : `release.yml` refuse de la remplacer.

Les notes sont générées par `scripts/release-notes.mjs`, jamais écrites à la main :
- un en-tête en anglais et un tableau de téléchargement, avec les tailles lues dans `release/` ;
- les sujets de `git log PREV..TAG --no-merges`, où `PREV` est le tag semver précédent, repris
  tels quels et rangés par leur début : `feat`, `add`, `ajoute`, `nouveau`, `nouvelle`,
  `nouveauté` dans `What's new` ; `fix`, `corrige`, `répare`, `bug` dans `Fixes` ;
  `chore(deps)`, `build(deps`, `bump`, `deps`, `upgrade`, `maj`, `mise à jour des dépendances`
  dans `Dependencies` ; le reste dans `Other changes` ;
- les sections vides sont omises, et un lien `compare/PREV...TAG` termine la note.

Aperçu avant le tag : `node scripts/release-notes.mjs vX.Y.Z | head -40`. Tant que le tag n'existe
pas, le script lit `PREV..HEAD`. Sans `--release-dir`, les noms du tableau sortent sans version
(constaté le 2026-11-12) : c'est normal en aperçu. Retouche après publication, sans republier :
`gh release edit vX.Y.Z --notes-file notes.md`. Le script a 4 tests
(`scripts/release-notes.test.mjs`), joués par `check.sh`.

## 3. Publier une release (pas à pas)

Ce chemin a servi pour la v0.74.0 et la v0.75.0. Il passe par une branche : la CI tourne sur
toute branche poussée (`ci.yml`), ce qui valide le lot avant qu'il atteigne master. Vérifié le
2026-11-12 : **master n'est pas protégée et l'auto-merge est désactivé** (06 §5). Rien d'autre que
ce chemin n'empêche donc un commit non testé d'atteindre master, puis le téléphone, puisque les
PWA partent sans attendre la CI (06, D6).

**0. Relire l'état.** D'autres sessions et d'autres agents publient en parallèle ; c'est arrivé
plusieurs fois.
```bash
git fetch origin --tags
git log --oneline -5 origin/master
gh release list -L 3
gh run list --branch master -L 5
git worktree list
```
Pour chaque copie de travail listée, regarder ce qui n'est pas sur master :
```bash
git -C <copie> status --short --untracked-files=all
git -C <copie> log --oneline origin/master..HEAD
# -prune : la copie principale contient les copies .claude/worktrees/* des autres agents
find <copie> \( -name node_modules -o -name .git -o -path '<copie>/.claude/worktrees' \) -prune -o \
  -type f -newermt "$(date -d '10 minutes ago' '+%Y-%m-%dT%H:%M:%S')" -print | head
```
Un fichier modifié dans les dernières minutes signale un agent encore actif : ne rien prendre
dans sa copie tant qu'il travaille (§11). Si master porte déjà la version prévue, ou une plus
haute, choisir le numéro suivant.

**1. Rebaser, puis lancer la recette complète, seul sur la machine.**
```bash
git rebase origin/master
pgrep -af '[c]heck\.sh'                     # aucune autre recette ne doit tourner ; [c] évite de se trouver soi-même
./scripts/check.sh                          # jusqu'à « CHECK OK — tout est vert. »
WORKLOGS_E2E_PORT=8432 ./scripts/check.sh   # si une autre copie occupe le port 8412
```
Deux recettes simultanées faussent le résultat. Le 2026-11-12, une recette lancée pendant celle
d'un autre agent a donné 6 échecs navigateur, dont deux dépassements de délai dus à la charge.

**2. Commiter le lot, puis la version.**
```bash
git add <fichiers du lot> && git commit -m "feat(<zone>): <sujet>"
npm version X.Y.Z --no-git-tag-version      # package.json et package-lock.json ensemble
node scripts/check-release.mjs vX.Y.Z       # « Version de release : vX.Y.Z »
git commit -m "release: passe en X.Y.Z" -- package.json package-lock.json
```
Ne pas éditer `package.json` à la main. `--no-git-tag-version` empêche npm de commiter et de
taguer seul : le tag vient au pas 8, après la CI verte de master. Pour la v0.74.0 et la v0.75.0, le
commit de version a aussi mis la version dans le titre de la section du lot de
`docs/00-HANDOVER.md` ; l'ajouter alors à la liste des fichiers du commit. Le sujet de chaque
commit finit dans les notes : choisir son préfixe en conséquence (§2).

**3. Pousser la branche.**
```bash
git branch --show-current                   # jamais master : depuis master, la ligne suivante pousse sur master
git push origin HEAD                        # branche déjà poussée puis rebasée : git push --force-with-lease origin HEAD
```
Cette poussée lance « CI Linux » et ne publie rien. Depuis une copie sur `master` (la copie
principale l'était le 2026-11-12), créer d'abord une branche : `git switch -c <branche>`.

**4. Attendre la CI verte sur la branche** (13,8 min en médiane).
```bash
gh run list --commit "$(git rev-parse HEAD)" --workflow ci.yml -L 1   # vide juste après la poussée : réessayer
gh run watch <id> --exit-status
gh run view <id> --log-failed         # si le run est rouge
gh run rerun <id> --failed            # un seul job d'installation rouge : relancer d'abord
```
Un échec isolé d'un job « Installation et lancement » se relance avant de conclure à une
régression. Le 2026-11-12, `db6e5d6` a échoué une fois sur `mint-22-base` (focus Google perdu
pendant le chargement de la vue), puis est passé à la relance. Si la relance échoue au même
endroit, traiter l'échec comme une régression.

**5. Revérifier que master n'a pas bougé.**
```bash
git fetch origin --tags
git merge-base --is-ancestor origin/master HEAD && echo "avance rapide possible"
gh release list -L 3
```
Si master a bougé : rebaser, relancer `./scripts/check.sh` sur l'état rebasé, revoir le numéro de
version si master en porte un égal ou supérieur, puis reprendre au pas 3.

**6. Passer sur master.** En avance rapide, comme pour la v0.74.0 et la v0.75.0 :
```bash
git push origin <sha>:refs/heads/master     # refusé si master a bougé ; ne jamais forcer
git ls-remote origin refs/heads/master      # doit afficher <sha>
```
Ou par une PR fusionnée, si une revue est voulue. La PR lance une seconde CI (`pull_request`) en
plus de celle du push, et sa fusion se fait à la main sur GitHub. Après la fusion, vérifier que
l'arbre est celui de la branche :
```bash
git fetch origin
git diff --quiet <sha-de-la-branche> origin/master && echo "arbre identique"
```
Sans « arbre identique », ne pas taguer : une fusion après un revert a déjà perdu 148 lignes en
silence. Le commit à taguer est alors celui de master, pas celui de la branche.

L'arrivée du commit sur master, par poussée ou par fusion, déclenche « CI Linux », « PWA » et
« PWA Cloudflare ». **Les deux PWA n'attendent pas la CI** : le téléphone reçoit ce commit en moins
d'une minute (06, D6).

**7. Attendre la CI verte sur master** (14,0 min en médiane ; 20,6 min pour la v0.74.0).
```bash
gh run list --commit <sha> --branch master --workflow ci.yml -L 1
gh run watch <id> --exit-status
```
Ne rien pousser d'autre sur master pendant ce temps. Un nouveau push annulerait ce run, et le tag
partirait en chemin plein (§4). Si un autre agent pousse quand même et que ce run finit en
`cancelled`, taguer tout de même `<sha>` au pas 8 : le chemin plein le revalide sur le tag. Ne pas
relancer le run annulé : il entrerait dans le groupe de concurrence de master (`ci.yml:16-18`)
et pourrait annuler la CI en cours de l'autre agent (non essayé).

**8. Taguer ce commit, et lui seul.**
```bash
gh release list -L 3                        # aucune version plus haute en cours ailleurs ?
gh run list --commit <sha> --workflow 'CI Linux' --json databaseId,conclusion,headBranch
                                            # attendu : un run "success" sur "master"
git tag vX.Y.Z <sha>                        # tag léger : ni -a, ni -s, ni -m (-m implique -a)
git push origin vX.Y.Z
```
Un tag annoté donne à `precheck` le SHA de l'objet tag, donc le chemin plein (§4) : vécu avec la
v0.13.0.

**9. Surveiller « Release Linux », puis « Dépôts ».**
```bash
gh run list --workflow release.yml --branch vX.Y.Z -L 1
gh run watch <id> --exit-status       # 2,7 min en médiane ; 5,8 min pour la v0.74.0
gh run list --workflow repos.yml -L 1 --json databaseId,createdAt
                                      # créé 2 à 4 s après la fin de Release Linux : plus tôt, c'est le run précédent
gh run watch <id> --exit-status       # 4,9 min en médiane
```
Sur le chemin rapide, `precheck` journalise « already validated by run `<id>` — skipping
rebuild », et `validate` apparaît sauté. Dans « Dépôts », les lignes « accepts at most 1 arg(s),
received 2 » et « pas de .rpm dans vX.Y.Z, arrêt » sont attendues, et n'arrêtent rien (06, D1).
Les deux PWA sont parties au pas 6.

**10. Vérifier chaque publication** (§5), y compris un vrai poste apt ou dnf. `verify-repo` vert
ne prouve pas qu'un poste reçoit la version.

## 4. Chemin rapide : pourquoi c'est sûr, et quand il saute

`precheck` vérifie un fait au lieu de le supposer : le commit du tag a-t-il un run « CI Linux » en
`success` sur `master` ?
- Oui (`skip=true`) : `validate` est sauté, et `release` reprend les paquets de ce run
  (`gh run download`, artefact gardé 14 jours).
- Non (`skip=false`) : `validate` rejoue toute la CI sur le tag, installations comprises, puis
  `release` prend les paquets du run courant. Le dernier chemin plein date de la `v0.43.0`
  (2026-10-05, 11,2 min). Aujourd'hui, environ 16 min sont estimées, sans mesure.
- Dans les deux cas, `release` exige que `precheck` ait réussi, et que `skip` soit vrai ou que
  `validate` ait réussi. Aucun chemin ne publie sans CI verte.
- Le chemin plein reconstruit les paquets : mêmes noms, pas les mêmes octets. `latest-linux.yml`,
  par exemple, porte la date de sa construction (`releaseDate`).

Le tag part en chemin plein dans trois cas :
- la CI de master de ce commit n'est pas finie, a échoué, ou a été annulée par un push suivant ;
- le commit n'a été validé que sur une branche ou une PR ;
- le tag est annoté : `object.sha` désigne alors l'objet tag, pas le commit. Vécu le 2026-09-16 :
  la v0.13.0, taguée en annoté, a pris le chemin plein (run 35113664670, « No green CI for v0.13.0
  (94fcf0a…) »), alors que son commit `e6cf944` avait une CI verte sur master (run 35112767768,
  finie 13 s avant).

Le chemin rapide échouerait au lieu de sauter si l'artefact avait expiré, plus de 14 jours après
la CI (06, D9).

`precheck` et `release` ajoutent la permission `actions: read`, indispensable pour lire les runs
et télécharger l'artefact d'un autre run. Deux leçons de la mise au point (v0.4.1, 2026-09-11), à
ne pas réintroduire :
- `precheck` n'a pas de checkout, volontairement : `gh` n'y a aucun contexte de dépôt.
  `gh run list` exige donc `-R "$GITHUB_REPOSITORY"`, sinon « failed to determine base repo ».
- `gh api` ne connaît pas `-R`, puisque l'adresse contient déjà le dépôt : il y échoue sur
  « unknown shorthand flag ».

## 5. Vérifier chaque canal après publication

| Canal | Commande ou geste | Attendu |
|---|---|---|
| GitHub Release | `gh release view vX.Y.Z --json assets --jq '.assets[].name'` puis `gh release list -L 3` | six fichiers (`.deb`, `.rpm`, `.AppImage`, `.AppImage.blockmap`, `latest-linux.yml`, `SHA256SUMS`) ; `vX.Y.Z` marquée « Latest » |
| Intégrité | `gh release download vX.Y.Z -D <dossier vide>`, puis, dans ce dossier, `sha256sum -c SHA256SUMS` | chaque fichier « Réussi » (« OK » en locale anglaise) |
| Dépôts publics | `node scripts/verify-repo.mjs vX.Y.Z https://raw.githubusercontent.com/timotheegrollier/work-logs/gh-pages` | « Dépôts publics vérifiés : X.Y.Z (deb X.Y.Z, rpm X.Y.Z) en 1 essai(s), N s. » ; seule la dernière version passe (`KEEP: 1`) : depuis la v0.75.0, `v0.74.0` répond « Packages ne liste pas worklogs 0.74.0 » et réessaie jusqu'à 600 s |
| Index apt brut | `curl -s https://raw.githubusercontent.com/timotheegrollier/work-logs/gh-pages/deb/Packages \| grep '^Version:'` | `Version: X.Y.Z`, après jusqu'à 5 min de cache : à 17:03, l'ancien index de la v0.74.0 répondait encore |
| Poste apt | `cat /etc/apt/sources.list.d/worklogs.list`, puis `sudo apt update && apt-cache policy worklogs` | une adresse `raw.githubusercontent.com` ; « Candidat : X.Y.Z » |
| Poste apt, sans root | simulation du §6 | « Candidat : X.Y.Z » |
| Poste dnf | `cat /etc/yum.repos.d/worklogs.repo`, puis `sudo dnf upgrade --refresh worklogs` et `rpm -q worklogs` | `baseurl=https://raw.githubusercontent.com/…/rpm` ; la version X.Y.Z installée (non vérifié sur un vrai poste Fedora depuis le passage en raw) |
| Application desktop, paquet | ouvrir l'application, ou cliquer la pastille de version à côté du logo | « Mettre à jour maintenant », mot de passe, « Redémarrer » ; dans `~/.local/share/worklogs/update.log`, « pré-vol PackageKit : X.Y.Z » puis « installation apt : succès (X.Y.Z) » (ou `dnf`) |
| AppImage | lancer l'AppImage | « Mettre à jour », puis « Redémarrer » ; non observé pour ce document |
| PWA du téléphone | `curl -s https://worklogs-google.cocodexcocoder.workers.dev/sw.js \| grep VERSION` et `curl -s https://worklogs-google.cocodexcocoder.workers.dev/token` | `const VERSION = 'X.Y.Z';` et `{"ok":true,"configured":true}` ; puis rouvrir la PWA |
| PWA, miroir Pages | `curl -s https://timotheegrollier.github.io/work-logs/sw.js \| grep VERSION` | la même version |
| Relais de la VM | depuis le réseau Tailscale : `curl -s https://worklogs-relais.tail614cd0.ts.net:8443/health` | `"version":"X.Y.Z"` |

La version de `sw.js` dit un numéro, pas un commit. Le 2026-11-12, `db6e5d6` était servi sous
`0.74.0`, sans release, parce que la PWA suit chaque push sur master.

Pour le relais, compter plus que les 5 minutes du minuteur. Pour la v0.74.0, publiée à 16:57:34,
il répondait encore `0.73.0` à 17:03, et `0.74.0` au relevé suivant, le 2026-11-12 au matin.
L'heure exacte de sa bascule n'est pas connue. Si la version tarde, lire sur la VM
`journalctl -u worklogs-relais-maj -n 20` ([09-RELAIS.md](09-RELAIS.md), « Mise à jour
automatique »).

## 6. Tester sans publier

- **Pousser une branche.** C'est le test complet : types, tests, build, paquets, et installation
  réelle sur trois distributions. Les paquets restent téléchargeables 14 jours :
  `gh run download <id> -n linux-packages -D release`.
- **Sur le poste** : `./scripts/check.sh`, puis `npm run desktop:dist`,
  `node scripts/verify-package.mjs` et `node scripts/appimage-blockmap.mjs`. Construire le RPM
  demande `rpm` (Ubuntu, Mint) ou `rpm-build` (Fedora). Le test d'installation tourne avec
  Docker : `./scripts/test-linux-package.sh ubuntu:24.04 deb` (piège SELinux : 06 §11).
- **Version et notes** : `node scripts/check-release.mjs vX.Y.Z`, puis
  `node scripts/release-notes.mjs vX.Y.Z | head -40` (§2).
- **Logique de `precheck`**, en lecture seule, avec le SHA du commit à taguer :
  ```bash
  gh run list --commit <sha> --workflow 'CI Linux' -R timotheegrollier/work-logs \
    --json databaseId,conclusion,headBranch \
    --jq '[.[] | select(.conclusion == "success" and .headBranch == "master")] | .[0].databaseId // empty'
  ```
  Un numéro de run en sortie annonce le chemin rapide ; rien annonce le chemin plein. Rejoué le
  2026-11-12 sur `e3e2d10` : 42855202592, le run de master qui a servi à la v0.74.0.
- **Dépôts publics**, en lecture seule : `node scripts/verify-repo.mjs vX.Y.Z <adresse raw>` (§5).
- **Ce qu'un poste apt verrait**, sans root et sans toucher au système (vérifié le 2026-11-12) :
  ```bash
  T=$(mktemp -d) && mkdir -p "$T/lists/partial" "$T/parts"
  curl -fsSL -o "$T/worklogs.list" \
    https://raw.githubusercontent.com/timotheegrollier/work-logs/gh-pages/deb/worklogs.list
  OPTS=(-o Dir::Etc::SourceList="$T/worklogs.list" -o Dir::Etc::SourceParts="$T/parts" \
        -o Dir::State::Lists="$T/lists")
  apt-get "${OPTS[@]}" -o APT::Sandbox::User="$(whoami)" update
  apt-cache "${OPTS[@]}" policy worklogs     # « Candidat : X.Y.Z »
  rm -rf "$T"
  ```
  Les avertissements sur `/var/cache/apt/pkgcache.bin` (permission refusée) sont normaux sans
  root. Remplacer le contenu de `worklogs.list` par la ligne d'un poste permet de tester sa
  source.
- **Relais**, sur la VM : `node /opt/worklogs-relais/mise-a-jour.mjs --simuler` dit ce qui serait
  fait.
- **Workflows** : un YAML lisible se vérifie par
  `python3 -c "import yaml; [yaml.safe_load(open(f'.github/workflows/{n}.yml')) for n in ('ci','release','repos','pwa','pwa-cloudflare')]; print('yaml ok')"`.
  `node --test scripts/workflows.test.mjs` ne couvre que deux workflows sur cinq (06, D15).
- **Ne pas compter sur le `workflow_dispatch` de « Release Linux ».** Il ne sert que pour un tag
  sans release publiée, et laisse un brouillon. Sur un tag déjà publié, il échoue (« Une release
  publiée ne doit pas être remplacée. »). Sa fin déclenche « Dépôts », dont le garde-fou n'arrête
  rien (06, D1).

## 7. Mises à jour des clients

### 7.1 Les circuits, par format installé

`installKind()` de `desktop/update.mjs` lit le format : variable `APPIMAGE`, sinon exécutable sous
`/opt/` (paquet système), sinon développement. L'application vérifie à l'ouverture, puis toutes les
5 minutes, et quand on clique la pastille de version. Elle lit
`https://api.github.com/repos/timotheegrollier/work-logs/releases/latest`, en 10 s au plus. Chaque
vérification s'inscrit dans `~/.local/share/worklogs/update.log`.

| Installé via | Comment la mise à jour arrive | Téléchargé (v0.74.0) |
|---|---|---|
| `.rpm` et dépôt dnf | dialogue « Mettre à jour maintenant » ; pré-vol sans mot de passe, `pkcon --noninteractive refresh force` puis `pkcon --noninteractive --plain get-updates` ; installation `pkexec /usr/bin/dnf upgrade -y worklogs`, mot de passe demandé par polkit ; contrôle par `rpm -q` ; « Redémarrer » | paquet complet, 84,0 Mio |
| `.deb` et dépôt apt | même circuit ; installation `pkexec /usr/bin/apt-get -o Dpkg::Use-Pty=0 install -y --only-upgrade worklogs` ; contrôle par `dpkg-query` | paquet complet, 93,7 Mio |
| `.AppImage` | electron-updater lit `latest-linux.yml` de la dernière release ; dialogue « Mettre à jour » ; téléchargement différentiel d'après le blockmap embarqué dans l'AppImage (`blockMapSize` de `latest-linux.yml`), pas le `.blockmap` publié (lecture du code, 06, D12) ; « Redémarrer » ; en cas d'erreur, repli sur le dialogue de téléchargement | les blocs modifiés ; taille non mesurée |
| paquet système sans candidat, ou sans `pkcon` et `pkexec` | dialogue « Télécharger la mise à jour », qui donne la commande de mise à jour et celle d'activation du dépôt | paquet complet |
| sources (`npm run desktop`) | aucune vérification : l'application n'est pas empaquetée | — |

Sans candidat exact au pré-vol, l'application n'installe jamais. Elle ne propose de redémarrer
qu'après avoir lu la version attendue sur le disque. Le circuit en un clic a été vérifié sur la
Mint 22 de production (0.8.0 → 0.9.0, commentaire de `privilegedInstallCommand`).

### 7.2 Activer le dépôt sur un nouveau poste

Le paquet s'installe d'abord depuis la release. Les commandes d'activation sont celles de la
section « Avant tout », en tête de ce document. L'application propose les mêmes dans son dialogue
de repli (`repoHint` de `desktop/update.mjs`), avec `sudo dnf update worklogs` côté Fedora.

Ce que voit le poste :
- apt lit un dépôt **plat** : `Packages` et `Release` sont à la racine de `deb/`, d'où le `/`
  final du `.list`. Le dépôt n'est pas signé : `[trusted=yes]`, même choix que `gpgcheck=0` côté
  dnf.
- dnf lit `baseurl=https://raw.githubusercontent.com/timotheegrollier/work-logs/gh-pages/rpm`. Il
  n'y a pas de delta RPM : `makedeltarpm` ne lit pas les payloads produits par fpm (« payload read
  failed », vérifié avec 0.4.1 et 0.4.2, alors que `rpm -K` les valide).
- Chaque dépôt ne garde que la dernière version. Les anciennes restent sur les releases GitHub.

### 7.3 PWA et relais

- **PWA.** Le service worker (`web/src/sw-template.js`) met la version dans le nom de son cache. À
  l'installation, il précache tout le build, puis prend la main (`skipWaiting`, puis
  `clients.claim`) et supprime les anciens caches. Les navigations passent par le réseau d'abord,
  et `/api/` n'est jamais mis en cache. La nouvelle version se voit à la réouverture de la PWA.
  `sw.js` est servi avec `max-age=600` sur Pages, et `max-age=0, must-revalidate` sur Cloudflare.
- **Relais de la VM.** Le minuteur `worklogs-relais-maj.timer` passe 2 min après le démarrage,
  puis toutes les 5 min, avec 30 s de décalage aléatoire au plus. Il installe la dernière release
  publiée si elle est plus récente. Le relais doit répondre sur `/health` avec la nouvelle
  version en 30 s, sinon tout revient en arrière et cette version est écartée. Détail et
  commandes : [09-RELAIS.md](09-RELAIS.md), « Mise à jour automatique ».

### 7.4 Postes restés sur l'ancienne adresse : symptôme et preuve

Symptôme : apt reste sur l'ancienne version, et `sudo apt update` finit ainsi (relevé le
2026-11-12, avec la simulation du §6 et l'ancienne ligne
`deb [trusted=yes] https://timotheegrollier.github.io/work-logs/deb/ ./`) :
```
E: Impossible de récupérer https://timotheegrollier.github.io/work-logs/deb/./Packages  404  Not Found
E: Le téléchargement de quelques fichiers d'index a échoué, ils ont été ignorés, ou les anciens ont été utilisés à la place.
```
apt garde alors l'ancien index et ne voit jamais la nouvelle version. D'après le code,
l'application trouve bien la release sur GitHub. Son pré-vol PackageKit ne voit ensuite aucun
candidat, et elle ouvre le dialogue « Télécharger la mise à jour ».

Avant de donner les commandes de remède, la simulation du §6 prouve, sans root, que la nouvelle
source voit la version. C'est ainsi que la v0.74.0 a été vue avant le remède du 2026-11-12. Après
le remède, `apt-cache policy worklogs` montre la version installée.

Tout poste activé avant le 2026-11-10 est concerné. Aucun mécanisme de migration n'existe.

## 8. Pièges connus (vécus, ne pas réintroduire)

### 8.1 Publication et pipeline

- **Événements stériles de `GITHUB_TOKEN`.** Une release créée ou publiée avec `GITHUB_TOKEN` ne
  redéclenche aucun workflow (anti-boucle de GitHub). « Dépôts » écoute donc la fin de « Release
  Linux » (`workflow_run`), jamais `release: published`. Son garde-fou, censé écarter les
  brouillons, n'écarte rien (06, D1).
- **D'autres sessions publient en parallèle.** Relire l'état juste avant le bump, avant la
  poussée sur master et avant le tag, pas seulement en début de lot (§3, pas 0, 5 et 8). Le
  2026-10-08, il a fallu rebaser deux fois (§2). Le 2026-11-10, master a bougé pendant un audit
  d'une demi-heure, et une section de `05-DECISIONS.md` a pris le numéro que le lot employait déjà.
  Au rebase, renuméroter ses propres renvois sans toucher à ceux de l'autre session, puis relancer
  `check.sh`.
- **« Latest » va à la dernière release publiée.** `release.yml` publie avec `--latest`, même si
  une version plus haute existe déjà. Le relais et les applications suivent `releases/latest`. Ne
  pas taguer tant qu'une release déjà bumpée par une autre session n'est pas publiée, et taguer
  dans l'ordre des versions.
- **La poussée directe sur master fait porter le risque à master.** Le 2026-11-12, un agent Codex
  a poussé `db6e5d6` sur master sans CI de branche. Son run 43196102796 a échoué sur un seul job,
  `mint-22-base`, test `desktop/e2e/desktop.spec.ts:625`. `gh run rerun 43196102796 --failed` l'a
  rendu vert : c'était une instabilité, pas une régression, corrigée depuis dans le test
  (`c843275`). La PWA avait déjà publié ce commit avant le verdict (06, D6). Le chemin par branche
  l'aurait vu avant. Le 2026-11-05, cinq commits rouges de suite avaient déjà atteint master, et le
  2026-11-06 `5bb3a13` aussi.
- **CI verte avant toute fusion, arbre identique après.** Une fusion après un revert a perdu
  148 lignes en silence. Après une fusion par PR :
  `git diff --quiet <sha-de-la-branche> origin/master`.
- **Relancer un échec isolé, pas en boucle.** `gh run rerun <id> --failed` ne relance que les jobs
  rouges : pour `db6e5d6`, seul `mint-22-base` a retourné, et le run est passé vert. Relancer en
  boucle pour masquer un échec qui revient cache une régression.
- **Deux recettes simultanées faussent le résultat.** Sous charge, des délais expirent sans que le
  code soit en cause (§11). Lancer `check.sh` seul, avec `WORKLOGS_E2E_PORT=8432` si le port 8412
  est pris.
- **`verify-repo` vert ne prouve pas qu'un poste reçoit la version.** Pour la v0.74.0,
  `verify-repo` a réussi en 5 s à 17:02. À 17:03, un simple `curl` de `deb/Packages` rendait encore
  l'ancien index : le CDN de raw.githubusercontent.com garde une copie jusqu'à 5 min
  (`max-age=300`), et deux requêtes peuvent tomber sur deux copies. `verify-repo` ne voit pas non
  plus les postes restés sur l'ancienne adresse. Vérifier un vrai poste (§5).
- **Changer l'adresse des dépôts coupe les postes existants.** Le passage en raw (`5ae1a21`) n'a
  prévu aucune migration : chaque poste activé avant doit refaire l'activation à la main (section
  « Avant tout »). Avant tout nouveau changement d'adresse, prévoir comment les postes existants
  suivront.
- **Rétention des dépôts.** Sans purge, `gh-pages` avait atteint 1,3 Go le 2026-09-14 (16 RPM
  jamais supprimés), ce qui ralentissait chaque clone et chaque déploiement. `prune-repo.mjs` trie
  en semver, pas en texte : sinon `0.6.9` passerait après `0.6.10`, et la purge supprimerait la
  mauvaise version. Une seule version est gardée depuis `4b5e3c5`, ce qui a vidé le test de mise à
  niveau (06, D3). La purge vide l'arbre, pas l'historique de `gh-pages` (06, D8).
- **Déploiement Pages bloqué puis annulé** (2026-11-06, v0.72.0). Le job `deploy` de
  `pages-build-deployment` est resté 10 min en `updating_pages`, puis s'est annulé (« Timeout
  reached »). « Dépôts » a alors échoué à juste titre sur sa vérification publique. Relancer ne
  servait à rien : le déploiement portait le SHA de `gh-pages`, déjà marqué annulé. Il a fallu
  donner un nouveau SHA à `gh-pages`, avec le même arbre. Pages expirait encore après `KEEP: 1`.
  Depuis le 2026-11-10 (`5ae1a21`), la PWA est publiée par artefact et les dépôts sont lus en
  brut : cette recette ne s'applique plus.
- **Limite de 100 Mo par fichier de git.** Le 2026-09-14, le push sur `gh-pages` a été refusé
  (`GH001`, `.deb` de 115,64 Mo). Le `.deb` est passé en xz (`c894205`), et un garde-fou a été
  ajouté ; ce garde-fou a lui-même un défaut (06, D4).

### 8.2 Mise à jour intégrée (PackageKit, pkexec)

- **Revérification en tâche de fond** (`desktop/update.mjs` et `main.mjs`, depuis la 0.6.0 ;
  toutes les 5 min depuis la 0.6.4) : `startPoll` sans chevauchement, mémoire du refus
  (`dismissedVersion`), garde `systemUpdating`.
- **Cache PackageKit menteur** (vécu deux fois). Prouvé en conteneur Fedora : `get-updates`, même
  avec `--cache-age 1`, relit un cache périmé ; seul `pkcon refresh force` recharge vraiment. Le
  pré-vol fait donc `refresh`, puis `get-updates`. `parsePkconCandidate` lit le vrai format texte
  (`worklogs-0.6.8-1.x86_64 (wl)`, pas des `;`) : sans candidat exact, aucune installation. Le
  redémarrage n'est proposé qu'après `rpm -q` égal à la version attendue (`installedMatches`,
  testé) ; sinon erreur explicite, jamais de faux succès.
- **`pkcon` ne peut pas installer depuis une application graphique** (corrigé en 0.9.1). Ses deux
  formes sont sans issue, reproduit sur Linux Mint 22, session Cinnamon, avec un agent polkit bien
  enregistré (`polkitd: Registered Authentication Agent for unix-session:c2 … [cinnamon]`) :

  ```
  printf 'y\n' | pkcon --cache-age 1 update worklogs
    → Erreur fatale: user declined simulation            (code 7, en 0,5 s)
  pkcon --noninteractive --cache-age 1 update worklogs
    → État: Attente de l'authentification
      Erreur fatale: Failed to obtain authentication      (code 7)
  ```

  Sans `--noninteractive`, pkcon exige un **vrai terminal** pour sa confirmation. Alimenter son
  entrée standard ne suffit pas : la 0.7.5 réécrivait « y » toutes les 500 ms, et ça ne pouvait
  pas marcher. Il refuse sa propre simulation avant même de parler à polkit. Avec
  `--noninteractive`, il marque la transaction non interactive, et polkit refuse sans jamais
  afficher de dialogue. Il n'y a pas de troisième forme : **ne pas réessayer ce chemin**.
  L'installation passe par `pkexec` et le gestionnaire natif (`privilegedInstallCommand`), qui est
  fait pour ça : il demande l'autorisation à l'agent polkit de la session, puis exécute en root.
  `refresh` et `get-updates` restent sur pkcon, non interactifs et sans mot de passe
  (`system-sources-refresh` est en `implicit active: yes`).

  Les conteneurs de recette tournent en root, sans polkit : ils ne peuvent révéler aucun de ces
  défauts. **La seule preuve qui compte est une vraie session graphique.**
- **« user declined simulation » n'est pas un refus d'autorisation.** L'expression qui qualifiait
  l'échec attrapait `declined`, et annonçait « autorisation administrateur non accordée » à
  quelqu'un à qui aucune fenêtre n'avait rien demandé : deux heures de recherche du mauvais côté.
  `isAuthorizationFailure` distingue désormais les deux cas, et un test l'ancre. Attention aussi
  au 127 de `pkexec` : `man pkexec` le donne pour « not authorized » **et** pour une erreur
  d'exécution ; seul le message tranche.
- **`pkcon get-updates` sort en 5 quand il n'y a rien à installer** (« nothing useful was done »),
  pas en 0. Le pré-vol traitait tout code non nul comme « interrogation impossible », **sautait sa
  propre garde**, puis tentait quand même l'installation : c'est ce qui cassait Mint.
  `pkconProbeOutcome` décide désormais `ready`, `none` ou `mismatch`, et `none` bascule sur le
  repli manuel. Ne jamais revenir à un test sur le seul code de sortie.
- **Le format de `get-updates` diffère selon la dorsale**, relevé en conteneur : dnf
  `worklogs-0.6.8-1.x86_64 (wl)`, apt `worklogs-0.6.13.amd64 (worklogs-stable-)`. L'expression
  d'origine exigeait la révision `-1`, et ne trouvait donc jamais rien sur Debian. Toute évolution
  du parseur doit couvrir les deux formats (tests dédiés).
- **`WORKLOGS_SKIP_UPDATE_CHECK=1`** dans les parcours Electron : l'application empaquetée ne doit
  jamais toucher le réseau pendant la recette.

### 8.3 Paquets, tests et code

- **Liste fermée de `stage-desktop.mjs`.** Tout nouveau fichier sous `desktop/` doit y être
  ajouté. Sinon, l'application installée plante à l'import : fenêtres jamais ouvertes, et
  `firstWindow` qui expire dans les trois jobs `packages`. Vu sur la 0.3.0, puis avec
  `shared-mount.mjs` le 2026-10-05. Depuis, un garde-fou arrête le build quand un import de
  `desktop/` manque.
- **Express 5** casse le téléchargement des pièces jointes : le parcours « joindre un fichier à une
  entrée puis le récupérer » de `e2e/worklogs.spec.ts` expire. Rester en Express 4 jusqu'à un lot
  de migration dédié.
- **Test du brouillon dans `App.test.tsx`** : affirmer via `waitFor`, jamais sur le premier rendu.
  L'éditeur recharge par HTTP : sans `waitFor`, le test dépend du minutage (rouge en CI, vert en
  local).
- **Le `.deb` est en xz, pas en gzip.** L'ancienne consigne inverse, choisie pour la vitesse, est
  caduque. En gzip, le `.deb` dépassait la limite de 100 Mo de git (§8.1) ; xz coûte quelques
  minutes de build. 97 % du poids est le runtime Electron, pas le code de WorkLogs (2,3 Mo d'ASAR
  lors de la mesure).
- **Icônes** : `desktop/icon.svg` est la source. Les PNG de 16 à 512 px sont générés en local
  (ImageMagick et RSVG), puis committés : la CI n'a besoin d'aucun outil graphique.
  `desktop/icon.png` (512 px) reste pour l'icône de fenêtre (`main.mjs`, staging et ASAR).

### 8.4 Dépendances

- Aucun ajout npm sans accord explicite.
- `electron-updater` est une dépendance racine approuvée. `stage-desktop.mjs` l'embarque avec sa
  fermeture transitive, lue dans le lockfile racine. `verify-package.mjs` exige
  `/node_modules/electron-updater/package.json` dans l'ASAR : ce garde-fou date de l'incident de
  la 0.3.0, où `update.mjs` manquait au paquet.
- Electron et electron-builder ont été approuvés explicitement, en 44.3.0 et 26.15.3. Dependabot
  les a montés depuis : Electron 44.4.5 le 2026-10-05, electron-builder 26.18.0 le 2026-11-01.
- Les montées Dependabot se fusionnent après une CI verte. En cas d'incompatibilité réelle,
  fermer la PR avec un commentaire motivé (exemple : Express 5).

## 9. PWA Cloudflare : déployée par la CI, recette manuelle en secours

Le téléphone ouvre `https://worklogs-google.cocodexcocoder.workers.dev/` : la PWA à `/`, le relais
de jetons Google à `/token` (option B). GitHub Pages reste un miroir, publié par artefact, mais le
téléphone ne le consulte pas. Vécu le 2026-09-27 : Cloudflare servait la 0.37.0 alors que GitHub
servait déjà la 0.41.x, sans aucun changement visible malgré une CI verte. Le Worker n'était alors
déployé qu'à la main.

Depuis le 2026-10-06, le workflow **« PWA Cloudflare »** (`pwa-cloudflare.yml`) construit la PWA
(`VITE_PWA=1`) et lance `wrangler deploy` depuis `oauth-proxy/`. Il part à chaque push sur master
qui touche `web/`, `oauth-proxy/` ou la version, sans attendre la CI (06, D6). Un changement de
`scripts/pwa-sw.mjs` seul ne le déclenche pas (06, D7). Il exige deux secrets GitHub :
`CLOUDFLARE_API_TOKEN` (jeton « Edit Cloudflare Workers ») et `CLOUDFLARE_ACCOUNT_ID`. Sans eux,
il échoue en le disant. Le secret Google du relais reste stocké côté Worker
(`wrangler secret put`), et le déploiement le conserve.

Recette manuelle, en secours ou si le workflow est rouge, depuis la racine :

```bash
VITE_PWA=1 VITE_GOOGLE_TOKEN_PROXY=https://worklogs-google.cocodexcocoder.workers.dev npm --prefix web run build
# (+ VITE_GOOGLE_CLIENT_ID=…apps.googleusercontent.com : repris de la PWA publiée, public par nature)
npx wrangler login   # une fois ; impossible en CI, à faire sur un poste connecté
npx wrangler deploy --config oauth-proxy/wrangler.toml  # → https://worklogs-google.cocodexcocoder.workers.dev
```

> **Piège vécu le 2026-09-29.** Un `wrangler.jsonc` à la racine (`name: worklogs`, assets `web/`)
> prenait le pas : `npm run deploy` a poussé les sources brutes sur un autre Worker, d'où une page
> blanche. La seule configuration qui fait foi est `oauth-proxy/wrangler.toml` ; les scripts
> `deploy` et `preview` imposent `--config`. Ne jamais recréer de `wrangler.jsonc` à la racine, ni
> lancer `wrangler init` à la racine.

Vérifier : `sw.js` doit annoncer la version (`curl -s …/sw.js | grep VERSION`), et `/token` doit
répondre `{"ok":true,"configured":true}`. Puis rouvrir la PWA sur le téléphone : le service worker
se met à jour à la réouverture. Détail : `08-GOOGLE-DOCS.md`, « Relais de jetons ».

## 10. Quand ça casse : symptôme, cause, remède

| Symptôme | Cause | Remède |
|---|---|---|
| apt reste sur l'ancienne version ; `sudo apt update` finit sur « Impossible de récupérer https://timotheegrollier.github.io/work-logs/deb/./Packages 404 » | source activée avant le 2026-11-10 (06, D2) | section « Avant tout », en tête de ce document |
| L'application propose la mise à jour, puis ouvre « Télécharger la mise à jour » ; `update.log` dit « pré-vol PackageKit : aucune mise à jour listée » | aucun dépôt actif, ou dépôt sur l'ancienne adresse | `cat /etc/apt/sources.list.d/worklogs.list` (ou `/etc/yum.repos.d/worklogs.repo`), puis activer ou corriger la source |
| « Le gestionnaire propose la 0.A au lieu de la 0.B. » | dépôt en retard : « Dépôts » pas fini, ou cache de raw (`max-age=300`) | attendre « Dépôts » vert et 5 min, puis cliquer la pastille de version ; sinon `sudo apt update && sudo apt install --only-upgrade worklogs` (ou `sudo dnf upgrade --refresh worklogs`) |
| « Mise à jour refusée : autorisation administrateur non accordée. » | dialogue polkit fermé ou refusé | relancer et saisir le mot de passe, ou mettre à jour en console |
| CI rouge sur un seul job « Installation et lancement » | instabilité d'un test Electron (`db6e5d6`, 2026-11-12), ou miroir Ubuntu (« Mirror sync in progress? », 06, D13) | `gh run view <id> --log-failed`, puis `gh run rerun <id> --failed` ; si la relance échoue au même endroit, c'est une régression |
| CI rouge sur « un reclassement distant actualise projet et catégorie… » ou « une frappe avant les effets de l’éditeur… » | régression de la course d'`EntryEditor` corrigée le 2026-11-13 (06, D14) | lire l'envoi en échec ; ne pas relancer en boucle |
| CI ou `check.sh` rouge à l'étape front alors que tous les tests passent : « Unhandled Errors », `TypeError: Cannot read properties of null (reading 'getBoundingClientRect')` dans `measure` (`GoogleDocsEditor.tsx`) | le rappel `requestAnimationFrame` du cadre Google passait entre le retrait du cadre et le nettoyage de son effet (vu sous charge, 2 passages sur 30, 2026-11-12) ; corrigé le 2026-11-13 : l'effet garde son élément ; `retry: 1` ne rejoue pas une erreur non gérée | lire la pile : une autre erreur non gérée a la même allure ; signaler |
| `check.sh` local rouge, délais dépassés dans les parcours navigateur | une autre recette tourne en même temps ; ou le code d'un autre agent est intégré avant d'être fini (v0.75.0 : 6 échecs) | `pgrep -af '[c]heck\.sh'`, relancer seul ; intégrer un travail d'agent seulement une fois stable (§11) |
| `precheck` : « No green CI for vX.Y.Z (`<sha>`) — full validation ahead. » | tag posé avant la fin de la CI de master, sur un commit validé seulement en branche ou en PR, ou tag annoté (§4) : `<sha>` est alors celui de l'objet tag, pas du commit | laisser tourner : le chemin plein valide tout, puis publie (environ 16 min, estimé) |
| `release` échoue sur `check-release.mjs` : « Le tag vX.Y.Z doit correspondre à package.json » ou « package-lock.json désynchronisé » | tag sur le mauvais commit, ou version éditée à la main | rien n'est publié à cette étape ; corriger, supprimer le tag (`git push origin :refs/tags/vX.Y.Z`, puis `git tag -d vX.Y.Z`) et reprendre au pas 8 sur le bon commit ; un tag a déjà été reposé ainsi, pour la v0.13.0 le 2026-09-16, après un échec du chemin plein |
| `release` échoue sur « Une release publiée ne doit pas être remplacée. » | la release de ce tag est déjà publiée | ne rien réécrire ; publier une nouvelle version |
| « Dépôts » rouge sur `verify-repo` : « Dépôts publics non prêts pour vX.Y.Z après 600 s » | adresse publique en retard, ou fichier manquant ; vécu le 2026-11-06, quand Pages servait encore les dépôts | relancer plus tard `node scripts/verify-repo.mjs vX.Y.Z https://raw.githubusercontent.com/timotheegrollier/work-logs/gh-pages` ; s'il passe, les paquets sont servis ; sinon `gh workflow run repos.yml -f tag=vX.Y.Z` (un tel dispatch a republié la v0.73.0 sur raw le 2026-11-10, run 42810718995) |
| « Dépôts » rouge : « Paquet(s) au-delà de 100 Mo, dépôt apt non publié » | `.deb` trop gros (06, D4) ; non observé depuis le passage en xz | le dépôt dnf est publié, le dépôt apt perd son `.deb` ; réduire le paquet ou héberger les `.deb` hors de `gh-pages`, comme le dit le job |
| « Dépôts » sauté | « Release Linux » n'a pas fini en `success` | réparer la release, puis `gh workflow run repos.yml -f tag=vX.Y.Z` |
| « PWA Cloudflare » rouge : « Secrets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID absents » | secrets absents (vécu le 2026-10-06) | ajouter les deux secrets au dépôt (§9) |
| « PWA Cloudflare » rouge sur `assets-upload-session` : « No access to the specified resource. » | cause non établie, probablement les droits du jeton ; vécu le 2026-10-06, vert ensuite sans changement identifié dans le dépôt | relancer ; sinon recette manuelle (§9) |
| Le téléphone garde l'ancienne version | service worker pas encore remplacé, ou « PWA Cloudflare » pas passée (06, D7) | `curl -s https://worklogs-google.cocodexcocoder.workers.dev/sw.js \| grep VERSION`, fermer et rouvrir la PWA ; sinon `gh workflow run pwa-cloudflare.yml` |
| Le relais répond encore l'ancienne version | minuteur pas encore passé, préparation en cours, ou version écartée après un échec | attendre ; sinon, sur la VM, `journalctl -u worklogs-relais-maj -n 20`, puis les commandes de [09-RELAIS.md](09-RELAIS.md) |
| CI rouge sur master après une poussée directe | commit non passé par une branche (2026-11-05, 2026-11-06) | la PWA l'a déjà publié (06, D6) : corriger vite par une branche, ne pas taguer |

## 11. Intégrer le travail d'un autre agent

Plusieurs agents travaillent sur la machine, chacun dans sa copie, toutes listées par
`git worktree list`. Un lot fini peut rester non commité dans une copie : seul un inventaire le
retrouve (§3, pas 0). Le 2026-10-08, sept copies avaient ainsi du travail jamais commité, et tout
est parti en v0.52.0.

Méthode suivie pour la v0.75.0, le 2026-11-12, qui a intégré le travail non commité d'un agent
Copilot. L'autre copie est seulement lue, jamais modifiée.

1. **Attendre** que l'agent ait fini sa recette, puis que sa copie reste sans changement pendant
   quatre minutes :
   ```bash
   COPIE=<chemin de la copie>
   git -C "$COPIE" status --short --untracked-files=all
   { git -C "$COPIE" diff --binary HEAD
     (cd "$COPIE" && git ls-files --others --exclude-standard -z | xargs -0r sha256sum); } | sha256sum
   ```
   Même empreinte pendant quatre minutes. `HEAD` fait entrer dans le diff ce que l'agent a déjà
   indexé ; la seconde ligne ajoute le contenu des fichiers non suivis, que le diff ignore : sans
   elle, un fichier neuf que l'agent modifie encore ne change pas l'empreinte.
2. **Capturer** le diff et son empreinte, hors de la copie de travail pour ne pas le commiter :
   ```bash
   P=$(mktemp) && git -C "$COPIE" diff --binary HEAD > "$P" && sha256sum "$P"
   ```
3. **Appliquer** ici, dans la copie de la release, puis copier les fichiers non suivis :
   ```bash
   git apply --3way --index --allow-empty "$P"   # diff vide si l'agent n'a créé que des fichiers
   (cd "$COPIE" && git ls-files --others --exclude-standard -z | tar --null -T - -cf -) | tar -xvf -
   ```
   Ces fichiers ne sont pas dans le diff : les ajouter ensuite au commit (`git add`).
4. **Comparer** chaque fichier à celui de l'autre copie :
   ```bash
   git -C "$COPIE" diff --name-only HEAD | while read -r f; do cmp "$COPIE/$f" "$f"; done
   ```
   Une différence signale un fichier que la branche avait déjà modifié : relire cette fusion à la
   main.
5. **Lancer la recette** : `./scripts/check.sh`, seul sur la machine.
6. **Revérifier l'empreinte** juste avant de pousser, avec la commande du point 1 : celle du
   point 2 ne couvre que le diff, et en diffère dès qu'il y a des fichiers non suivis. Si elle a
   changé depuis le point 1, l'agent a repris son travail : retirer d'abord l'ancien diff (`git apply -R --index --allow-empty "$P"`, et les fichiers non suivis
   copiés), puis recommencer au point 1. Réappliquer le nouveau diff par-dessus l'ancien donne des
   conflits.

Leçon du 2026-11-12 : une première recette, lancée pendant celle de l'agent, a donné 6 échecs
navigateur. Deux venaient de la charge, et quatre de son travail encore inachevé, qu'il a corrigé
ensuite. La recette suivante, sur le lot stabilisé, était verte.

Leçon de la collecte du 2026-10-08 : un lot parti d'une vieille version peut casser une fonction
arrivée depuis sur master, **sans aucun conflit textuel**. Relire chaque lot contre ce que master
a gagné depuis sa base, pas seulement les marqueurs de conflit.
