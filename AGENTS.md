# WorkLogs — règles agents

## Reprise
- **État : v0.77.0** (`package.json` fait foi). `./scripts/check.sh` vert le 2026-11-13, après la v0.77.0,
  **1 984 tests**, échec attendu compris : 346 API · 1 383 front (plus un échec attendu) ·
  49 desktop · 49 scripts · 8 Worker · 11 relais · 117 navigateur · 20 desktop e2e.
  Lots et bilans : `docs/00-HANDOVER.md`.
- Publication : `docs/07-RELEASES.md`. `./scripts/check.sh` reste la validation requise (desktop compris).
- **Éditeur Google Docs natif** : la vraie page Google s'affiche dans la colonne centrale
  (`desktop/google-view.mjs`, `WebContentsView` isolée). Voir `docs/08-GOOGLE-DOCS.md`, `05-DECISIONS.md` §14.
  **Ne jamais déguiser l'`userAgent`** si Google referme ce chemin : c'est un contrôle de
  sécurité du fournisseur ; consigner le refus à la place.
- **Points ouverts** : `docs/00-HANDOVER.md` § « Ce qui reste à faire ». Le point 0 garde deux
  courses e2e non élucidées du 15/09 : ne pas relancer la CI en boucle pour les masquer.
- **Déjà approuvés, ne pas redemander** : Tiptap 3.31.3 (core, react, pm, starter-kit,
  extension-table, extension-image, extension-text-align, extension-text-style,
  extension-highlight), Electron, electron-builder. Les autres ajouts restent soumis aux règles ci-dessous.
- **Express reste en 4** (la 5 casse les téléchargements — voir `07-RELEASES.md` §8).

## Contexte
- Journal de travail perso, local par défaut avec Drive facultatif,
  **un seul écran** (pas d'onglets, pas de routeur).
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
  react, marked, dompurify, Tiptap / electron, electron-updater. Tests : node:test, vitest, playwright.
- Rester simple : toute nouveauté qui ajoute un onglet ou un mode est probablement à refuser.
- API : ESM, erreurs `{error}` en français, validation serveur, `""` → NULL.
- Web : TS strict, styles dans `styles.css` uniquement, requêtes via `lib.ts`.
- Ne jamais committer `api/data/*.db*` ni `api/data/uploads/*`.
- Changer un port → mettre à jour `api/src/server.js`, `web/vite.config.ts`, `web/package.json`,
  `oauth-proxy/worker.mjs` (port web), `playwright.config.ts`, `README.md`, `README.fr.md`, `AGENTS.md`, `CLAUDE.md`, `docs/`.

## Commandes
`npm run install:all` · `npm run dev` · `npm start` · `npm test` · `npm run test:e2e` ·
`./scripts/check.sh` · `./scripts/backup.sh` · `./scripts/stop.sh`

## Pièges
Détaillés dans `docs/02-DEV.md` : migration V1→V2 et `legacy_alter_table`, index créés après
migration, `node:sqlite` expérimental, WAL, glisser-déposer HTML5 dans les tests, `screen` qui
meurt avec la session.
