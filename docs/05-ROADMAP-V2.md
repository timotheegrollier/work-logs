# 🗺️ WorkLogs — 05 Roadmap V2 (lots prêts à confier)

Ordre suggéré : B → C → A → D → E. Chaque lot = spec + critères d'acceptation.
Règle : un lot à la fois, `check.sh` vert avant/après, MAJ de `docs/` dans le même diff.

## Lot A — Comptes & partage local (2–3 j)
- Auth simple (1 user + PIN ou login/mot de passe, session cookie httpOnly) OU rester mono-user + profils (`?profil=timo`).
- Si multi-user : ajouter `users(id, name, pass_hash)` + `owner_id` sur tasks/docs/events ; middleware session ; page login.
- Acceptation : sans login → 401 sur `/api/*` (sauf `/health`) ; backup inchangé.

## Lot B — Sprints Jira + vélocité (2 j) ⭐ prochain recommandé
- Table `sprints(id, project_id, name, goal, start, end, status)` + `sprint_id` sur tasks.
- UI Kanban : sélecteur « Backlog / Sprint N » + bouton « Clôturer » (reporte les non-done).
- Dashboard : vélocité (points `estimate_h` done par sprint, 6 derniers).
- Acceptation : créer/clôturer un sprint, vélocité affichée, `check.sh` vert.

## Lot C — Gantt & rappels (2 j)
- Vue Agenda « Timeline » (barres `due_date`/`starts_at→ends_at`, 30 j, pur CSS/SVG sans lib).
- Rappels : champ `remind_at` sur tasks/events + badge dashboard « À rappeler » (poll 60 s, pas de push).
- Acceptation : une tâche en retard + un event imminent remontent avec badge.

## Lot D — Recherche & import/export (1–2 j)
- FTS5 (`tasks_fts`, `docs_fts`, triggers) + `GET /api/search?q=` qui l'utilise (fallback LIKE).
- Export JSON complet (`GET /api/export`) + import (`POST /api/import`, upsert par id) ; boutons Dashboard.
- Acceptation : `kanban` retrouve le doc « Bienvenue » ; export→reset→import = données identiques.

## Lot E — PWA offline + Docker (2 j)
- PWA : `vite-plugin-pwa`, cache app-shell, file d'attente (outbox IndexedDB → rejouée au retour réseau).
- Docker : `Dockerfile` api + `Dockerfile` web + `compose.yml` (volumes `data/`, ports 8410/8411), profil `prod` (web servi en statique + proxy /api).
- Acceptation : `docker compose up` → mêmes URLs ; mode avion → lecture + création en attente.

## Idées V2+ (non chiffrées)
Kanban : WIP limits, swimlanes par projet, sous-tâches `parent_id` exposées ; Agenda : CalDAV/Google sync (ics d'abord) ; Fichiers : prévisualisation PDF/image ; Docs : éditeur split temps réel, pièces jointes `doc_id` ; Projets : archivage, favoris ; Thème clair/sombre ; `.deb`/lanceur Mint.

## Dette technique à résorber avant d'empiler
1. Multer 1.x → 2.x (breaking : revoir `storage`/`limits`).
2. Normaliser `position` après `move` (endpoint de maintenance `POST /api/maintenance/reorder`).
3. Tests : ajouter `node --test` API (CRUD + move + upload) et `tsc`+`build` en CI locale (`check.sh` en pre-push).
4. `GET /api/tasks/:id` : joindre aussi `project_color` (comme la liste) pour la fiche détail.
5. `DELETE /docs/:id` : décider du sort des `attachments.doc_id` (aujourd'hui orphelins si liés à un doc).
