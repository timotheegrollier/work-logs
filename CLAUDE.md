# WorkLogs

**Reprise 2026-09-11 :** desktop Linux/CI sur `codex/linux-desktop-releases`. Lire
`docs/00-HANDOVER.md` puis **`docs/06-DESKTOP-CICD.md`**. `./scripts/check.sh` est vert
(desktop compris) et les paquets DEB/RPM/AppImage sont installés/testés avec succès sur les
trois cibles CI. Reste une recette manuelle sur une vraie session desktop et l'exécution
réelle des workflows GitHub avant de taguer. Electron 44.3.0 et electron-builder 26.15.3 ont
été explicitement approuvés.

Journal de travail personnel, 100 % local, **sur un seul écran** : journal à gauche, écriture
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
- **`./scripts/check.sh` vert avant et après.** Il enchaîne types, 60 tests API, 52 tests front,
  build et 12 parcours navigateur, et finit par `CHECK OK`.
- **Rien de nouveau sans accord** : ni dépendance, ni onglet, ni mode. La valeur de cette
  application est qu'elle tient sur un écran.

## Commandes

```bash
npm run dev          # API :8410 + web :8411 → http://localhost:8411
npm test             # API + front (~20 s)
npm run test:e2e     # build + Playwright
./scripts/check.sh   # tout
./scripts/backup.sh  # sauvegarde base + fichiers joints
```

## Repères

- Base : `api/data/worklogs.db` — **jamais** commitée, jamais touchée par les tests.
- Tables : `projects`, `entries`, `tasks`, `attachments`. Schéma dans `docs/01-ARCHITECTURE.md`.
- Lecture : tout l'écran vient de `GET /api/state`. Le front la rejoue après chaque mutation.
- Les éléments interactifs portent un `aria-label` parlant : c'est l'accessibilité **et** la
  prise des tests.
