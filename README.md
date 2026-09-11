# WorkLogs — cockpit perso (Trello × Jira × Todo × Agenda × Drive/Docs)

Centralise tâches, avancement, agenda, docs et fichiers au même endroit.
Stack 100% locale, sans cloud : **React + Vite + TypeScript** (front) + **Node + Express + SQLite** (API, `node:sqlite` natif — zéro compilation).

> 🆕 **Tu prends le relais (humain ou agent) ?** Commence par **`docs/00-HANDOVER.md`** (fiche de relève, 5 min), puis `AGENTS.md` (règles).

## Démarrage rapide (Linux Mint / Debian)

```bash
cd /home/timo/WorkLogs

# 1) tout installer (racine + api + web)
npm run install:all

# 2) lancer API (port 8410) + Web (port 8411)
npm run dev
# ou : ./scripts/dev.sh

# Web  → http://localhost:8411
# API  → http://localhost:8410/api/health
```

Services déjà lancés sur cette machine (sessions `screen`) :
- `wl-api` → API :8410 · `screen -r wl-api` pour voir, `./scripts/stop.sh` pour arrêter
- `wl-web` → Web :8411 (`npm run dev`) · `screen -r wl-web`

Scripts racine : `npm run dev`, `npm run dev:api`, `npm run dev:web`, `npm run build`.
Utilitaires : `./scripts/check.sh` (recette complète), `./scripts/backup.sh` (sauvegarde DB+uploads), `./scripts/stop.sh`.

## Documentation
| Doc | Pour qui | Contenu |
|---|---|---|
| `docs/00-HANDOVER.md` | **tous (lire en 1er)** | fiche de relève : état, reprise en 3 commandes, check-list |
| `docs/01-ARCHITECTURE.md` | agents/dev | schéma DB, flux, choix assumés |
| `docs/02-API.md` | agents/dev | référence REST + exemples curl |
| `docs/03-GUIDE-DEV.md` | agents/dev | install, conventions, pièges, recette |
| `docs/04-GUIDE-UTILISATEUR.md` | Timo | usage quotidien des 7 onglets + rituel |
| `docs/05-ROADMAP-V2.md` | Timo + agents | lots V2 chiffrés + dette technique |
| `AGENTS.md` | agents | règles courtes (conventions, interdits, commandes) |

## Fonctionnalités V1
- **Dashboard** : stats (par statut, urgentes, en retard, agenda 7j), ajout rapide.
- **Projets** : CRUD, code clé (ex. `PERSO`), couleur.
- **Kanban** : colonnes À faire / En cours / Revue / Terminé, drag & drop natif, filtres projet/priorité/recherche, création/édition complète (type Jira : task/bug/story/epic/subtask, priorité, échéance, estimation).
- **Todos** : inbox rapide, check/uncheck, échéances, priorités, suppression.
- **Agenda** : événements liés optionnellement à tâche/projet, vue 7 jours + liste.
- **Docs** : notes Markdown liées à projet/tâche, aperçu simple.
- **Fichiers** : upload local (`api/data/uploads`), liaison tâche/projet/doc, téléchargement/suppression.

## API REST
`GET /api/health` · `/api/stats` · `/api/search?q=`
CRUD : `/api/projects` · `/api/tasks` (filtres `?project_id=&status=&priority=&type=&search=`) · `PATCH /api/tasks/:id/move` `{status,position}` · `/api/events` (`?from=&to=`) · `/api/docs`
Fichiers : `POST /api/uploads` (multipart `file` + `project_id/task_id/doc_id`) · `GET /api/attachments` · `GET /api/files/:stored` · `DELETE /api/attachments/:id`
→ détail + exemples : `docs/02-API.md`.

Données : `api/data/worklogs.db` (SQLite, non versionnée), fichiers : `api/data/uploads/` (non versionnés).

## Roadmap V2
Sprints + vélocité (lot B recommandé en premier), Gantt/rappels, FTS5 + export/import, PWA offline, Docker → voir `docs/05-ROADMAP-V2.md`.


## Fonctionnalités V1
- **Dashboard** : stats (par statut, urgentes, en retard, agenda 7j), ajout rapide.
- **Projets** : CRUD, code clé (ex. `PERSO`), couleur.
- **Kanban** : colonnes À faire / En cours / Revue / Terminé, drag & drop natif, filtres projet/priorité/recherche, création/édition complète (type Jira : task/bug/story/epic/subtask, priorité, échéance, estimation).
- **Todos** : inbox rapide, check/uncheck, échéances, priorités, suppression.
- **Agenda** : événements liés optionnellement à tâche/projet, vue 7 jours + liste.
- **Docs** : notes Markdown liées à projet/tâche, aperçu simple.
- **Fichiers** : upload local (`api/data/uploads`), liaison tâche/projet/doc, téléchargement/suppression.

## API REST
`GET /api/health` · `/api/stats` · `/api/search?q=`
CRUD : `/api/projects` · `/api/tasks` (filtres `?project_id=&status=&priority=&type=&search=`) · `PATCH /api/tasks/:id/move` `{status,position}` · `/api/events` (`?from=&to=`) · `/api/docs`
Fichiers : `POST /api/uploads` (multipart `file` + `project_id/task_id/doc_id`) · `GET /api/attachments` · `GET /api/files/:stored` · `DELETE /api/attachments/:id`

Données : `api/data/worklogs.db` (SQLite), fichiers : `api/data/uploads/`.

## Roadmap V2
Auth multi-user, sprints/velocity Jira, Gantt, rappels, sync CalDAV/Google, recherche full-text FTS5, export/import, PWA offline, Docker.
