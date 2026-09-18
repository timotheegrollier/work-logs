# WorkLogs — règles agents

## Reprise actuelle — 2026-09-18
- **Aperçu des pièces jointes dans l'app** : `GET /api/files/:stored/preview` sert les mêmes
  octets en `inline` (le téléchargement `attachment` ne bouge pas) ; le dialogue `FileViewer`
  affiche images, PDF et texte dans l'entrée, annonce franchement les tableurs (`.xlsx`, `.ods`)
  et laisse toujours **Télécharger**. Service worker PWA aligné. Aucune dépendance ajoutée.
  `./scripts/check.sh` vert : **128 API, 166 front, 33 desktop unitaires, 24 scripts,
  27 navigateur et 10 desktop e2e**. Bilan dans `docs/00-HANDOVER.md`,
  pourquoi dans `05-DECISIONS.md` §15.

## Reprise précédente — 2026-09-17
- **v0.19.0** : plusieurs documents par tâche et cartes repensées ; lot PWA mobile parité
  Google Docs. Liens `task_entries` et `google_documents` restaurés de façon transactionnelle ;
  aucune dépendance ajoutée. Bilan dans `docs/00-HANDOVER.md`, publication via `docs/07-RELEASES.md`.

## Reprise actuelle — 2026-09-15
- Lot terminé et **publié en v0.12.0** : **éditeur Google Docs natif dans WorkLogs**
  (branche `codex/google-docs-integrated-editor`, mergée), plus le réglage de largeur
  des colonnes ajouté par Timo dans le même train.
  La vraie page Google s'affiche dans la colonne centrale (`desktop/google-view.mjs`,
  `WebContentsView` isolée) ; `api/src/google-merge.js` réconcilie les corrections
  indépendantes. Bilan en tête de `docs/08-GOOGLE-DOCS.md`, pourquoi en `05-DECISIONS.md` §14.
  Aucune dépendance ajoutée. `./scripts/check.sh` vert : **270 tests**.
  Connexion d'un compte Google *dans la vue intégrée* : **vérifiée par Timo le 15/09**.
  **Ne jamais déguiser l'`userAgent`** si Google referme ce chemin : c'est un contrôle de
  sécurité du fournisseur ; consigner le refus à la place.
- **Deux courses e2e non élucidées** du 15/09 restent ouvertes (celle du plan est
  corrigée avec test déterministe et sans retry le 16/09) :
  détail, mesures déjà faites et hypothèses **infirmées** dans `docs/00-HANDOVER.md`
  § « Ce qui reste à faire », point 0. Ne pas relancer la CI en boucle pour les masquer.
- Lot précédent publié : **v0.10.0** (navigation verticale et synchronisation ciblée).

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
