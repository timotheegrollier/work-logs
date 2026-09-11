# WorkLogs — règles agents (relève)

## Contexte
- App perso 100% locale : React+Vite+TS (`web/`) + Node+Express+SQLite natif (`api/`).
- Ports réservés : API **8410**, web **8411**. DB `api/data/worklogs.db` (non versionnée).
- Doc de référence : `docs/00-HANDOVER.md` (lire en premier), puis `docs/01..05`.

## Conventions obligatoires
- Petits diffs incrémentaux, jamais de refonte silencieuse ; une fonctionnalité = un test `curl` + `tsc` vert.
- Zéro nouvelle dépendance sans accord explicite (socle minimal volontaire).
- API : ESM, erreurs `{error}` en français, validation serveur, `""` → NULL pour FK/optionnels.
- Web : TS strict, formulaires string→conversion à l'envoi, `useRefresh` + `reload()` après mutation, styles dans `styles.css` uniquement.
- Ne jamais committer `api/data/*.db*` ni `api/data/uploads/*` (sauf `.gitkeep`).
- Ne pas toucher aux ports sans MAJ `web/vite.config.ts` + `README.md` + `docs/`.

## Commandes
- `npm run install:all` · `npm run dev` (8410+8411) · `npm run build` (tsc+vite) · `./scripts/check.sh` (recette) · `./scripts/backup.sh` (sauvegarde).
- Inspecter la DB via `python3` + `sqlite3` (pas de CLI `sqlite3` sur la machine).

## Pièges (détaillés dans `docs/03-GUIDE-DEV.md`)
`node:sqlite` expérimental (warning normal) · WAL `-wal/-shm` · INSERT tasks = 13 `?` · Vite 8 imposé par plugin-react 6 · `@types/node` requis par `tsconfig.node.json` · `screen` meurt avec la session `run_commands` (relancer au besoin).
