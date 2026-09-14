# 🏗️ WorkLogs — architecture

> Application desktop **publiée** (0.6.12) : [dossier technique](06-DESKTOP-CICD.md).
> Les ports fixes décrits ensuite concernent le web ; le desktop écoute sur un port éphémère.

## Application desktop

`desktop/main.mjs` lance une `BrowserWindow` et le serveur de `desktop/server.mjs`.
Celui-ci réutilise `createApp()`/`openDb()`, écoute sur 127.0.0.1 à un port éphémère et
exige un jeton aléatoire. Le protocole Electron `worklogs://app` relaie les requêtes avec
le `fetch` Node en ajoutant le jeton. Cette origine stable conserve le thème au redémarrage.
Le renderer utilise `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.

Le preload expose seulement `window.worklogsDesktop.onBeforeClose()`. La fermeture attend
`flushPendingSaves()` ; un échec garde la fenêtre ouverte. `web/src/autosave.ts` sérialise
les écritures et envoie le brouillon au changement d’entrée. Les sources et dépendances
API sont préparées dans `.desktop-app/`, puis empaquetées dans `release/`.

Données : `${XDG_DATA_HOME:-~/.local/share}/worklogs/` ; profil : `~/.config/worklogs/`.
`WORKLOGS_DATA_DIR` et `WORKLOGS_PROFILE_DIR` permettent les tests isolés. Pas d’import
automatique depuis la base web dans ce lot.

```
┌──────────────┐   fetch /api/*   ┌──────────────┐  node:sqlite  ┌──────────────┐
│  web  :8411  │ ───────────────▶ │  api  :8410  │ ────────────▶ │ worklogs.db  │
│ React + Vite │ ◀─────────────── │   Express    │               │  + uploads/  │
└──────────────┘      JSON        └──────────────┘               └──────────────┘
```
En production, `npm start` construit le front et l'API le sert elle-même : **une seule URL**
(`http://localhost:8410`). En développement, Vite proxifie `/api` vers `:8410`.

## Base — 4 tables

```sql
projects(id, name, color, created_at)

entries(id, title, content_md, entry_date 'AAAA-MM-JJ',
        project_id → projects ON DELETE SET NULL, created_at, updated_at)

tasks(id, title, status ∈ {todo, doing, done}, due_date 'AAAA-MM-JJ'|NULL,
      pinned 0|1, position, project_id → projects ON DELETE SET NULL,
      created_at, updated_at)

attachments(id, filename, stored, mime, size,
            entry_id → entries ON DELETE CASCADE, created_at)
```

- **IDs** : chaînes `préfixe + base36(horodatage) + 6 aléatoires` (`en_`, `tk_`, `pr_`, `at_`).
- `entry_date` est une date pure, comparée en texte — pas de fuseau horaire, pas de surprise.
- `position` : ordre dans une colonne. Après chaque déplacement ou suppression, la colonne est
  **renumérotée 0,1,2…** (`renumber()` dans `app.js`) : jamais de trou ni de doublon.
- Supprimer un projet **détache** entrées et tâches (`SET NULL`), il ne les perd pas.
  Supprimer une entrée supprime ses pièces jointes, lignes **et** fichiers disque.

### Migration V1 → V2
`migrate()` dans `db.js` s'exécute à l'ouverture si les tables V1 sont détectées, **sans perte** :
`docs` → entrées · `events` → entrées à leur date · descriptions de tâches → entrées
`en_<id>` · `in_progress`/`review` → `doing` · priorités `high`/`urgent` → épingle.

Deux points non évidents, couverts par `api/test/migration.test.js` :
1. `PRAGMA legacy_alter_table = ON` est **obligatoire** pendant la migration. Sans lui,
   `ALTER TABLE projects RENAME TO projects_v1` réécrit aussi les clauses `REFERENCES` des
   autres tables, qui se mettraient à pointer vers `projects_v1`.
2. Les index sont créés **après** la migration (constante `INDEXES`, séparée de `SCHEMA`) :
   `idx_attachments_entry` porte sur une colonne qui n'existe pas encore en V1.

## API

| Méthode | Route | Effet |
|---|---|---|
| GET | `/api/health` | `{ok, ts}` |
| GET | `/api/state?q=&project_id=` | **tout l'écran en un appel** : projets, entrées (extrait seul), tâches, compteurs |
| GET | `/api/entries/:id` | l'entrée complète + ses pièces jointes |
| POST · PUT · DELETE | `/api/entries[/:id]` | créer · modifier · supprimer |
| POST · PUT · DELETE | `/api/tasks[/:id]` | créer · modifier · supprimer |
| PATCH | `/api/tasks/:id/move` | `{status, position}` puis renumérotation |
| POST · PUT · DELETE | `/api/projects[/:id]` | créer · renommer/recolorer · supprimer |
| POST | `/api/uploads` | multipart `file` + `entry_id` (obligatoire) |
| GET · DELETE | `/api/files/:stored` · `/api/attachments/:id` | télécharger · supprimer |
| GET | `/api/export` | toute la base en JSON |

Conventions : erreurs `{"error": "…"}` en français, `400` pour une validation, `404` pour un
identifiant inconnu, `201` à la création. Un champ absent d'un `PUT` **n'est pas écrasé** ;
une chaîne vide vaut NULL.

`/api/state` est le cœur du front : une seule requête alimente les trois colonnes, et le front
la rejoue après chaque mutation. C'est ce qui permet à `App.tsx` de tenir en ~170 lignes.

## Front

| Fichier | Rôle |
|---|---|
| `App.tsx` | état global (`state`, recherche, projet, entrée ouverte, thème), en-tête, 3 colonnes |
| `lib.ts` | types, client API, helpers purs (`dayLabel`, `isOverdue`, `plainText`, `groupByDay`) |
| `markdown.ts` | `marked` (GFM, `breaks`) puis `DOMPurify` — le rendu part en `dangerouslySetInnerHTML` |
| `components/EntryList.tsx` | journal groupé par jour, extrait sur une ligne |
| `components/EntryEditor.tsx` | titre, date, projet, Écrire/Lire, enregistrement auto, pièces jointes |
| `components/TaskBoard.tsx` | ajout rapide, 3 colonnes, glisser-déposer HTML5, édition en place |
| `components/ProjectBar.tsx` | pastilles de filtre + panneau de gestion repliable |
| `styles.css` | thèmes clair/sombre par variables, typographie du document, feuille d'impression |

`EntryEditor` est monté avec `key={entry.id}` : changer d'entrée remonte le composant, donc
un brouillon ne peut pas fuir d'une entrée à l'autre (test dédié dans `App.test.tsx`).

## Choix assumés
- **Un seul écran, pas de routeur** : tout ce qui ajouterait un onglet est à discuter avant.
- Pas d'authentification : usage mono-poste.
- Dépendances front limitées à react, marked, dompurify.
- `node:sqlite` natif, synchrone : parfait en local, à ne pas exposer à du trafic.
