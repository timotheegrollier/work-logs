# WorkLogs

**État : v0.75.0** (`package.json` fait foi). `./scripts/check.sh` vert le 2026-11-12, après la v0.75.0,
**1 925 tests**, échec attendu compris : 329 API · 1 341 front (plus un échec attendu) ·
49 desktop · 49 scripts · 8 Worker · 11 relais · 117 navigateur · 20 desktop e2e.

**Lot publié en v0.12.0 : éditeur Google Docs natif** (`codex/google-docs-integrated-editor`).
Lire `docs/08-GOOGLE-DOCS.md` : la vraie page Google s'affiche dans la colonne centrale,
dans une vue Electron isolée ; l'autorisation OAuth des API garde le navigateur système.
Tiptap 3.31.3 et ses extensions listées dans `AGENTS.md` ont été explicitement approuvés.
La connexion d'un compte Google dans la vue intégrée a été vérifiée le 15/09. Ne jamais
déguiser l'`userAgent` si Google referme ce chemin : consigner le refus à la place.

Application desktop Linux **en production** depuis `v0.2.0` (DEB/RPM/AppImage avec mise à jour
intégrée). Lire `docs/00-HANDOVER.md`, puis **`docs/07-RELEASES.md`** avant toute publication.
Electron et electron-builder ont été explicitement approuvés (versions : `package.json`).
Express reste en 4 (la 5 casse les téléchargements).

Journal de travail personnel, local par défaut avec Drive facultatif, **sur un seul écran** : journal à gauche, écriture
au centre, tâches à droite. Node + Express + `node:sqlite` (`api/`), React + Vite + TS (`web/`).

## Avant de toucher au code

1. `AGENTS.md` — les règles, en une page.
2. `docs/00-HANDOVER.md` — l'état du projet et la reprise en 3 commandes.
3. `docs/05-DECISIONS.md` — **pourquoi** c'est comme ça. La plupart de ce qui manque manque
   exprès ; ce fichier évite de le réintroduire par mégarde.
4. `docs/04-RECETTES.md` — la marche à suivre pour la tâche précise à faire.

## Les trois règles qui comptent

- **Aucune fonctionnalité sans test.** Route API → test dans `api/test/`. Geste utilisateur →
  test dans `web/src/App.test.tsx`, ou dans `e2e/` si ça dépend d'un vrai navigateur.
- **`./scripts/check.sh` vert avant et après.** Il enchaîne types, tests API, front (dont un échec
  attendu), desktop (serveur/OAuth/mise à jour/vue Google/dossier partagé), scripts de release,
  relais Google (Worker), mise à jour du relais de la VM, build, parcours navigateur et parcours
  de l'application desktop, et finit par `CHECK OK`. Décomptes : en tête de ce fichier.
- **Rien de nouveau sans accord** : ni dépendance, ni onglet, ni mode. La valeur de cette
  application est qu'elle tient sur un écran.

## Commandes

```bash
npm run dev          # API :8410 + web :8411 → http://localhost:8411
npm run desktop      # l'application Electron
npm test             # API + front
npm run test:e2e     # build + Playwright (web)
npm run test:desktop # parcours Electron (xvfb-run si pas d'affichage)
./scripts/check.sh   # tout (Electron dans Xvfb + metacity s'ils sont là)
WORKLOGS_E2E_PORT=8432 ./scripts/check.sh  # si une autre copie de travail occupe le port 8412
./scripts/backup.sh  # sauvegarde base + fichiers joints
```

## Repères

- Base : `api/data/worklogs.db` — **jamais** commitée, jamais touchée par les tests.
- Tables synchronisées : `projects`, `categories`, `entries`, `tasks`, `task_entries`, `attachments`,
  `google_documents`, `sync_tombstones`. Schéma dans `docs/01-ARCHITECTURE.md`.
  Dossier partagé du TSE (§25) : tables **de la machine**, sans clé étrangère, jamais synchronisées.
  Sur la PWA, il passe par le **relais** de la VM du bureau (§29, `docs/09-RELAIS.md`), qui
  regarde toutes les 5 minutes et installe tout seul chaque release publiée (§37) : `/health` dit sa version.
- Lecture : tout l'écran vient de `GET /api/state`. Le front la rejoue après chaque mutation.
- Les éléments interactifs portent un `aria-label` parlant : c'est l'accessibilité **et** la
  prise des tests.
- Données desktop : `~/.local/share/worklogs/` (base + uploads), profil dans `~/.config/worklogs/`.
- Publier = bumper avec `npm version X.Y.Z --no-git-tag-version` (synchronise le lockfile),
  pousser, attendre la CI verte, puis taguer. Détail et pièges : `docs/07-RELEASES.md`.
- Dépôts **dnf** (Fedora) et **apt** (Debian/Mint) sur la branche gh-pages, lus sur `raw.githubusercontent.com`,
  publiés par `repos.yml`, rétention 1 version (`KEEP`). Ne jamais tester PackageKit sur le seul code de
  sortie : `pkcon get-updates` sort en 5 quand il n'y a rien à installer.
- Mise à jour in-app : `pkcon` **lit** les mises à jour, `pkexec` + apt/dnf les **installe**.
  `pkcon update` ne peut pas fonctionner depuis une application graphique — pourquoi et
  les deux échecs reproduits : `docs/07-RELEASES.md` §8.
