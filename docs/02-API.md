# 🔌 WorkLogs — 02 Référence API

Base : `http://localhost:8410` · JSON partout · erreurs `{ "error": "<message fr>" }`.
Conventions : `GET` liste (200, tableau), `POST` (201, objet créé), `PUT/PATCH` (200, objet MAJ), `DELETE` (200 `{ok:true}`).
IDs opaques (ex. `pr_…`, `t_…`, `e_…`, `d_…`, `a_…`).

## Système
| Méthode | Route | Rôle | Exemple |
|---|---|---|---|
| GET | `/api/health` | ping | `curl -s localhost:8410/api/health` → `{"ok":true,"ts":"…"}` |
| GET | `/api/stats` | compteurs dashboard | → `{total,done,overdue,urgent,upcomingEvents,byStatus:{todo,in_progress,review,done}}` |
| GET | `/api/search?q=` | recherche LIKE (≥1 char, 80 max, 20/rubrique) | `/api/search?q=devis` → `{tasks,docs,events}` |

## Projets
| Méthode | Route | Body / notes |
|---|---|---|
| GET | `/api/projects` | triés par nom, + `open_tasks` (status != done) |
| POST | `/api/projects` | `{name!, pkey!, color?, description?}` — `pkey` uppercasé serveur |
| PUT | `/api/projects/:id` | partiel, mêmes champs |
| DELETE | `/api/projects/:id` | tâches détachées (`project_id` → NULL via FK) |

## Tâches
Filtres `GET /api/tasks` : `?project_id=&status=&priority=&type=&search=` (LIKE titre+description, `LIMIT 500`, tri `position, updated_at DESC`, joint `project_name,color`).

| Méthode | Route | Body |
|---|---|---|
| GET | `/api/tasks` | — |
| GET | `/api/tasks/:id` | + `attachments[]` |
| POST | `/api/tasks` | `{title!, project_id?, parent_id?, description?, status?∈STATUSES, priority?, type?, due_date? 'YYYY-MM-DD', estimate_h?, position?}` — `position` défaut = `MAX+1` du statut |
| PUT | `/api/tasks/:id` | partiel ; `""` → NULL pour `project_id/parent_id/due_date` |
| PATCH | `/api/tasks/:id/move` | `{status!, position!}` — **drag & drop kanban** ; décale la colonne cible puis pose |
| DELETE | `/api/tasks/:id` | supprime aussi fichiers disque liés |

Valeurs : `status ∈ todo|in_progress|review|done` · `priority ∈ low|medium|high|urgent` · `type ∈ task|bug|story|epic|subtask`.

## Agenda
| Méthode | Route | Body |
|---|---|---|
| GET | `/api/events?from=&to=` | ISO ; filtre `ends_at >= from AND starts_at <= to`, tri `starts_at`, `LIMIT 300`, joint `project_name` |
| POST | `/api/events` | `{title!, starts_at! ISO, ends_at! ISO, description?, task_id?, project_id?}` |
| PUT | `/api/events/:id` | partiel |
| DELETE | `/api/events/:id` | — |

## Docs
| Méthode | Route | Body |
|---|---|---|
| GET | `/api/docs?project_id=&task_id=&search=` | LIKE titre+contenu, tri `updated_at DESC`, `LIMIT 200` |
| POST | `/api/docs` | `{title!, content_md?, project_id?, task_id?}` |
| PUT | `/api/docs/:id` | partiel |
| DELETE | `/api/docs/:id` | — |

## Fichiers
| Méthode | Route | Body |
|---|---|---|
| POST | `/api/uploads` | **multipart** : champ `file!` + `project_id?/task_id?/doc_id?` (text fields). Stocké `<base36time>_<nom assaini>`, limite 100 Mo |
| GET | `/api/attachments?project_id=&task_id=&doc_id=` | tri `created_at DESC`, `LIMIT 300` |
| GET | `/api/files/:stored` | `Content-Disposition: attachment` (téléchargement, nom d'origine). 404 si ligne DB ou fichier absent |
| DELETE | `/api/attachments/:id` | supprime ligne + fichier disque (best effort) |

## Exemples curl (recette)
```bash
B=http://localhost:8410
curl -s $B/api/health
curl -s $B/api/stats
# tâche complète :
T=$(curl -s -X POST $B/api/tasks -H 'Content-Type: application/json' \
  -d '{"title":"Relire devis","project_id":"pr_pro","priority":"high","type":"task","due_date":"2026-09-20","estimate_h":1}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X PATCH $B/api/tasks/$T/move -H 'Content-Type: application/json' -d '{"status":"in_progress","position":0}'
curl -s -X PUT $B/api/tasks/$T -H 'Content-Type: application/json' -d '{"status":"done"}'
curl -s -X DELETE $B/api/tasks/$T
# event / doc / fichier :
curl -s -X POST $B/api/events -H 'Content-Type: application/json' -d '{"title":"Point hebdo","starts_at":"2026-09-12T10:00:00Z","ends_at":"2026-09-12T11:00:00Z"}'
curl -s -X POST $B/api/docs -H 'Content-Type: application/json' -d '{"title":"Note","content_md":"# hello"}'
echo coucou > /tmp/t.txt; curl -s -X POST $B/api/uploads -F "file=@/tmp/t.txt"
```
