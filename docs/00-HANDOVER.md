# 🤝 WorkLogs — fiche de relève (LIRE EN PREMIER)

> **Mise à jour :** 2026-09-11 · **Version :** web V2 + desktop **0.4.0 publié**
> **État :** `./scripts/check.sh` est **vert**, desktop compris. Releases v0.2.0 → v0.4.0
> publiées (DEB/RPM/AppImage + SHA256 + attestation), CI réellement exécutée sur GitHub.
> **Reste une recette manuelle sur une vraie session desktop.**
> **Reprise prioritaire : [07-RELEASES.md](07-RELEASES.md)** (process de release),
> puis [06-DESKTOP-CICD.md](06-DESKTOP-CICD.md) (dossier technique du desktop).**

## Point d’arrêt desktop/CI

Le socle web était vert **avant le lot desktop** : 60 API + 52 front + 12 navigateur, soit
124 tests. Un second agent a repris le lot bloqué (voir `06-DESKTOP-CICD.md` pour le détail
complet) : le blocage du téléchargement Electron était une limite d'observation de Playwright,
pas une panne — corrigé, avec trois autres bugs trouvés en creusant (nom de fichier suggéré
cassé pour les téléchargements Electron via protocole personnalisé, en-tête `Content-Disposition`
trop pauvre côté API, et surtout **un bug qui empêchait l'app de démarrer du tout une fois
installée sur Ubuntu 24.04/Mint 22.x** — mauvaise résolution de la dépendance ALSA). `check.sh`
est maintenant vert, et les paquets DEB/RPM/AppImage ont été installés et testés avec succès
dans des conteneurs jetables reproduisant les trois cibles de la CI. Ce qui manque encore :
une recette manuelle sur une vraie session graphique, et l'exécution réelle des workflows
GitHub Actions (jamais lancés, ni par le premier ni par le second agent).

Les workflows sont écrits, pas validés sur GitHub. Aucun RPM ni essai d’installation
Mint/Fedora n’a été validé. Les paquets DEB/AppImage exploratoires doivent être reconstruits.
`check.sh` inclut maintenant le desktop et **n’est pas certifié vert**. Ne pas créer de tag
`v*` avant validation : il déclencherait la publication. Aucun tag ou release n’a été créé.

L’utilisateur a demandé d’arrêter, documenter et pousser pour reprendre avec un autre agent.
Les sections suivantes décrivent le web V2 ; le document 06 fait foi pour le lot en cours.

## 1. C'est quoi ?
Un journal de travail local. On y **écrit** ce qu'on a fait (Markdown, belle mise en page,
impression PDF propre) et on y **suit** ses tâches. Tout tient sur un écran : journal à
gauche, écriture au centre, tâches à droite. Ni onglet, ni menu, ni cloud, ni compte.

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
│   └── test/            6 fichiers, 60 tests node:test
├── web/src/
│   ├── App.tsx          l'écran : en-tête + 3 colonnes
│   ├── lib.ts           types, client API, helpers purs
│   ├── markdown.ts      marked + DOMPurify
│   ├── components/      EntryList · EntryEditor · TaskBoard · ProjectBar
│   ├── styles.css       thèmes clair/sombre, typographie du document, feuille d'impression
│   └── *.test.ts(x)     52 tests vitest
├── e2e/                 12 parcours Playwright
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
| Aucun test | 124 tests, `./scripts/check.sh` |
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

## 7. Pistes suivantes (non engagées)
Recherche plein texte FTS5 · import du JSON exporté · modèles d'entrée (compte rendu, décision) ·
export PDF sans passer par l'impression · rappels sur échéance.

## 8. Machine
Linux Mint 22.3 · Node v24.13.0 · npm 11.6.2 · pas de Docker (choix assumé).
Services lancés en `screen` (`wl-api`, `wl-web`) — ils ne survivent pas au redémarrage.
