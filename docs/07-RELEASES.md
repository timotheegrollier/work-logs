# Releases — processus complet (lire avant de publier)

Dernière mise à jour : **2026-09-11**. Releases publiées : `v0.2.0`, `v0.3.0`, `v0.4.0`.
Notes de release **en anglais**, générées par `scripts/release-notes.mjs`.

## 1. Carte du pipeline

```
commit sur master ──► CI Linux ──► tag vX.Y.Z ──► Release Linux ──► GitHub Release publiée
                       (push)         (push)         (precheck → validate? → release)
```

| Étape | Workflow | Durée typique |
|---|---|---|
| CI sur `master` (job `validate` : types, 61 tests API, 55 tests front, scripts, build, 12 tests navigateur, 4 tests desktop, `desktop:dist`, `verify-package` ; puis matrice `packages` : install + lancement sur Ubuntu 24.04 / Fedora 43 / 44, natif + AppImage) | `ci.yml` | ~6 min |
| `precheck` : le commit tagué a-t-il déjà une CI verte sur master ? | `release.yml` | ~20 s |
| `validate` (pleine) : **seulement si `precheck` répond non** | `ci.yml` réutilisé | ~6 min |
| `release` : SHA256SUMS, attestation de provenance, notes, upload, publication | `release.yml` | ~1–2 min |

Fast path habituel (tag posé juste après une CI verte) : **tag → publié en ~2 min**.
Sans fast path : ~8 min. Les deux chemins publient exactement les mêmes artefacts.
Mesuré sur la v0.4.1 : dispatch 20:51:42 → brouillon complet 20:52:45 (~63 s).

## 2. Règles de versionnage

- `package.json` racine seule fait foi (`api`/`web` restent en `0.1.0`).
- `vX.Y.Z` : Y+1 pour une fonctionnalité (icône, mise à jour au démarrage…), Z+1 pour
  correctifs/docs/process. `scripts/check-release.mjs` refuse un tag ≠ version.
- Ne jamais réécrire une release publiée : le workflow refuse d'écraser (`isDraft` testé).

## 3. Publier une release (pas à pas)

```bash
./scripts/check.sh                                  # doit finir par « CHECK OK »
git commit … && git push origin master              # 1. CI verte sur master (attendre)
node scripts/check-release.mjs vX.Y.Z               # 2. cohérence version/tag
# 3. bump de version dans package.json + push (CI re-valide le bump)
git tag vX.Y.Z && git push origin vX.Y.Z            # 4. déclenche Release Linux
gh run watch <id>                                   #    fast path : ~2 min
gh release view vX.Y.Z --json assets --jq '.assets[].name'
```

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

## 7. Pièges connus (vécus, ne pas réintroduire)

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
