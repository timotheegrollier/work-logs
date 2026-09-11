# 🏗️ WorkLogs — 01 Architecture

## Vue d'ensemble
```
┌──────────────┐      fetch /api/*      ┌──────────────┐      node:sqlite      ┌──────────────┐
│  WEB :8411   │ ─────────────────────▶ │  API :8410   │ ────────────────────▶ │ worklogs.db  │
│ React+Vite   │ ◀───────────────────── │ Express      │                      │  + uploads/  │
│ (dev: proxy  │        JSON            │ (CORS open,  │                      └──────────────┘
│  /api→:8410) │                        │  JSON 5 Mo)  │
└──────────────┘                        └──────────────┘
```
- **Aucune dépendance externe au runtime** : pas de Docker, pas de Postgres, pas de Redis.
- **SQLite via `node:sqlite` natif** (Node ≥ 22.5, ici v24) : module `DatabaseSync`, **synchrone**, expérimental (warning au boot, normal).
- **IDs** : chaînes `uid(prefix)` = `prefix + base36(timestamp) + 6 chars aléatoires` (ex. `t_mtx2wonqru8wp8`). Pas d'AUTOINCREMENT → fusion/export futurs faciles.

## Backend — `api/src/`
| Fichier | Rôle | Points d'attention |
|---|---|---|
| `db.js` | Ouvre/crée `data/worklogs.db`, `PRAGMA journal_mode=WAL; foreign_keys=ON`, `CREATE TABLE IF NOT EXISTS` ×5 + 3 index, seed si `projects` vide | Le seed ne tourne qu'une fois (garde `tableEmpty`). Pour reseed : supprimer `data/worklogs.db*` puis relancer. |
| `server.js` | ~254 lignes : middlewares, helpers (`STATUSES`, `asInt`, `notFound`), routes, `app.listen(PORT)` | `PORT` via env (défaut 8410). `UPLOAD_DIR` via env ou `data/uploads`. Multer 1.x (warning dépréciation connu, OK en local). |

### Schéma (5 tables)
```sql
projects(id PK, name!, pkey!, color, description, created_at!)
tasks(id PK, project_id→projects SET NULL, parent_id→tasks CASCADE,
      title!, description, status∈{todo,in_progress,review,done} DEFAULT todo,
      priority∈{low,medium,high,urgent} DEFAULT medium,
      type∈{task,bug,story,epic,subtask} DEFAULT task,
      due_date TEXT 'YYYY-MM-DD'|NULL, estimate_h REAL|NULL,
      position INT DEFAULT 0, created_at!, updated_at!)
events(id PK, title!, description, starts_at! ISO, ends_at! ISO,
       task_id→tasks SET NULL, project_id→projects SET NULL, created_at!)
docs(id PK, title!, content_md, project_id→projects SET NULL,
     task_id→tasks CASCADE, created_at!, updated_at!)
attachments(id PK, filename!, stored! (nom disque), mime, size,
            project_id SET NULL, task_id CASCADE, doc_id SET NULL, created_at!)
```
- Dates stockées en **TEXT ISO** (`toISOString()`), comparaisons lexicographiques OK pour `due_date` (`YYYY-MM-DD`) et `starts_at`.
- `position` : ordre manuel **par colonne de statut** (pas global). `POST /tasks` calcule `MAX(position)+1` **dans le statut cible**.
- `PATCH /tasks/:id/move` : décale `position+1` les cartes ≥ position cible **dans la colonne d'arrivée**, puis pose la carte. Pas de re-normalisation (trous possibles, sans gravité).
- Suppressions : `DELETE /tasks/:id` efface aussi les fichiers disque liés ; `DELETE /attachments/:id` efface le fichier disque.

## Frontend — `web/src/`
| Fichier | Rôle |
|---|---|
| `main.tsx` | bootstrap React `StrictMode` |
| `App.tsx` | layout sidebar + `GlobalSearch`, état `projects` + `tick` (reload), routage par onglets **sans router** (`Tab` union) |
| `lib.ts` | types TS (`Project/Task/WLEvent/Doc/Attachment/Stats`), client `api` (fetch + erreurs `{error}`), constantes `COLUMNS/PRIOS/TYPES`, helpers `fmtDate/isOverdue/prioColor/typeIcon` |
| `components/ui.tsx` | `useRefresh(fn, deps)` (fetch+loading+error+reload), `Modal` (Échap + stopPropagation), `GlobalSearch` (debounce 250 ms, ≥2 chars), `md()` mini-Markdown **sans lib** |
| `components/TaskModal.tsx` | formulaire création/édition tâche (`TaskForm` tout-string, conversion `estimate_h` à l'envoi) |
| `pages/Dashboard.tsx` | stats + ajout rapide + listes retard/prio/agenda 7j |
| `pages/Kanban.tsx` | colonnes, **drag & drop natif HTML5** (`dataTransfer 'text/task-id'`), filtres, fiche détail |
| `pages/Todos.tsx` | inbox check/uncheck (`PUT status`) |
| `pages/Agenda.tsx` | groupe par jour `starts_at.slice(0,10)`, `EventModal` (`datetime-local` → ISO) |
| `pages/Docs.tsx` | maître/détail, éditeur Markdown brut + aperçu `md()` |
| `pages/Projects.tsx` | CRUD projets + page `Files` (upload `FormData`, filtre projet→tâches) |
| `styles.css` | design sombre, variables CSS, responsive 1000/640 px |

### Flux de données type (kanban)
1. `Kanban` charge `api.tasks({project_id, priority, search})`.
2. Drop → `api.moveTask(id, status, col.length)` → `list.reload()` + `reloadAll()` (remonte `tick` → recharge projets).
3. `App.tick` ne recharge que les **projets** ; chaque page recharge ses propres listes via `useRefresh`.

## Config & ports
| Élément | Valeur | Fichier |
|---|---|---|
| API | `:8410` | `api/src/server.js` (`process.env.PORT`), `web/vite.config.ts` (proxy) |
| Web dev | `:8411` | `web/package.json` (`vite --port`), `vite.config.ts` |
| DB | `api/data/worklogs.db` | `api/src/db.js` (`DB_PATH`/`DATA_DIR` env overridables) |
| Uploads | `api/data/uploads/` | `server.js` (`UPLOAD_DIR` env overridable), limite 100 Mo |

## Choix assumés (ne pas « corriger » sans discussion)
- Pas de React Router / TanStack Query / DnD-kit / lib Markdown : **zéro dépendance front** hors React, pour rester lisible et installable en 5 s.
- Pas d'auth : usage mono-poste. L'ajouter = voir `05-ROADMAP-V2.md` lot A.
- CORS ouvert + JSON 5 Mo : suffisant en localhost.
