# WorkLogs — règles agents

## Reprise actuelle — 2026-09-11
- Lot desktop/CI sur `codex/linux-desktop-releases`. `./scripts/check.sh` est **vert**
  (desktop compris) ; DEB/RPM/AppImage installés et testés avec succès sur les trois cibles
  CI (Ubuntu 24.04, Fedora 43, Fedora 44) dans des conteneurs jetables. Détail et bugs
  corrigés : `docs/06-DESKTOP-CICD.md`.
- Electron **44.3.0** et electron-builder **26.15.3** : ajout explicitement approuvé.
  Ne pas redemander cet accord ; les autres ajouts restent soumis aux règles ci-dessous.
- Ne pas taguer/publier 0.2.0 avant une recette manuelle sur une vraie session desktop et
  l'exécution réelle des workflows GitHub (jamais lancés à ce jour, voir `06-DESKTOP-CICD.md`).
- Desktop : origine `worklogs://app`, serveur privé sur 127.0.0.1 et port éphémère,
  données `~/.local/share/worklogs/`, profil `~/.config/worklogs/` par défaut.
- Ne pas committer `.desktop-app/`, `release/`, les profils et les données de tests.

## Contexte
- Journal de travail perso, 100 % local, **un seul écran** (pas d'onglets, pas de routeur).
- `api/` : Node + Express + `node:sqlite`. `web/` : React + Vite + TS.
- Ports : API **8410**, web **8411**, e2e **8412**. Base : `api/data/worklogs.db`.
- Lire `docs/00-HANDOVER.md` en premier, puis `05-DECISIONS.md` (pourquoi c'est comme ça)
  et `04-RECETTES.md` (comment faire). `01-ARCHITECTURE.md` pour le schéma et l'API.

## Règles
- **Aucune fonctionnalité sans test.** Un endpoint → un test dans `api/test/` ; un geste
  utilisateur → un test dans `web/src/App.test.tsx` ou `e2e/`.
- `./scripts/check.sh` doit être vert avant et après chaque lot.
- Petits diffs. Pas de refonte silencieuse.
- **Zéro nouvelle dépendance sans accord explicite.** Socle actuel : express, cors, multer /
  react, marked, dompurify. Tests : node:test, vitest, playwright.
- Rester simple : toute nouveauté qui ajoute un onglet ou un mode est probablement à refuser.
- API : ESM, erreurs `{error}` en français, validation serveur, `""` → NULL.
- Web : TS strict, styles dans `styles.css` uniquement, requêtes via `lib.ts`.
- Ne jamais committer `api/data/*.db*` ni `api/data/uploads/*`.
- Changer un port → mettre à jour `web/vite.config.ts`, `playwright.config.ts`, `README.md`, `docs/`.

## Commandes
`npm run install:all` · `npm run dev` · `npm start` · `npm test` · `npm run test:e2e` ·
`./scripts/check.sh` · `./scripts/backup.sh` · `./scripts/stop.sh`

## Pièges
Détaillés dans `docs/02-DEV.md` : migration V1→V2 et `legacy_alter_table`, index créés après
migration, `node:sqlite` expérimental, WAL, glisser-déposer HTML5 dans les tests, `screen` qui
meurt avec la session.
