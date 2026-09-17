# WorkLogs

Journal de travail enregistré localement par défaut. **Un seul écran** : le journal
à gauche, l’écriture au centre, les tâches à droite. Aucun compte requis en usage local.
La branche de développement ajoute les documents riches et Google Drive facultatif.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ WorkLogs   [rechercher…]        4 entrées cette semaine · 3 à faire   ☀ ⬇ │
├───────────────┬───────────────────────────────────┬───────────────────────┤
│ Tout · Perso  │  Compte rendu chantier            │ [nouvelle tâche…]     │
│ + Nouvelle    │  [date] [projet] [Écrire│Lire]    │ À FAIRE  3            │
│               │  ─────────────────────────────    │  ☐ Relancer le devis  │
│ AUJOURD'HUI   │                                   │ EN COURS 1            │
│ • Compte rendu│  ## Points                        │  ☐ Bug export         │
│ • Note du jour│  📎 devis.pdf                     │ TERMINÉ  2            │
│               │  - Devis signé                    │  ☑ Trier la boîte     │
└───────────────┴───────────────────────────────────┴───────────────────────┘
```

## Installer (Linux)

Télécharger la dernière release sur
[GitHub Releases](https://github.com/timotheegrollier/work-logs/releases)
(note en anglais à chaque version) et la vérifier :

| Fichier | Pour |
|---|---|
| `WorkLogs-*-linux-amd64.deb` | Ubuntu 24.04, Linux Mint 22.x et Debian dérivées |
| `WorkLogs-*-linux-x86_64.rpm` | Fedora 43 / 44 et dérivées RPM |
| `WorkLogs-*-linux-x86_64.AppImage` | n'importe quelle distribution 64 bits, sans installation |

```bash
sha256sum -c SHA256SUMS
```

### Mise à jour en un clic

Une fois le dépôt activé, l'application installe les versions suivantes toute seule,
après ta confirmation et ton mot de passe.

```bash
# Debian, Ubuntu, Linux Mint
sudo curl -fsSL -o /etc/apt/sources.list.d/worklogs.list \
  https://timotheegrollier.github.io/work-logs/deb/worklogs.list

# Fedora et dérivées RPM
sudo curl -fsSL -o /etc/yum.repos.d/worklogs.repo \
  https://timotheegrollier.github.io/work-logs/rpm/worklogs.repo
```

L'AppImage, elle, se met à jour seule et en différentiel — rien à activer.

Données dans `~/.local/share/worklogs/`, profil et thème dans
`~/.config/worklogs/` (construction des releases : `docs/07-RELEASES.md`).

## Développer

```bash
cd /home/timo/dev/work-logs
npm run install:all     # une seule fois
npm run dev             # API :8410 + web :8411 → http://localhost:8411
```

En un seul processus (le serveur sert aussi le front) : `npm start` →
http://localhost:8410. Application desktop : `npm run desktop`.

## Utiliser

| Geste | Effet |
|---|---|
| **+ Nouvelle entrée** | crée l'entrée du jour et place le curseur dans le titre |
| **+ Nouveau document** | éditeur riche : styles, listes, liens, tableaux et images locales |
| Écrire dans la zone Markdown | **enregistrement automatique**, `Ctrl+S` pour forcer |
| **Écrire / Lire** | édition côte à côte avec l'aperçu, ou lecture pleine largeur |
| **Imprimer** (ou `Ctrl+P`) | sort l'entrée seule, mise en page propre, prête pour un PDF |
| 📎 **Joindre un fichier** | attache un document à l'entrée ouverte |
| Taper + `Entrée` dans « Nouvelle tâche » | ajoute une tâche à la colonne À faire |
| Cocher une carte · la glisser | la termine · la change de colonne |
| Clic sur un projet | filtre **le journal et les tâches** en même temps |
| **Rechercher** | cherche dans les titres, le corps des entrées et les tâches |
| **Créer une tâche liée** dans une entrée | crée une tâche avec cette entrée comme contexte |
| **Exporter** | télécharge toute la base en JSON |

Markdown géré : titres, gras/italique, listes, **cases à cocher**, **tableaux**,
citations, blocs de code, liens, images.

Les documents riches s’enregistrent automatiquement en local ; l’export JSON conserve
leur mise en forme. En desktop, ouvre **Google Drive**, importe le JSON du client OAuth
desktop créé dans Google Cloud, puis connecte-toi et autorise tes documents.
L’édition se fait dans WorkLogs ; Google utilise le navigateur pour la connexion et
l’autorisation des fichiers. **Enregistrer sur Drive** envoie les changements.
La première synchronisation couvre texte, titres, styles usuels et listes simples.
Les documents Google complexes sont refusés avant import/écriture ; tableaux et images
fonctionnent localement. OAuth et les API sont testés avec des réponses simulées ;
la recette sur un vrai compte reste à faire. [Configuration et limites](docs/08-GOOGLE-DOCS.md).

Dans le dialogue **Gérer Google Drive**, **Sauvegardes WorkLogs** enregistre le JSON de la base dans Drive et permet de le restaurer sur un autre PC connecté au même compte. La restauration remplace les données locales après confirmation ; les octets des pièces jointes locales ne font pas partie du JSON.

## Tester

```bash
npm test            # API (node:test) + front (vitest)
npm run test:e2e    # parcours réels dans un navigateur (playwright)
./scripts/check.sh  # tout : types + tests + build + navigateur + desktop
```

## Sauvegarder

```bash
./scripts/backup.sh     # → ~/WorkLogs-backups/worklogs-AAAAMMJJ-HHMMSS/
```

## Documentation

La plupart des docs sont en français ; les notes de release et le
[`README.md`](README.md) sont en anglais.

| Doc | Pour qui | Contenu |
|---|---|---|
| `docs/00-HANDOVER.md` | **tous, en premier** | état du projet, reprise en 3 commandes, check-list |
| `docs/01-ARCHITECTURE.md` | dev / agent | schéma de la base, référence de l'API, structure du front |
| `docs/02-DEV.md` | dev / agent | installation, tests, conventions, pièges |
| `docs/03-UTILISATION.md` | Timo | l'écran, le Markdown, l'impression, les sauvegardes |
| `docs/04-RECETTES.md` | dev / agent | « comment faire X » : ajouter un champ, migrer, dépanner, livrer |
| `docs/05-DECISIONS.md` | dev / agent | **pourquoi** c'est comme ça, et ce qui a été retiré exprès |
| `docs/06-DESKTOP-CICD.md` | dev / agent | dossier du desktop Linux : bugs trouvés, packaging, CI |
| `docs/07-RELEASES.md` | dev / agent | **process de release** : versionnage, fast path, notes, check-list |
| `AGENTS.md` · `CLAUDE.md` | agents | les règles, en une page |

Données : `api/data/worklogs.db` (SQLite) et `api/data/uploads/` — jamais versionnées.
