# 🛠️ WorkLogs — guide développeur

> **Desktop inclus :** `check.sh` enchaîne aussi les types desktop, ses 16 tests serveur et
> ses 5 parcours Electron — **165 tests au total**, tous verts. Les décomptes par étage plus
> bas ne couvrent que le socle web. Sans affichage, Xvfb est nécessaire (`check.sh` bascule
> tout seul) ; `rpm` (Ubuntu/Mint) ou `rpm-build` (Fedora) est requis pour construire les RPM.
> `npm run desktop` lance l'application. Publication : [07-RELEASES.md](07-RELEASES.md).

## Installer et lancer
```bash
npm run install:all     # racine + api + web
npm run dev             # API :8410 + web :8411 (Vite, rechargement à chaud)
npm start               # build + un seul serveur sur :8410
npm run dev:api         # API seule
npm run dev:web         # front seul
```
Variables d'environnement : `PORT`, `DATA_DIR`, `DB_PATH`, `UPLOAD_DIR`.

## Tester

```bash
npm test              # API + front (~20 s)
npm run test:api      # node:test, 60 tests
npm run test:web      # vitest, 52 tests
npm run test:web -- --watch
npm run test:e2e      # build + playwright, 12 parcours navigateur
./scripts/check.sh    # tout : types, tests, build, navigateur
```

| Étage | Outil | Où | Ce qui est couvert |
|---|---|---|---|
| API | `node:test` + `fetch` | `api/test/` | toutes les routes, validations, 404, positions kanban, fichiers sur disque, migration V1→V2 |
| Front | vitest + Testing Library | `web/src/*.test.ts(x)` | helpers purs, rendu Markdown et assainissement, parcours complets dans jsdom |
| Navigateur | Playwright (Chromium) | `e2e/` | glisser-déposer réel, upload/téléchargement, impression, persistance après rechargement |

### Ce qu'il faut savoir avant d'écrire un test
- **Aucun test ne touche `api/data/`.** `api/test/helpers.js` et `web/src/test/server.ts`
  créent une base et un dossier d'uploads jetables dans `/tmp`, sur un port éphémère.
  Playwright utilise `./.e2e-data` sur le port 8412, effacé à chaque campagne.
- **Les tests du front tapent sur la vraie API.** `useRealApi()` démarre `createApp()` en
  mémoire et détourne `fetch`. Aucun faux serveur à maintenir : si l'API change de contrat,
  les tests du front cassent tout de suite.
- **Repères d'accessibilité plutôt que sélecteurs CSS.** Les zones portent un `aria-label`
  (`Journal`, `Entrée`, `Tâches`, `Filtrer par projet`) ; les boutons d'action aussi
  (`Terminer X`, `Épingler X`). C'est ce qui rend les tests lisibles — et l'app utilisable
  au clavier.
- **Attention aux requêtes trop larges.** Un titre de tâche peut contenir le mot d'un bouton :
  cibler avec `within(board())`, `within(filters())` ou `{ exact: true }`.

## Conventions
- **Une fonctionnalité = un test.** `check.sh` vert avant et après.
- Petits diffs, pas de refonte silencieuse.
- Aucune dépendance nouvelle sans accord.
- API : ESM, `{error}` en français, validation systématique, `""` → NULL.
- Web : TS strict, styles dans `styles.css` uniquement, appels réseau dans `lib.ts`.
- Toute nouveauté qui ajouterait un onglet ou un mode est probablement à refuser : la valeur
  de cette app est qu'elle tient sur un écran.

## Pièges (lus = une heure gagnée)
1. **Migration et `ALTER TABLE`** : `PRAGMA legacy_alter_table = ON` est obligatoire, sinon
   renommer une table réécrit les `REFERENCES` des autres tables. Voir `db.js`.
2. **Index après migration** : `INDEXES` est séparé de `SCHEMA` parce que
   `idx_attachments_entry` porte sur une colonne absente du schéma V1.
3. **Positions kanban** : `move` pose la carte à `position - 0.5` puis renumérote. Si on
   supprime `renumber()`, l'ordre reste correct mais les positions dérivent.
4. **`node:sqlite` expérimental** : l'avertissement au démarrage est normal. API synchrone,
   bloquante — sans conséquence en local.
5. **WAL** : `worklogs.db-wal` / `-shm` apparaissent à l'usage. Ne pas les supprimer à chaud, et
   surtout **ne jamais copier `worklogs.db` tout seul** : tant que le journal n'est pas reporté,
   le fichier principal est incomplet — une copie donne une base où `entries` n'existe même pas.
   Copier les trois fichiers ensemble, ou mieux, utiliser `./scripts/backup.sh` qui fait un
   `VACUUM INTO` (base complète et compactée, même API en marche).
6. **Glisser-déposer HTML5** : ne se rejoue pas à la souris. Les tests émettent
   `dragstart`/`dragover`/`drop` avec un `DataTransfer` partagé (voir `e2e/worklogs.spec.ts`).
7. **`confirm()` et Playwright** : les dialogues sont refusés par défaut. Ajouter
   `page.once('dialog', d => d.accept())` avant un clic qui supprime.
8. **Trois `tsconfig`** : `app` (le front, exclut les tests), `node` (vite.config), `test`
   (les tests, avec les types Node). `tsc -b` les compile tous les trois.
9. **`screen`** : les sessions `wl-api` / `wl-web` ne survivent pas au redémarrage de la machine.

## Inspecter la base
```bash
python3 - <<'EOF'
import sqlite3
c = sqlite3.connect('/home/timo/WorkLogs/api/data/worklogs.db')
for r in c.execute("SELECT status, COUNT(*) FROM tasks GROUP BY status"): print(r)
EOF
# repartir de zéro : rm api/data/worklogs.db*  puis relancer (amorçage automatique)
```

## Dette connue
- `express@4` entraîne `qs` avec deux avis de sécurité modérés. Sans effet ici (localhost,
  mono-utilisateur, aucune entrée non fiable) ; le correctif est un passage à Express 5, à
  faire dans un lot dédié avec `check.sh` en filet.
