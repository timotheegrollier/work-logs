# WorkLogs

> **Desktop Linux en cours — version 0.2.0 non publiée.** Branche
> [`codex/linux-desktop-releases`](https://github.com/timotheegrollier/work-logs/tree/codex/linux-desktop-releases).
> Le travail a été interrompu à la demande de l’utilisateur. Un test de téléchargement
> desktop échoue encore ; les paquets et la CI restent à valider.
> **Reprise : [passation desktop et CI/CD](docs/06-DESKTOP-CICD.md).**

Le prototype se lance avec `npm run install:all`, puis `npm run desktop`. Il utilise
`~/.local/share/worklogs/` pour ses données et `~/.config/worklogs/` pour son profil.
Les données web ne sont pas importées automatiquement. Cibles prévues : Mint 22.x et
Fedora 43/44 x86_64, en DEB, RPM et AppImage.

Journal de travail 100 % local. **Un seul écran** : le journal à gauche, l'écriture au
centre, les tâches à droite. Aucun onglet, aucun menu, aucun cloud.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ WorkLogs   [rechercher…]        4 entrées cette semaine · 3 à faire   ☀ ⬇ │
├───────────────┬───────────────────────────────────┬───────────────────────┤
│ Tout · Perso  │  Compte rendu chantier            │ [nouvelle tâche…]     │
│ + Nouvelle    │  [date] [projet] [Écrire│Lire]    │ À FAIRE  3            │
│               │  ─────────────────────────────    │  ☐ Relancer le devis  │
│ AUJOURD'HUI   │                                   │ EN COURS 1            │
│ • Compte rendu│  ## Points                        │  ☐ Bug export         │
│ • Note du jour│  - Devis signé                    │ TERMINÉ  2            │
│               │  📎 devis.pdf                     │  ☑ Trier la boîte     │
└───────────────┴───────────────────────────────────┴───────────────────────┘
```

## Démarrer

```bash
cd /home/timo/WorkLogs
npm run install:all     # une seule fois
npm run dev             # API :8410 + web :8411 → http://localhost:8411
```

En un seul processus (le serveur sert aussi le front) : `npm start` → http://localhost:8410

## Utiliser

| Geste | Effet |
|---|---|
| **+ Nouvelle entrée** | crée l'entrée du jour et place le curseur dans le titre |
| Écrire dans la zone Markdown | **enregistrement automatique**, `Ctrl+S` pour forcer |
| **Écrire / Lire** | édition côte à côte avec l'aperçu, ou lecture pleine largeur |
| **Imprimer** (ou `Ctrl+P`) | sort l'entrée seule, mise en page propre, prête pour un PDF |
| 📎 **Joindre un fichier** | attache un document à l'entrée ouverte |
| Taper + `Entrée` dans « Nouvelle tâche » | ajoute une tâche à la colonne À faire |
| Cocher une carte · la glisser | la termine · la change de colonne |
| Clic sur un projet | filtre **le journal et les tâches** en même temps |
| **Rechercher** | cherche dans les titres, le corps des entrées et les tâches |
| **Exporter** | télécharge toute la base en JSON |

Markdown géré : titres, gras/italique, listes, **cases à cocher**, **tableaux**,
citations, blocs de code, liens, images.

## Tester

```bash
npm test            # API (node:test) + front (vitest)
npm run test:e2e    # parcours réels dans un navigateur (playwright)
./scripts/check.sh  # tout : types + tests + build + navigateur
```

## Sauvegarder

```bash
./scripts/backup.sh     # → ~/WorkLogs-backups/worklogs-AAAAMMJJ-HHMMSS/
```

## Documentation

| Doc | Pour qui | Contenu |
|---|---|---|
| `docs/00-HANDOVER.md` | **tous, en premier** | état du projet, reprise en 3 commandes, check-list |
| `docs/01-ARCHITECTURE.md` | dev / agent | schéma de la base, référence de l'API, structure du front |
| `docs/02-DEV.md` | dev / agent | installation, tests, conventions, pièges |
| `docs/03-UTILISATION.md` | Timo | l'écran, le Markdown, l'impression, les sauvegardes |
| `docs/04-RECETTES.md` | dev / agent | « comment faire X » : ajouter un champ, migrer, dépanner, livrer |
| `docs/05-DECISIONS.md` | dev / agent | **pourquoi** c'est comme ça, et ce qui a été retiré exprès |
| `AGENTS.md` · `CLAUDE.md` | agents | les règles, en une page |

Données : `api/data/worklogs.db` (SQLite) et `api/data/uploads/` — jamais versionnées.
