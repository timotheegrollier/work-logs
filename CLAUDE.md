# WorkLogs

**Lot en cours : documents riches et Google Drive** sur `codex/integrated-documents`.
Lire `docs/08-GOOGLE-DOCS.md` : Tiptap 3.31.3 et ses extensions listées dans `AGENTS.md`
ont été explicitement approuvés. Édition dans WorkLogs, connexion et sélection Google
dans le navigateur système ; aucune recette avec un vrai compte Google à ce stade.

**État au 2026-09-14 :** application desktop Linux **en production**, 19 releases publiées
(`v0.2.0` → `v0.6.12`, DEB/RPM/AppImage avec mise à jour intégrée). `./scripts/check.sh` est
vert, desktop compris. Lire `docs/00-HANDOVER.md`, puis **`docs/07-RELEASES.md`** avant toute
publication. Electron 44.3.0 et electron-builder 26.15.3 ont été explicitement approuvés.
Express reste en 4 (la 5 casse les téléchargements).

Journal de travail personnel, local par défaut avec Drive facultatif, **sur un seul écran** : journal à gauche, écriture
au centre, tâches à droite. Node + Express + `node:sqlite` (`api/`), React + Vite + TS (`web/`).

## Avant de toucher au code

1. `AGENTS.md` — les règles, en une page.
2. `docs/00-HANDOVER.md` — l'état du projet et la reprise en 3 commandes.
3. `docs/05-DECISIONS.md` — **pourquoi** c'est comme ça. La plupart de ce qui manque manque
   exprès ; ce fichier évite de le réintroduire par mégarde.
4. `docs/04-RECETTES.md` — la marche à suivre pour la tâche précise à faire.

## Les trois règles qui comptent

- **Aucune fonctionnalité sans test.** Route API → test dans `api/test/`. Geste utilisateur →
  test dans `web/src/App.test.tsx`, ou dans `e2e/` si ça dépend d'un vrai navigateur.
- **`./scripts/check.sh` vert avant et après.** Il enchaîne types, 71 tests API, 64 tests front,
  25 tests serveur desktop/OAuth/mise à jour, 16 tests des scripts de release, build,
  16 parcours navigateur et 6 parcours de l'application desktop — **198 tests**,
  et finit par `CHECK OK`.
- **Rien de nouveau sans accord** : ni dépendance, ni onglet, ni mode. La valeur de cette
  application est qu'elle tient sur un écran.

## Commandes

```bash
npm run dev          # API :8410 + web :8411 → http://localhost:8411
npm run desktop      # l'application Electron
npm test             # API + front (~20 s)
npm run test:e2e     # build + Playwright (web)
npm run test:desktop # parcours Electron (xvfb-run si pas d'affichage)
./scripts/check.sh   # tout, 198 tests
./scripts/backup.sh  # sauvegarde base + fichiers joints
```

## Repères

- Base : `api/data/worklogs.db` — **jamais** commitée, jamais touchée par les tests.
- Tables : `projects`, `entries`, `tasks`, `attachments`. Schéma dans `docs/01-ARCHITECTURE.md`.
- Lecture : tout l'écran vient de `GET /api/state`. Le front la rejoue après chaque mutation.
- Les éléments interactifs portent un `aria-label` parlant : c'est l'accessibilité **et** la
  prise des tests.
- Données desktop : `~/.local/share/worklogs/` (base + uploads), profil dans `~/.config/worklogs/`.
- Publier = bumper avec `npm version X.Y.Z --no-git-tag-version` (synchronise le lockfile),
  pousser, attendre la CI verte, puis taguer. Détail et pièges : `docs/07-RELEASES.md`.
- Deux dépôts de mise à jour sur gh-pages : **dnf** (Fedora) et **apt** (Debian/Mint), publiés
  par `repos.yml`, rétention 3 versions. Ne jamais tester PackageKit sur le seul code de
  sortie : `pkcon get-updates` sort en 5 quand il n'y a rien à installer.
