# 🧑‍🍳 WorkLogs — recettes

> Pour reprendre le lot desktop/CI interrompu, commencer par
> [06-DESKTOP-CICD.md](06-DESKTOP-CICD.md), notamment son ordre de reprise.
> Le test rouge de téléchargement est connu et doit être résolu en premier.

Comment faire les choses qu'on a réellement besoin de faire. Chaque recette donne les fichiers
dans l'ordre où on les touche, et la commande qui prouve que ça marche.

**Règle de base, avant toute recette :** `./scripts/check.sh` doit être vert **avant** de
commencer. Sinon on ne saura pas ce qu'on a cassé.

---

## 1. Ajouter un champ à une entrée

Exemple : une entrée gagne un champ `mood` (texte libre).

**① Le schéma — `api/src/db.js`**
Ajouter la colonne dans la constante `SCHEMA`, avec une valeur par défaut pour que les lignes
existantes restent valides :
```sql
CREATE TABLE IF NOT EXISTS entries (
  …
  mood TEXT NOT NULL DEFAULT '',
  …
);
```
`CREATE TABLE IF NOT EXISTS` **ne modifie pas** une table déjà créée. Pour les bases existantes,
ajouter juste après `db.exec(SCHEMA)` dans `openDb()` :
```js
if (!columns(db, 'entries').includes('mood')) {
  db.exec("ALTER TABLE entries ADD COLUMN mood TEXT NOT NULL DEFAULT ''");
}
```
(`columns()` est déjà défini en haut de `db.js`.) C'est la manière sûre d'ajouter une colonne :
pas de reconstruction de table, donc aucun risque sur les clés étrangères — contrairement à la
recette 4. Vérifié sur une copie de la vraie base : les lignes existantes reçoivent la valeur
par défaut et `PRAGMA foreign_key_check` reste vide.

**② L'API — `api/src/app.js`**, section `entrées` :
- `POST /api/entries` : ajouter `mood` à l'`INSERT` et à la liste de valeurs.
- `PUT /api/entries/:id` : `pick(b, 'mood', cur.mood, str)` — le champ n'est écrasé que s'il est
  fourni.
- Si le champ doit apparaître dans la liste de gauche, l'ajouter au `SELECT` de `/api/state`.

**③ Le test API — `api/test/entries.test.js`**
```js
test('conserve le champ mood', async () => {
  const entry = await make.entry(api, { mood: 'bonne journée' });
  assert.equal(entry.mood, 'bonne journée');
  const res = await api.put(`/api/entries/${entry.id}`, { title: 'Autre' });
  assert.equal(res.body.mood, 'bonne journée', 'non fourni = non écrasé');
});
```
→ `npm run test:api`

**④ Le type — `web/src/lib.ts`** : ajouter `mood: string` à `interface Entry`.

**⑤ L'interface — `web/src/components/EntryEditor.tsx`** : ajouter le champ au `draft` initial,
un contrôle dans `.editor-meta` avec un `aria-label` explicite, et `update({ mood: … })`.

**⑥ Le test d'interface — `web/src/App.test.tsx`**
```js
await user.type(screen.getByLabelText('Humeur'), 'bonne journée');
await waitFor(() => expect(row(api.db, 'SELECT * FROM entries').mood).toBe('bonne journée'));
```
→ `npm run test:web`

**⑦** `./scripts/check.sh` · mettre à jour le schéma dans `01-ARCHITECTURE.md`.

---

## 2. Ajouter une route API

1. **`api/src/app.js`** — la poser dans la bonne section (`état global`, `entrées`, `tâches`,
   `projets`, `fichiers`, `export`), **avant** le `app.use('/api', …)` qui renvoie 404.
2. Réutiliser les helpers du haut du fichier : `str`, `orNull`, `pick`, `bad`, `notFound`,
   `getEntry` / `getTask` / `getProject`. Ne pas réinventer la validation.
3. Respecter le contrat : `201` à la création, `400` + `{error}` en français pour une
   validation, `404` pour un identifiant inconnu.
4. **Un test par cas** dans `api/test/` : le cas nominal, le cas invalide, le 404.
5. **`web/src/lib.ts`** — exposer l'appel dans l'objet `api`, jamais de `fetch` dans un composant.
6. Documenter la route dans le tableau de `01-ARCHITECTURE.md`.

---

## 3. Ajouter un geste dans l'interface

1. Le composant concerné : `EntryList` (journal), `EntryEditor` (écriture), `TaskBoard`
   (tâches), `ProjectBar` (projets). `App.tsx` ne porte que l'état partagé.
2. Tout élément interactif reçoit un **`aria-label` parlant** (`Épingler Relancer le devis`).
   C'est à la fois l'accessibilité clavier et la prise des tests.
3. Après une mutation, appeler `onChanged()` : cela rejoue `/api/state` et remet tout l'écran à
   jour d'un coup.
4. Styles dans `web/src/styles.css` **uniquement**, dans la section correspondante.
5. Test dans `App.test.tsx`. Si le geste dépend du vrai navigateur (glisser-déposer, fichier,
   impression), le test va dans `e2e/worklogs.spec.ts`.

---

## 4. Changer le schéma en profondeur (migration V2 → V3)

Pour un simple ajout de colonne, voir la recette 1 — inutile de reconstruire une table.

Pour une vraie transformation (renommer, changer un type, fusionner deux tables), reprendre le
gabarit de `migrate()` dans `db.js` :

```js
db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;');
db.exec('ALTER TABLE entries RENAME TO entries_v2');
db.exec(SCHEMA);
db.exec('INSERT INTO entries (…) SELECT … FROM entries_v2');
db.exec('DROP TABLE entries_v2');
db.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
```

**Les trois règles à ne pas oublier :**
- `legacy_alter_table = ON` — sans lui, le `RENAME` réécrit les clauses `REFERENCES` des
  **autres** tables, qui pointeront vers `entries_v2`.
- Les index se créent **après** (constante `INDEXES`), jamais dans `SCHEMA`.
- Migrer les données avant de supprimer l'ancienne table. Ne rien jeter en silence : si un champ
  disparaît et contenait du texte saisi, le reverser dans une entrée de journal (c'est ce qu'a
  fait la V2 pour les descriptions de tâches).

**Le test est obligatoire.** `api/test/migration.test.js` montre la méthode : reconstruire une
base de la version précédente avec des données, l'ouvrir avec `openDb()`, puis vérifier le
contenu **et** l'intégrité :
```js
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
assert.deepEqual(db.prepare('PRAGMA foreign_key_list(entries)').all().map((f) => f.table), ['projects']);
```

---

## 5. Retoucher l'apparence

Tout est dans `web/src/styles.css`, découpé en sections commentées.

| Envie | Où |
|---|---|
| Couleurs, contraste | les deux blocs `:root[data-theme='dark'|'light']` en tête — ne jamais écrire une couleur en dur ailleurs |
| Largeur des colonnes | `.columns { grid-template-columns: … }` |
| Typographie du document | section `.prose` (taille, interligne, titres, tableaux, code) |
| Rendu imprimé | le bloc `@media print` en fin de fichier |

Pour vérifier l'impression sans imprimer : dans le navigateur, outils de développement →
« Rendering » → *Emulate CSS media type: print*. C'est ce que fait le test
`à l'impression, seule la fiche reste`.

---

## 6. Changer un port

Quatre endroits, tous obligatoires :
`api/src/server.js` (défaut) · `web/vite.config.ts` (`server.port` **et** `proxy`) ·
`playwright.config.ts` (`PORT`, `baseURL`) · `README.md` + `docs/`.

Sans toucher au code : `PORT=9000 npm run start:api`.

---

## 7. Repartir d'une base vierge

```bash
./scripts/backup.sh                 # d'abord, toujours
./scripts/stop.sh                   # libérer le fichier
rm api/data/worklogs.db*            # .db, -wal et -shm
npm run dev                         # l'amorçage se rejoue : 2 projets, 1 entrée, 3 tâches
```

## 8. Restaurer une sauvegarde

```bash
./scripts/stop.sh
cp ~/WorkLogs-backups/worklogs-AAAAMMJJ-HHMMSS/worklogs.db api/data/worklogs.db
rm -f api/data/worklogs.db-wal api/data/worklogs.db-shm
cp -r ~/WorkLogs-backups/worklogs-AAAAMMJJ-HHMMSS/uploads/. api/data/uploads/
npm run dev
```
Les `-wal` / `-shm` doivent partir : ce sont les journaux de l'**ancienne** base, les garder
corromprait celle qu'on restaure.

## 9. Inspecter ou réparer la base à la main

Pas de CLI `sqlite3` sur cette machine — passer par Python :
```bash
python3 - <<'EOF'
import sqlite3
c = sqlite3.connect('/home/timo/WorkLogs/api/data/worklogs.db')
for r in c.execute("SELECT status, COUNT(*) FROM tasks GROUP BY status"): print(r)
# écriture : c.execute("UPDATE …"); c.commit()
EOF
```
Arrêter l'API avant d'écrire (`./scripts/stop.sh`), sinon deux processus écrivent en même temps.

**Pour travailler sur une copie**, ne jamais faire `cp api/data/worklogs.db ailleurs.db` : en mode
WAL, le fichier principal est incomplet tant que le journal n'est pas reporté, et la copie peut
n'avoir aucune table. Faire une copie complète :
```bash
python3 -c "import sqlite3;sqlite3.connect('api/data/worklogs.db').execute(\"VACUUM INTO '/tmp/essai.db'\")"
```

---

## 10. Quand ça ne démarre pas

| Symptôme | Cause probable | Geste |
|---|---|---|
| « API injoignable » dans la page | l'API n'écoute pas | `curl localhost:8410/api/health` puis `npm run dev:api` |
| `EADDRINUSE` sur 8410 ou 8411 | un serveur précédent tourne encore | `./scripts/stop.sh` puis `ss -tlnp \| grep -E '8410\|8411'` |
| `ExperimentalWarning: SQLite` | normal | ignorer |
| `SQLITE_BUSY` | deux processus écrivent | arrêter l'API avant toute écriture manuelle |
| `error TS…` sur un fichier de test | mauvais `tsconfig` | les tests relèvent de `web/tsconfig.test.json`, pas de `tsconfig.app.json` |
| Playwright : « browser not found » | navigateur absent | `npx playwright install chromium` |
| Un test e2e échoue sur un `confirm()` | dialogue refusé par défaut | `page.once('dialog', d => d.accept())` avant le clic |
| La page est vide, la console parle de module | `dist` périmé | `npm run build` |

## 11. Relancer les services après un redémarrage

```bash
cd /home/timo/WorkLogs && npm run dev      # bloque le terminal, le plus simple
```
Ou en arrière-plan, comme c'est installé ici :
```bash
screen -dmS wl-api bash -c 'cd /home/timo/WorkLogs/api && PORT=8410 node --watch src/server.js'
screen -dmS wl-web bash -c 'cd /home/timo/WorkLogs/web && npm run dev'
screen -r wl-api        # voir les logs · Ctrl+A puis D pour ressortir
./scripts/stop.sh       # tout arrêter
```

---

## 12. Ajouter une dépendance

C'est le seul point où il faut **demander avant**. Le socle est volontairement minuscule :
`express`, `cors`, `multer` côté API ; `react`, `marked`, `dompurify` côté web ; `node:test`,
`vitest`, `playwright` pour les tests.

Avant de proposer un ajout, répondre à ces trois questions : qu'est-ce qui est impossible sans ?
combien de poids en plus ? qu'est-ce que ça coûte le jour où la dépendance est abandonnée ?
Puis installer au bon endroit (`npm --prefix api install …` ou `npm --prefix web install …`),
et mettre à jour la liste dans `AGENTS.md`.

---

## 13. Livrer un lot

```bash
./scripts/check.sh        # doit finir par CHECK OK
git add -A && git status  # relire le diff : rien de la base ni des uploads
```
Et mettre à jour, dans le même diff : `01-ARCHITECTURE.md` si le schéma ou l'API bougent,
`03-UTILISATION.md` si un geste change, `00-HANDOVER.md` si l'état du projet change.
