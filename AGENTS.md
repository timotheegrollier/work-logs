# WorkLogs — règles agents

## Reprise actuelle — 2026-09-15
- Lot en cours : **éditeur Google Docs natif dans WorkLogs**, branche
  `codex/google-docs-integrated-editor`, sur les sources 0.10.0. Pas encore mergé.
  La vraie page Google s'affiche dans la colonne centrale (`desktop/google-view.mjs`,
  `WebContentsView` isolée) ; `api/src/google-merge.js` réconcilie les corrections
  indépendantes. Bilan en tête de `docs/08-GOOGLE-DOCS.md`, pourquoi en `05-DECISIONS.md` §14.
  Aucune dépendance ajoutée. `./scripts/check.sh` vert : **262 tests**.
  **⚠ Non prouvé :** la connexion d'un compte Google réel *dans la vue intégrée*. Google
  refuse ses pages de connexion en navigateur embarqué. **Ne pas déguiser l'`userAgent`**
  pour contourner ce contrôle ; consigner le résultat de la recette à la place.
- Lot précédent terminé et publié : **v0.10.0 sur master** (navigation verticale et
  synchronisation ciblée Google Docs). CI master verte.

## Repères précédents — 2026-09-14
- Lot en cours : **éditeur riche intégré + Google Drive facultatif**, branche
  `codex/rich-editor-drive`. Lire `docs/08-GOOGLE-DOCS.md` pour le périmètre,
  le diagnostic Google résolu, la recette réelle validée et les limites restantes.
- **Tiptap 3.31.3 approuvé explicitement** : core, react, pm, starter-kit,
  extension-table, extension-image, extension-text-align, extension-text-style,
  extension-highlight. Ne pas redemander cet accord.
- Dernière release vérifiée : **v0.10.0 publiée** (DEB/RPM/AppImage + SHA256 + attestation).
  Process : `docs/07-RELEASES.md` (fast path ~2 min, notes anglaises auto).
- Nouveau lot sans bump/release : création directe de Google Docs, choix d’onglet,
  diagnostic API, recherche/remplacement et éditeur enrichi. Bilan : `docs/08-GOOGLE-DOCS.md`.
- `./scripts/check.sh` reste la validation requise (desktop compris).
- Electron **44.3.0** et electron-builder **26.15.3** : ajout explicitement approuvé.
  Ne pas redemander cet accord ; les autres ajouts restent soumis aux règles ci-dessous.
- Dependabot : jsdom 30, TS 7, types/node 26, concurrently 10 mergés ; **Express reste
  en 4** (la 5 casse les téléchargements — voir `07-RELEASES.md` §8).
- Recette manuelle sur vraie session desktop toujours à faire un jour (icône, dialogue
  « Enregistrer sous », Ctrl+P, persistance).

## Contexte
- Journal de travail perso, local par défaut avec Drive facultatif en desktop,
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
  react, marked, dompurify. Tests : node:test, vitest, playwright.
- Rester simple : toute nouveauté qui ajoute un onglet ou un mode est probablement à refuser.
- API : ESM, erreurs `{error}` en français, validation serveur, `""` → NULL.
- Web : TS strict, styles dans `styles.css` uniquement, requêtes via `lib.ts`.
- Ne jamais committer `api/data/*.db*` ni `api/data/uploads/*`.
- Changer un port → mettre à jour `web/vite.config.ts`, `playwright.config.ts`, `README.md`, `README.fr.md`, `docs/`.

## Commandes
`npm run install:all` · `npm run dev` · `npm start` · `npm test` · `npm run test:e2e` ·
`./scripts/check.sh` · `./scripts/backup.sh` · `./scripts/stop.sh`

## Pièges
Détaillés dans `docs/02-DEV.md` : migration V1→V2 et `legacy_alter_table`, index créés après
migration, `node:sqlite` expérimental, WAL, glisser-déposer HTML5 dans les tests, `screen` qui
meurt avec la session.
