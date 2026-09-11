# 🛠️ WorkLogs — 03 Guide développeur

## Prérequis
Linux Mint 22.3 / Debian · **Node v24.13.0**, npm 11.6.2 · aucun autre service requis.
Vérifier : `node -v && npm -v && ss -tlnp | grep -E '8410|8411' || echo "ports libres"`.

## Installation / lancement
```bash
cd /home/timo/WorkLogs
npm run install:all   # installe racine + api + web
npm run dev           # concurrently : API :8410 + Web :8411
# ciblé :
npm run dev:api       # cd api && node --watch src/server.js (PORT=8410)
npm run dev:web       # cd web && vite --port 8411 (proxy /api → :8410)
npm run build         # cd web && tsc -b && vite build  (référence qualité)
npm run start:api     # prod-like API sans watch
```

## Scripts utilitaires (`scripts/`)
| Script | Usage | Fait quoi |
|---|---|---|
| `dev.sh` | `./scripts/dev.sh` | `npm run dev` depuis la racine |
| `check.sh` | `./scripts/check.sh` | health API, stats (python3 ou node), `tsc -b`, `vite build`, rappel seed |
| `stop.sh` | `./scripts/stop.sh` | stoppe les sessions `screen` wl-api/wl-web |
| `backup.sh` | `./scripts/backup.sh [dir]` | `VACUUM INTO` + copie `uploads/` horodatée dans `~/WorkLogs-backups/` (défaut) |

Tous exécutables (`chmod +x`). Les lancer depuis la racine.

## Conventions de code (obligatoires)
- **Petits diffs** : un endpoint ou un composant à la fois ; jamais de refonte silencieuse.
- **Pas de nouvelle dépendance** sans accord : le socle est volontairement minimal (express, multer, cors / react, vite). Préférer le natif (HTML5 DnD, fetch, `node:sqlite`).
- **API** : ESM (`"type":"module"`), réponses `{error}` en français, validation `title/status` côté serveur, `""` → NULL pour les FK/optionnels.
- **Web** : TS strict (`noUnusedLocals/Parameters`), formulaires en `string` puis conversion à l'envoi (`estimate_h`), dates `YYYY-MM-DD` (tâches) vs ISO (events), `useRefresh` pour tout fetch avec `reload()` explicite après mutation.
- **Styles** : `styles.css` uniquement (variables `--bg/--panel/--acc…`), pas de framework CSS.
- **Ports 8410/8411 réservés** : tout changement → MAJ `vite.config.ts` + `README` + `docs/00`.

## Base de données au quotidien
```bash
# inspecter (python, pas de CLI sqlite3 sur cette machine) :
python3 - <<'EOF'
import sqlite3
c = sqlite3.connect('/home/timo/WorkLogs/api/data/worklogs.db')
for r in c.execute("SELECT status, COUNT(*) FROM tasks GROUP BY status"): print(r)
EOF
# reseed complet : rm api/data/worklogs.db*  puis relancer l'API (seed auto)
# backup : ./scripts/backup.sh
# vars d'env supportées : PORT, DATA_DIR, DB_PATH, UPLOAD_DIR
```

## Pièges connus (lus = 1h gagnée)
1. **`node:sqlite` expérimental** : warning `ExperimentalWarning: SQLite…` au boot = normal. API synchrone bloquante → OK en local, ne pas y mettre du trafic prod.
2. **WAL** : `worklogs.db-wal/-shm` apparaissent en cours d'usage ; ne pas les supprimer à chaud, ne pas les versionner (déjà ignorés).
3. **INSERT tasks** : 13 colonnes = **13 `?`** (bug réel corrigé le 2026-09-11 : il en manquait un → `Error: 12 values for 13 columns`).
4. **Vite 8 + plugin-react 6** : `vite@^8.0.9` imposé (la 6.x casse `peer vite ^8`). Ne pas downgrader sans fixer le plugin.
5. **`tsconfig.node.json` exige `@types/node`** (devDep web) malgré `types` restreints — le retirer casse `tsc -b`.
6. **Multer 1.x** : warning `deprecated … upgrade to 2.x` à l'install = connu, acceptable en local.
7. **`screen` + `run_commands`** : les lancements background meurent avec la commande ; passer par `screen -dmS` (comme fait pour wl-api/wl-web) ou un terminal. Au reboot : tout relancer.
8. **Kanban `position`** : ordre par colonne uniquement ; les trous/doublons après `move` sont tolérés (tri `position, updated_at`).
9. **`due_date` vs `starts_at`** : `YYYY-MM-DD` (tâche, comparée en string) vs ISO complet (event, `new Date()` côté front). Ne pas mélanger les formats.
10. **Proxy Vite** : le front appelle `/api/…` en relatif ; en `preview`/prod sans proxy il faut servir l'API sur la même origine ou ajuster `lib.ts`.

## Recette avant de dire « c'est fini »
```bash
./scripts/check.sh
# + manuel : http://localhost:8411
#   dashboard: ajout rapide → apparaît en Todos
#   kanban: créer → drag vers En cours → fiche détail → terminer
#   agenda: créer event → visible 7j · docs: créer → aperçu · fichiers: upload → download → suppression
```
