# 🤝 WorkLogs — fiche de relève (LIRE EN PREMIER)

> **Mise à jour :** 2026-09-14 · **Version du manifeste :** 0.6.13
> **État :** `./scripts/check.sh` **vert — 198 tests**, desktop compris.
> Deux lots intégrés et prêts à publier : **documents riches + Google Drive**, et
> **mise à jour en un clic sur Debian/Mint** (dépôt apt).
> **Reprise prioritaire : [08-GOOGLE-DOCS.md](08-GOOGLE-DOCS.md)** (recette OAuth réelle),
> puis [07-RELEASES.md](07-RELEASES.md) avant toute publication.

## État au 2026-09-14

Le lot desktop est **terminé et en production**. WorkLogs est distribué en DEB, RPM et
AppImage (SHA256 + attestation de provenance), avec mise à jour intégrée : PackageKit pour
RPM/DEB, delta electron-updater pour l'AppImage, et **deux dépôts** servis par GitHub Pages
(dnf pour Fedora, apt pour Debian/Ubuntu/Mint).

| | Vérifié |
|---|---|
| `./scripts/check.sh` | **CHECK OK** — 71 API · 64 front · 25 serveur desktop/OAuth/màj · 16 scripts release · 16 navigateur · 6 application desktop |
| Workflows GitHub | `ci.yml`, `release.yml`, `repos.yml` exécutés réellement et régulièrement |
| Mise à jour Mint | dépôt apt construit et testé (install **puis** upgrade) en conteneur `ubuntu:24.04` |
| Releases | 19 publiées, de `v0.2.0` (11/09) à `v0.6.12` (12/09) |
| Paquets | DEB/RPM/AppImage installés et lancés sur Ubuntu 24.04, Fedora 43 et Fedora 44 |

**Ce qui reste ouvert**, par ordre d'utilité :

1. **Aller-retour Google réel** — le seul point du lot documents qui ne peut pas être fait
   sans toi : il faut un client OAuth de bureau créé dans **ton** Google Cloud. Tous les
   tests Google utilisent des réponses simulées. Marche à suivre : `08-GOOGLE-DOCS.md`.
2. **Recette manuelle sur une vraie session graphique** — jamais faite. Tout a été validé en
   conteneur ou sous Xvfb. Il reste à vérifier de vrais yeux : icône et raccourci dans le menu,
   boîte « Enregistrer sous » (nom de fichier suggéré, cf. `06-DESKTOP-CICD.md` §1.2),
   impression via la vraie boîte système, et un cycle complet de mise à jour depuis le dépôt.
3. **Node en retard sur `.nvmrc`** — le fichier demande 24.20.0, la machine a 24.13.0, et
   `jsdom@30` réclame ≥ 24.15.0 (avertissement `EBADENGINE` à l'installation). Les tests
   passent, mais c'est une panne en sursis.
4. **Licence** — toujours `UNLICENSED`. À trancher si diffusion publique (cf. `05-DECISIONS.md`).
5. **Dépôts non signés** (`gpgcheck=0` côté dnf, `[trusted=yes]` côté apt) — acceptable en
   usage personnel, la signature GPG reste une piste.
6. **Express reste en 4** : la 5 casse le téléchargement des pièces jointes. Migration à faire
   dans un lot dédié (`07-RELEASES.md` §8).


## Documents riches et Google Drive — intégré, prêt à publier

L’utilisateur a choisi **l’édition dans WorkLogs** et approuvé Tiptap 3.31.3. Le lot
est fusionné avec le lot « mise à jour Mint » : éditeur riche local, connexion Drive
desktop facultative, ouverture, envoi explicite et rechargement avec conflits protégés.
La recette complète passe avec **188 tests**. L’intégration Google est testée avec des
réponses simulées ; aucun vrai compte/client OAuth n’a été configuré pendant ce lot.

**Prochaine action :** suivre [08-GOOGLE-DOCS.md](08-GOOGLE-DOCS.md) pour configurer un
client OAuth desktop et valider un aller-retour réel sur un document Google de test.
Le sous-ensemble Google initial couvre texte, titres, styles et listes simples ; les
documents complexes sont refusés avant import/écriture. Tableaux et images fonctionnent
localement. Aucun nouveau tag ni release n’a été créé pour ce lot. Le bump du manifeste
à 0.6.13 présent dans le dépôt a été conservé.

## 1. C'est quoi ?
Un journal de travail local. On y **écrit** ce qu'on a fait (Markdown, belle mise en page,
impression PDF propre) et on y **suit** ses tâches. Tout tient sur un écran : journal à
gauche, écriture au centre, tâches à droite. Ni onglet ni routeur ; aucun compte requis en local. Google Drive est facultatif en desktop.

## 2. Reprise en 3 commandes
```bash
cd /home/timo/WorkLogs
npm run install:all     # une seule fois
npm run dev             # API :8410 + web :8411 → http://localhost:8411
./scripts/check.sh      # recette complète, doit finir par « CHECK OK »
```

## 3. Où est le code
```
WorkLogs/
├── api/
│   ├── src/db.js        schéma V2, migration V1→V2, données d'amorçage
│   ├── src/app.js       createApp({db, uploadDir, staticDir}) — toutes les routes
│   ├── src/server.js    ouvre la base, écoute, sert web/dist en prod
│   └── test/            8 fichiers de tests, 71 tests node:test
├── web/src/
│   ├── App.tsx          l'écran : en-tête + 3 colonnes
│   ├── lib.ts           types, client API, helpers purs
│   ├── markdown.ts      marked + DOMPurify
│   ├── autosave.ts      cadence d'enregistrement automatique
│   ├── components/      EntryList · EntryEditor · RichEditor · GoogleDrive · TaskBoard · ProjectBar · UpdateBar · Logo
│   ├── styles.css       thèmes clair/sombre, typographie du document, feuille d'impression
│   └── *.test.ts(x)     5 fichiers, 64 tests vitest
├── desktop/
│   ├── main.mjs         fenêtre Electron, protocole worklogs://, téléchargements, impression
│   ├── server.mjs       API + SQLite sur port éphémère local, protégés par jeton
│   ├── update.mjs       détection du format installé, PackageKit, electron-updater
│   ├── google.mjs       OAuth desktop, trousseau, appels Google
│   ├── preload.cjs      bridge minimal : fermeture après sauvegarde
│   ├── test/            21 tests node:test (serveur + mises à jour + OAuth)
│   └── e2e/             6 parcours Playwright (sources ou paquet via WORKLOGS_EXECUTABLE)
├── e2e/                 16 parcours Playwright (web)
├── scripts/             check.sh · backup.sh · stage-desktop · verify-package ·
│                        check-release · release-notes · blockmap  (+ 10 tests)
├── .github/workflows/   ci.yml · release.yml · rpm-repo.yml
└── docs/                cette doc
```

## 4. Ce qui a changé depuis la V1 (2026-09-11)
| V1 | V2 |
|---|---|
| 7 onglets (Dashboard, Kanban, Todos, Agenda, Docs, Fichiers, Projets) | **1 écran** |
| 5 tables, tâches à 13 colonnes façon Jira | 4 tables, tâches à 9 colonnes |
| 4 statuts, 4 priorités, 5 types de tâche | 3 statuts, épingle oui/non |
| Markdown maison en 10 lignes de regex | marked + DOMPurify (tableaux, code, cases à cocher) |
| Enregistrement par bouton | enregistrement automatique + `Ctrl+S` |
| Aucun test | 188 tests avec le lot documents riches, `./scripts/check.sh` |
| Agenda séparé | supprimé — un événement est une entrée datée |

La migration est automatique et **sans perte** : les docs, les événements et les descriptions
de tâches V1 deviennent des entrées de journal. Elle tourne à la première ouverture de la base.

## 5. Données
- `api/data/worklogs.db` (+ `-wal`, `-shm`) — non versionnée.
- `api/data/uploads/` — non versionné (sauf `.gitkeep`).
- Amorçage : 2 projets, 1 entrée « Comment ça marche », 3 tâches — seulement si la base est vide.
- Sauvegarde : `./scripts/backup.sh`. Export JSON : bouton « Exporter » ou `GET /api/export`.

## 6. Check-list de prise en main (15 min)
1. `./scripts/check.sh` → doit finir par `CHECK OK`. Si ce n'est pas le cas, s'arrêter là et
   régler ça d'abord : c'est le filet de tout le reste.
2. Ouvrir <http://localhost:8411>, créer une entrée, taper du Markdown, `Ctrl+P`. Dix minutes
   d'usage réel valent mieux que toute la doc.
3. Lire `AGENTS.md` (les règles) puis `05-DECISIONS.md` (**pourquoi** c'est comme ça).
4. Ouvrir `04-RECETTES.md` à la recette qui correspond à la tâche à faire.
5. Travailler par petits diffs : le test d'abord, `check.sh` vert à la fin.

### La doc, dans l'ordre
| Fichier | À lire quand |
|---|---|
| `00-HANDOVER.md` | en arrivant (ce fichier) |
| `AGENTS.md` · `CLAUDE.md` | avant la première modification |
| `05-DECISIONS.md` | avant de proposer quoi que ce soit de nouveau |
| `04-RECETTES.md` | au moment de faire |
| `01-ARCHITECTURE.md` | pour le schéma de base, l'API, la carte du front |
| `02-DEV.md` | pour les tests, les conventions, les pièges |
| `03-UTILISATION.md` | pour comprendre l'usage attendu côté utilisateur |
| `07-RELEASES.md` | **avant toute publication** : pipeline, versionnage, pièges vécus |
| `06-DESKTOP-CICD.md` | dossier technique du desktop : Electron, packaging, bugs résolus |
| `08-GOOGLE-DOCS.md` | documents riches/Drive : fonctionnement, configuration, limites et recette réelle restante |

## 7. Pistes suivantes (non engagées)
Recherche plein texte FTS5 · import du JSON exporté · modèles d'entrée (compte rendu, décision) ·
export PDF sans passer par l'impression · rappels sur échéance.

## 8. Machine
Linux Mint 22.3 · Node v24.13.0 (`.nvmrc` demande **24.20.0**, cf. point ouvert n°2) · npm 11.6.2.
L'application ne tourne dans aucun conteneur ; Docker/Podman ne sert qu'à **essayer les paquets**
dans des images jetables (`scripts/test-linux-package.sh`, et la matrice de `ci.yml`).
Services web lancés en `screen` (`wl-api`, `wl-web`) — ils ne survivent pas au redémarrage.
