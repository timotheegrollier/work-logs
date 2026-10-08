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

## PWA statique (mobile, sans serveur)

Le même `web/dist/` (base relative `./`, donc rejouable à la racine comme dans
un sous-dossier) est publié **à la racine** de gh-pages par le workflow `PWA`
(`.github/workflows/pwa.yml`) : la PWA est donc disponible à la racine du site,
et les dépôts Linux restent isolés dans `/deb/` et `/rpm/`. Le workflow partage
son groupe de concurrence `gh-pages` avec « Dépôts » : les deux poussent sur la
même branche sans toucher aux chemins de l'autre. Contenu PWA : `index.html`,
`manifest.webmanifest`, icônes 256/512 (`web/public/icons/`, dérivées de
`desktop/icons/`) et `sw.js` émis au build (`scripts/emit-sw.mjs`, version =
paquet racine, testé dans `scripts/pwa-sw.test.mjs`).

Le service worker (`web/src/sw-template.js`) met en cache la coquille et les
ressources même origine, **jamais `/api/`** ; les navigations sont réseau
d'abord avec repli hors-ligne, et le changement de version purge l'ancien
cache (`skipWaiting` + `clients.claim` : mise à jour transparente). Il ne
s'enregistre qu'en production sur http(s) — jamais sur `worklogs://` ni en dev.
Les données locales (IndexedDB) et la connexion directe à Google (client OAuth
« Web », lots suivants) n'ont besoin d'aucun serveur.

## Base — 6 tables synchronisées + 4 tables de la machine

```sql
projects(id, name, color, created_at)

entries(id, title, content_md, content_json JSON|NULL, entry_date 'AAAA-MM-JJ',
        project_id → projects ON DELETE SET NULL, archived 0|1 DEFAULT 0,
        kind ∈ {'note','procedure'} DEFAULT 'note', created_at, updated_at)

tasks(id, title, status ∈ {todo, doing, done}, due_date 'AAAA-MM-JJ'|NULL,
      pinned 0|1, position, priority ∈ {low, normal, high} DEFAULT 'normal',
      project_id → projects ON DELETE SET NULL, created_at, updated_at)

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

### Tables de cette machine (dossier partagé, §25)

```sql
local_settings(key PRIMARY KEY, value, updated_at)      -- shared.root, shared.fs_type…
shared_project_folders(project_id PRIMARY KEY, rel_dir, updated_at)
shared_files(rel_path PRIMARY KEY, base_hash, seen_hash, seen_size, seen_mtime_ms,
             template_hash, draft_json, draft_updated_at, send_hash, send_requested,
             send_started_at, state, note, theirs_hash, theirs_deleted,
             lock_nonce, lock_renewed_at, updated_at)
shared_versions(id PRIMARY KEY, rel_path, hash, size, origin, state, author, created_at)
                                                         -- origin : base|mine|theirs|restored|merged
shared_dirs(rel_dir PRIMARY KEY, entries_json, listed_at) -- dernière liste vue (arbre hors ligne)
```

**Aucune clé étrangère** : `restoreBackup` vide et réinsère projets et entrées à chaque synchro.
Jamais exportées ni synchronisées. `base_hash` = version que le brouillon remplacera ;
`seen_hash` = dernière version vue sur le partage ; `template_hash` = octets dont part le
brouillon ; `send_hash` = octets dont l'envoi est demandé. Les octets vivent dans
`<données>/shared-blobs/aa/<sha256>`.

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
| GET | `/api/state?q=&project_id=` | **tout l'écran en un appel** : projets, entrées (extrait seul, avec `kind`), tâches avec `documents`, pièces jointes des procédures du filtre, compteurs |
| GET | `/api/entries/:id` | l'entrée complète + ses pièces jointes |
| POST · PUT · DELETE | `/api/entries[/:id]` | créer · modifier · supprimer |
| POST | `/api/entries/:id/task` | crée une tâche `todo` et la lie atomiquement à l’entrée |
| POST | `/api/entries/:id/copy` | copie locale indépendante, fichiers compris |
| GET · POST | `/api/google/*` | état, configuration desktop, connexion, déconnexion, liste et ouverture |
| POST | `/api/google/documents` | crée un Google Docs nommé et son entrée locale associée |
| GET · POST | `/api/google/backup/list`, `/api/google/backup/export` | liste ou enregistre un JSON WorkLogs dans Drive |
| GET · POST | `/api/google/backup/:id`, `/:id/import` | lit ou restaure une sauvegarde après validation transactionnelle |
| GET | `/api/google/documents/:id/tabs` | onglets, imbrication et compatibilité d’édition |
| POST | `/api/entries/:id/google/push` · `pull` | envoyer ou recharger avec contrôle de révision/brouillon |
| POST · PUT · DELETE | `/api/tasks[/:id]` | créer · modifier · supprimer |
| POST · DELETE | `/api/tasks/:id/documents/:entryId` | associer ou retirer une entrée (locale ou Google) |
| PATCH | `/api/tasks/:id/move` | `{status, position}` puis renumérotation |
| POST · PUT · DELETE | `/api/projects[/:id]` | créer · renommer/recolorer · supprimer |
| POST | `/api/uploads` | multipart `file` + `entry_id` (obligatoire) |
| GET | `/api/files/:stored` | télécharger (`Content-Disposition: attachment`, nom RFC 6266) |
| GET | `/api/files/:stored/preview` | afficher dans l’app : mêmes octets, `inline` + type enregistré |
| DELETE | `/api/attachments/:id` | supprimer la ligne et le fichier disque |
| GET | `/api/export` | toute la base en JSON : tâches, associations, liens Google et métadonnées de pièces jointes |
| GET | `/api/shared/status` | dossier partagé : `available`, racine, montage, `reach` (`ok`, `offline`, `unmounted`, `blocked`, `unconfigured`), envois en attente, conflits |
| GET | `/api/shared/list?dir=` | un niveau du partage : fichiers, dossiers, verrous lus, état local ; hors ligne `503` + fichiers gardés ici |
| GET | `/api/shared/file?path=` · `/api/shared/content?hash=` | métadonnées et brouillon · octets d'une version du magasin local |
| PUT | `/api/shared/draft?path=` | brouillon local (modèle JSON) ; ne touche jamais le partage |
| POST | `/api/shared/draft/discard?path=` | abandonne le brouillon, ses octets restent dans l'historique |
| POST | `/api/shared/push?path=&base=` | envoi gardé des octets : `200 written` · `202 pending/offline/interrupted` · `409 SHARED_CONFLICT` |
| POST | `/api/shared/resolve` | `{path, choice: mine\|theirs\|both, theirs}` |
| GET · PUT | `/api/shared/versions?path=` · `/api/shared/settings` | historique local · nom affiché |
| POST | `/api/shared/merge?path=&theirs=` (octets) | « Fusionner » un conflit : la version réunie part avec la leur pour base (envoi gardé) |
| POST | `/api/shared/create?path=` (octets) | fichier neuf (modèle fait par le front), création exclusive : `409 SHARED_EXISTS` si le nom est pris |
| DELETE | `/api/shared/file?path=` | supprime un fichier du partage, gardé sur la dernière version vue : `409 SHARED_STALE` s'il a changé, refusé avec un brouillon, un envoi en attente ou un verrou d'un autre |
| POST | `/api/shared/dir?path=` | dossier neuf : `201`, `409 SHARED_EXISTS` si le nom est pris (dossier ou fichier) |
| POST | `/api/shared/dir/rename?path=` | `{name}` : renomme au même endroit, sans rien remplacer ; les lignes locales suivent ; refusé (`409`) avec un brouillon, un envoi, un conflit ou un verrou d'un autre dans le dossier |
| GET | `/api/shared/dir?path=` | bilan avant suppression : `{files, dirs, size, token}` ou le refus (`409 SHARED_LOCKED`, `SHARED_DRAFT_OPEN`, `SHARED_DIR_SPECIAL`, `SHARED_DIR_TOO_BIG`…) |
| DELETE | `/api/shared/dir?path=&expect=` | supprime le dossier et son contenu s'il est encore celui du bilan (`409 SHARED_STALE` sinon) ; chaque fichier est gardé ici avant de partir ; arrêt en route : `409 SHARED_DIR_PARTIAL` |
| GET | `/api/shared/search?q=&dir=` | noms (sans casse ni accents, tous les mots), borné : 100 résultats, 3 000 dossiers, 8 s ; hors ligne : listes gardées |
| POST | `/api/shared/versions/:id/restore?path=` | la version devient le brouillon (rien n'est envoyé) |
| POST · DELETE | `/api/shared/lock?path=` | prendre/renouveler la main (`{take_over}`) · la rendre ; `409 SHARED_LOCKED` / `SHARED_LOCK_STALE` + `{lock}` |
| PUT · DELETE | `/api/shared/projects/:id/folder` | relier un projet à un sous-dossier (`{dir}`) · le délier |

Formats du dossier partagé, côté front (le serveur ne voit que des octets) : `text-codec.ts`,
`text-file.ts`, `csv-file.ts`, `zip.ts` (archive, réécriture fidèle), `xml-scan.ts` (XML à
positions), `ooxml.ts` (relations, propriétés : commun à Word et Excel), `docx.ts` +
`docx-extensions.ts` (Word, §26) + `docx-markdown.ts` (pont Word ⇄ Markdown pour l'IA :
objets en marqueurs, paragraphes gardés, styles du document — §30), `xlsx.ts` + `xlsx-format.ts` (formats à la française,
saisie) + `xlsx-formula.ts` (syntaxe, traduction, dépendances) (Excel, §27), `shared-merge.ts`
(fusion à trois voies : à la ligne pour le texte et les CSV, à la cellule pour Excel),
`new-files.ts` (modèles des fichiers neufs : Word, Excel, Markdown, texte, CSV).

Sur la PWA, les mêmes routes sont servies par le **relais** (`api/src/relay.js`, VM du bureau,
Tailscale, code d'accès, CORS limité à la PWA — §29, `docs/09-RELAIS.md`) ; le front y passe
par `sharedClient(base, auth)`, réglé dans Paramètres (`web/src/relay-settings.ts`).

Les routes `/api/shared/*` ne répondent qu'à cet ordinateur (`localOnly`) et ne fixent jamais
le chemin du partage (dialogue natif desktop ou `WORKLOGS_SHARED_ROOT`). Elles passent par
`shared-service.js` (garde, versions, réessais) et `shared-io.js` (worker borné, disjoncteur).

Conventions : erreurs `{"error": "…"}` en français, `400` pour une validation, `404` pour un
identifiant inconnu, `201` à la création. Un champ absent d'un `PUT` **n'est pas écrasé** ;
une chaîne vide vaut NULL.

`/api/state` est le cœur du front : une seule requête alimente les trois colonnes, et le front
la rejoue après chaque mutation. C'est ce qui permet à `App.tsx` de tenir en ~170 lignes. Chaque
tâche porte `documents`, un tableau de résumés `{id, title, entry_date, project_id, updated_at,
google_document_id, google_tab_id, google_document_title, google_tab_title}`. Le filtre
`project_id` filtre les tâches (et les entrées principales), mais pas les documents associés à
une tâche : ils restent son contexte, même s'ils appartiennent à un autre projet.

`POST /api/entries/:id/task` reprend par défaut le titre et le projet de l’entrée, accepte une échéance
facultative et crée la tâche ainsi que `task_entries` dans une transaction. Il fonctionne de la même
manière pour une entrée locale et pour un onglet Google.

Les associations sont créées avec `POST /api/tasks/:id/documents/:entryId` : `201` à la première
création, puis `200` avec la ligne existante en cas de doublon. La suppression renvoie `200` ;
une tâche, une entrée ou une association inconnue renvoie `404` avec un message distinct.
`entryId` désigne aussi bien une entrée locale qu'un onglet Google importé.

## Front

| Fichier | Rôle |
|---|---|
| `App.tsx` | état global (`state`, recherche, projet, entrée ouverte, thème), en-tête, 3 colonnes |
| `lib.ts` | types, client API, helpers purs (`dayLabel`, `isOverdue`, `plainText`, `groupByDay`) |
| `markdown.ts` | `marked` (GFM, `breaks`) puis `DOMPurify` — le rendu part en `dangerouslySetInnerHTML` ; clôtures du bouton « Bloc de code » |
| `rich-code.ts` | « Bloc de code » de l'éditeur riche : plusieurs lignes sélectionnées → un seul bloc |
| `ai-suggest.ts` | client IA compatible OpenAI (Gemini par défaut, chaîne de secours) : sous-tâches, mise en page, procédures — dont `draftProcedure`, une procédure tirée d'une entrée ou d'une tâche |
| `components/ProcedureDraft.tsx` | relecture d'une procédure rédigée par l'IA (titre modifiable, aperçu), puis création par `POST /api/entries` |
| `components/EntryList.tsx` | journal groupé par jour, extrait sur une ligne |
| `components/ProcedureList.tsx` | procédures du projet (entrées `kind='procedure'`) + pièces jointes rassemblées |
| `components/EntryEditor.tsx` | titre, date, projet, Écrire/Lire (entrées Markdown et procédures locales), enregistrement auto, pièces jointes |
| `components/RichEditor.tsx` | éditeur Tiptap et barre de mise en forme ; `readOnly` = mode Lire d'une procédure |
| `components/GoogleDrive.tsx` | dialogue Drive dédié, configuration et documents autorisés |
| `components/TaskBoard.tsx` | ajout rapide, 3 colonnes, glisser-déposer HTML5, édition en place, associations de documents, ✨ Procédure |
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
