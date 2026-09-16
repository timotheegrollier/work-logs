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

## Base — 6 tables (branche documents riches)

```sql
projects(id, name, color, created_at)

entries(id, title, content_md, content_json JSON|NULL, entry_date 'AAAA-MM-JJ',
        project_id → projects ON DELETE SET NULL, created_at, updated_at)

tasks(id, title, status ∈ {todo, doing, done}, due_date 'AAAA-MM-JJ'|NULL,
      pinned 0|1, position, project_id → projects ON DELETE SET NULL,
      created_at, updated_at)

task_entries(task_id → tasks ON DELETE CASCADE, entry_id → entries ON DELETE CASCADE,
             created_at, PRIMARY KEY(task_id, entry_id))

attachments(id, filename, stored, mime, size,
            entry_id → entries ON DELETE CASCADE, created_at)

google_documents(entry_id → entries ON DELETE CASCADE PRIMARY KEY,
                 document_id, tab_id DEFAULT '', revision_id, synced_content_json, synced_at,
                 document_title, tab_title, tab_order, tab_depth DEFAULT 0, readonly_reason,
                 UNIQUE(document_id, tab_id))
```

- **IDs** : chaînes `préfixe + base36(horodatage) + 6 aléatoires` (`en_`, `tk_`, `pr_`, `at_`).
- `entry_date` est une date pure, comparée en texte — pas de fuseau horaire, pas de surprise.
- `position` : ordre dans une colonne. Après chaque déplacement ou suppression, la colonne est
  **renumérotée 0,1,2…** (`renumber()` dans `app.js`) : jamais de trou ni de doublon.
- Supprimer un projet **détache** entrées et tâches (`SET NULL`), il ne les perd pas.
- Supprimer une entrée supprime ses pièces jointes, ses associations de tâches, les lignes
  `google_documents` associées et les fichiers disque. Cela ne supprime jamais le fichier Google.

`content_json` est une colonne TEXT nullable contenant le document riche sérialisé.
La migration est additive ; les entrées Markdown gardent NULL. Pour un document riche,
`content_md` contient le texte de recherche et le JSON fait autorité. `google_documents`
suit les révisions et le dernier contenu envoyé ; aucun jeton OAuth n’est stocké dans
SQLite. Supprimer une entrée locale ne supprime jamais le fichier Google.

`tab_depth` est ajouté par migration additive. Les entrées détaillées fournissent
`google_sync.tabs` (tous les onglets locaux du fichier, même sous un filtre),
`preserved_elements` et `tab_depth`. Les résumés ajoutent `google_dirty` et
`google_tab_depth`. `readonly_reason` identifie les anciens imports aplatis à recharger.

`google-preserve.js` importe tableaux/paragraphes et calcule des patches ciblés.
Les nœuds `googleInline`/`googleBlock` représentent les éléments natifs conservés ;
leurs identifiants ne servent jamais d’indices d’écriture. Les attributs sont validés
par `rich-document.js` et conservés par `web/src/google-content.ts`. Un verrou par
document sérialise les envois ; `requiredRevisionId` protège chaque batch Google.

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
| GET | `/api/state?q=&project_id=` | **tout l'écran en un appel** : projets, entrées (extrait seul), tâches avec `documents`, compteurs |
| GET | `/api/entries/:id` | l'entrée complète + ses pièces jointes |
| POST · PUT · DELETE | `/api/entries[/:id]` | créer · modifier · supprimer |
| POST | `/api/entries/:id/copy` | copie locale indépendante, fichiers compris |
| GET · POST | `/api/google/*` | état, configuration desktop, connexion, déconnexion, liste et ouverture |
| POST | `/api/google/documents` | crée un Google Docs nommé et son entrée locale associée |
| GET | `/api/google/documents/:id/tabs` | onglets, imbrication et compatibilité d’édition |
| POST | `/api/entries/:id/google/push` · `pull` | envoyer ou recharger avec contrôle de révision/brouillon |
| POST · PUT · DELETE | `/api/tasks[/:id]` | créer · modifier · supprimer |
| POST · DELETE | `/api/tasks/:id/documents/:entryId` | associer ou retirer une entrée (locale ou Google) |
| PATCH | `/api/tasks/:id/move` | `{status, position}` puis renumérotation |
| POST · PUT · DELETE | `/api/projects[/:id]` | créer · renommer/recolorer · supprimer |
| POST | `/api/uploads` | multipart `file` + `entry_id` (obligatoire) |
| GET · DELETE | `/api/files/:stored` · `/api/attachments/:id` | télécharger · supprimer |
| GET | `/api/export` | toute la base en JSON, associations `task_entries` incluses |

Conventions : erreurs `{"error": "…"}` en français, `400` pour une validation, `404` pour un
identifiant inconnu, `201` à la création. Un champ absent d'un `PUT` **n'est pas écrasé** ;
une chaîne vide vaut NULL.

`/api/state` est le cœur du front : une seule requête alimente les trois colonnes, et le front
la rejoue après chaque mutation. C'est ce qui permet à `App.tsx` de tenir en ~170 lignes. Chaque
tâche porte `documents`, un tableau de résumés `{id, title, entry_date, project_id, updated_at,
google_document_id, google_tab_id, google_document_title, google_tab_title}`. Le filtre
`project_id` filtre les tâches (et les entrées principales), mais pas les documents associés à
une tâche : ils restent son contexte, même s'ils appartiennent à un autre projet.

Les associations sont créées avec `POST /api/tasks/:id/documents/:entryId` : `201` à la première
création, puis `200` avec la ligne existante en cas de doublon. La suppression renvoie `200` ;
une tâche, une entrée ou une association inconnue renvoie `404` avec un message distinct.
`entryId` désigne aussi bien une entrée locale qu'un onglet Google importé.

## Front

| Fichier | Rôle |
|---|---|
| `App.tsx` | état global (`state`, recherche, projet, entrée ouverte, thème), en-tête, 3 colonnes |
| `lib.ts` | types, client API, helpers purs (`dayLabel`, `isOverdue`, `plainText`, `groupByDay`) |
| `markdown.ts` | `marked` (GFM, `breaks`) puis `DOMPurify` — le rendu part en `dangerouslySetInnerHTML` |
| `components/EntryList.tsx` | journal groupé par jour, extrait sur une ligne |
| `components/EntryEditor.tsx` | titre, date, projet, Écrire/Lire, enregistrement auto, pièces jointes |
| `components/RichEditor.tsx` | éditeur Tiptap et barre de mise en forme |
| `components/GoogleDrive.tsx` | dialogue Drive dédié, configuration et documents autorisés |
| `components/TaskBoard.tsx` | ajout rapide, 3 colonnes, glisser-déposer HTML5, édition en place, associations de documents |
| `components/ProjectBar.tsx` | pastilles de filtre + panneau de gestion repliable |
| `styles.css` | thèmes clair/sombre par variables, typographie du document, feuille d'impression |

`EntryEditor` est monté avec `key={entry.id}` : changer d'entrée remonte le composant, donc
un brouillon ne peut pas fuir d'une entrée à l'autre (test dédié dans `App.test.tsx`).

## Choix assumés
- **Un seul écran, pas de routeur** : tout ce qui ajouterait un onglet est à discuter avant.
- Pas d'authentification : usage mono-poste.
- Front : react, marked, dompurify, complétés par Tiptap et ses extensions approuvées.
- `node:sqlite` natif, synchrone : parfait en local, à ne pas exposer à du trafic.

Les erreurs Google peuvent ajouter `code` et `help_url` au champ français `error`.
La liste Drive remet les dernières sélections en tête, complète les fichiers absents
de l’index et renvoie `warnings` pour les autorisations perdues. L’ouverture accepte
`tab_id` ; le brouillon et la révision existants ne sont jamais écrasés par une réouverture.
