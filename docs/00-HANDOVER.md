# 🤝 WorkLogs — fiche de relève (LIRE EN PREMIER)

> **Mise à jour :** 2026-09-16 · **Version : v0.14.0**.
> **Lot courant :** associations tâches-documents, projet mémorisé et gestion Google Drive en dialogue.
> **Validation :** `./scripts/check.sh` vert après le lot : 105 tests API, 98 front, 32 desktop unitaires,
> 16 scripts, 24 navigateur et 10 desktop e2e.
>
> **Lot précédent :** redimensionnement des barres latérales au glissement, fusionné
> sur master avec la correction du focus clavier Google de la v0.12.1.
> **Deux courses e2e restent non élucidées : point 0 de « Ce qui reste à faire ».**
> **Reprise prioritaire : [08-GOOGLE-DOCS.md](08-GOOGLE-DOCS.md)** pour le diagnostic
> réel, les capacités de l’éditeur et les limites Google.

## Lot du 2026-09-16 — associations, projet courant et Google Drive séparé

- `task_entries` relie plusieurs tâches à plusieurs entrées, qu'elles soient locales ou des onglets Google.
  `/api/state` renvoie les résumés des documents associés ; les associations sont exportées et nettoyées
  par cascade lors de la suppression d'une tâche ou d'une entrée.
- Chaque carte de tâche affiche ses documents de contexte, leur origine, un accès direct au centre,
  le retrait et un sélecteur **Relier un document**.
- Le projet actif est mémorisé dans `localStorage`. Un projet supprimé ou inconnu revient à **Tout**.
- Google Drive n'occupe plus la liste du journal : **Gérer Google Drive** ouvre un dialogue dédié
  pour OAuth, sélection, création, liste et déconnexion. Les entrées Google restent des documents
  normaux du journal et leur suppression locale ne contacte jamais Google.
- Aucune dépendance ajoutée. Tests API, front, navigateur, desktop et build verts.
- Version **0.14.0** : manifeste et lockfile synchronisés ; publication via les workflows
  `CI Linux`, `Release Linux` et `Dépôts` décrits dans `07-RELEASES.md`.

## Lot du 2026-09-16 — largeurs des barres latérales au glissement

- Poignées entre le journal, le document et les tâches : ajustement en direct,
  capture du pointeur jusqu’au relâchement, arrêt sur annulation du geste.
- Largeurs mémorisées dans les mêmes préférences que les champs existants ;
  réglage au clavier et bouton « Par défaut » conservés.
- La grille utilise aussi ces largeurs pour Google Docs et les fenêtres moyennes,
  tout en réservant 320 px au centre. Les poignées disparaissent lorsque les
  panneaux sont masqués ou empilés, ainsi qu’à l’impression.
- `ColumnResizer.tsx`, styles et tests navigateur/desktop ; aucune dépendance ajoutée.
- Validation : `./scripts/check.sh` vert avant et après le lot (**270 tests** après),
  dont glissement des deux côtés, annulation, mémorisation, clavier, petits écrans
  et position de la vue Google native pendant le redimensionnement.
- Fusion avec la correction du focus clavier Google : **272 tests**, `CHECK OK`.
  Version **0.13.0**, manifeste et lockfile synchronisés ; publication via les
  workflows `CI Linux`, `Release Linux` et `Dépôts` décrits dans `07-RELEASES.md`.
- La CI du merge (`35106209108`) a révélé de nouveau la course du plan de l’éditeur
  riche. Focus rendu immédiatement après la sélection du titre ; test déterministe
  de non-régression ajouté et réessais de cette recette retirés. Détail au point 0.
  Validation complète après correction : **273 tests**, `CHECK OK`.

## Lot du 2026-09-15 (2) — éditeur Google Docs natif dans WorkLogs

Branche `codex/google-docs-integrated-editor`, sur les sources **0.10.0**, sans bump ni
release. Bilan complet en tête de [08-GOOGLE-DOCS.md](08-GOOGLE-DOCS.md) ; le pourquoi
est en [05-DECISIONS.md §14](05-DECISIONS.md).

- La vraie page Google Docs s’affiche dans la colonne centrale (`WebContentsView` dans
  une session isolée, sans preload ni Node), positionnée au pixel par le rendu React.
  Menus déroulants, images et suggestions deviennent modifiables — par Google.
- « Copie locale » quitte Google, réimporte le document et actualise les onglets intacts.
  Un brouillon en attente est envoyé avant d’ouvrir l’éditeur complet, ou rien ne s’ouvre.
- `api/src/google-merge.js` : fusion à trois versions. Corrections indépendantes
  réconciliées, même passage modifié des deux côtés = conflit 409, brouillon conservé.
- `Ctrl+P` et *Imprimer* passent la main à Google quand son éditeur est affiché ; fermer
  la fenêtre respecte son avertissement « modifications en cours ».
- Navigation bornée à quatre hôtes Google en HTTPS ; `/o/oauth2…` reste au navigateur
  système (politique Google). Permissions refusées par défaut.
- Une seule vue Google vivante : ouvrir le document suivant libère le précédent,
  sauf s’il enregistre encore — sans dialogue, puisqu’on n’a pas demandé sa fermeture.
- `./scripts/check.sh` : **270 tests**, `CHECK OK`, desktop compris.

**Connexion Google dans la vue intégrée : vérifiée par Timo le 15/09** sur sa session —
c’était le risque qui pouvait condamner le lot. L’`userAgent` d’Electron n’est pas déguisé
et ne doit pas l’être : si Google referme ce chemin un jour, consigner le refus plutôt que
contourner sa détection. Les cinq points restants (widgets, réconciliation, fermeture
pendant un enregistrement, enchaînement de documents, hors ligne) sont dans
`08-GOOGLE-DOCS.md`.

## Lot du 2026-09-15 — navigation et synchronisation Google

Branche `codex/google-docs-layout-sync`, sur les sources **0.9.1**, sans bump ni release.
Le bilan en tête de [08-GOOGLE-DOCS.md](08-GOOGLE-DOCS.md) remplace les limites historiques.

- Ouverture directe de tous les onglets, navigation verticale/recherche/clavier,
  sous-onglets indentés et journal regroupé même si les dates diffèrent.
- Document agrandi, tâches repliables, états local/Google distincts, petits écrans.
- `google-preserve.js` : patches ciblés du texte/styles, cellules éditables,
  objets/widgets/suggestions conservés. Les commentaires ne bloquent plus l’import.
- Révisions partagées : une écriture ne crée plus de faux conflit sur l’onglet suivant.
- Anciens imports aplatis : récupération des imports intacts à la réouverture Drive ;
  copie/rechargement explicite lorsque le brouillon a changé.
- Vraie API : texte/emoji, titre, retrait, cellules, ajout de paragraphe et commentaire
  conservés sur un document temporaire, ensuite mis à la corbeille.
- Document existant vérifié en lecture seule : **11 onglets importés, 54 éléments
  conservés, aucune écriture produite pour les imports inchangés**.
- `./scripts/check.sh` : 244 tests, desktop compris. Une recette de surlignage/rechargement
  peut nécessiter sa relance prévue, comme observé avant ce lot.

Les menus déroulants, images, suggestions et changements de structure des tableaux
passent encore par Google Docs. Ne pas annoncer une parité complète.

## État vérifié du lot précédent

L’autre agent a publié v0.7.0 à v0.7.4 : documents riches/Drive, dépôt apt Mint,
corrections des lockfiles, de l’amorçage des tests, des projets vides, de PackageKit
(interaction polkit) et du focus après les dialogues natifs. Les workflows CI Linux,
Release Linux et Dépôts de v0.7.4 ont réussi. Ces changements sont conservés.
DEB/RPM/AppImage, SHA256 et attestations restent distribués par la pipeline existante.

Le lot courant ajoute :

- Recherche/remplacement littéral avec casse, navigation, surbrillance et annulation ;
  titres 1–6, plan cliquable, couleurs, effacement du format, citations, code, séparateurs,
  retraits de listes, tableaux complets et description/dimensions des images.
- **Créer un Google Docs** directement dans le panneau Drive, puis éditer dans WorkLogs.
- Diagnostics Google précis et lien d’activation de l’API concernée ; sélection Drive
  conservée après redémarrage, récupération des fichiers sélectionnés hors index.
- Choix d’un onglet Google (y compris imbriqué), avec un brouillon distinct par onglet.
  Toutes les écritures ciblent cet onglet ; les contenus incompatibles sont signalés.
- Migration transactionnelle de `google_documents` : ajout `tab_id`, unicité
  `(document_id, tab_id)`, conservation des associations, révisions et brouillons v0.7.x.
- Aucune nouvelle dépendance.

**Incident réel résolu :** OAuth fonctionnait mais les API Drive **et** Docs étaient
 désactivées dans le projet Google Cloud. L’utilisateur les a activées ; liste et lecture
réelles répondent maintenant 200. Un onglet compatible du fichier existant a été ouvert
avec succès dans une base de test isolée, sans modifier l’original.

**Aller-retour Google réel validé le 14/09 :** création d’un document temporaire, édition
locale, envoi, relecture texte/gras/titre, conflit après modification distante et
rechargement. Le document de recette a été placé dans la corbeille. Aucun jeton ni
contenu privé n’a été ajouté au dépôt. La connexion desktop existante a été conservée.

**Validation :** voir le bilan à jour dans `08-GOOGLE-DOCS.md` et lancer
`./scripts/check.sh` avant tout nouveau lot.

## Ce qui reste à faire

0. **Deux courses encore non élucidées dans les recettes e2e** — sorties le 15/09, aucune
   reproductible en local, toutes vues sous contention CPU sur agent CI :
   | Recette | Symptôme observé |
   |---|---|
   | `e2e/rich-document.spec.ts:87` recherche/remplacement | « Remplacer » s'applique **deux fois**, avec l'ancienne puis la nouvelle valeur (`<b>$&</b> Salut BONJOUR` au lieu de `Salut bonjour BONJOUR`) |
   | `desktop/e2e/desktop.spec.ts:105` document riche | le titre relu vaut `"Sans titrere"` au lieu de `"Sans titre"` |

   **Course du plan corrigée le 16/09.** Le run `35106209108` conservait déjà les deux
   textes fusionnés avant le rechargement. Tiptap `focus()` programme un callback dans
   `requestAnimationFrame` : il pouvait remettre la sélection ProseMirror au début
   après `End`, avant l’événement natif `selectionchange`. Une sonde déterministe
   rejoue cet ordre : offset DOM **17 → 0** avant correction, **17 → 17** après.
   Le clic du plan sélectionne maintenant le titre puis rend le focus immédiatement
   via `editor.view.focus()`. Test dédié sans délai ni retry ; les deux réessais
   de la recette titres 4–6 ont été retirés. Les anciennes sondes ci-dessous
   mesuraient la bonne position **avant** son écrasement différé.

   Mesures déjà faites, à ne pas refaire : 36 répétitions bridées à 1 cœur après le lot
   contre 18 avant — **aucune différence significative**, le signal « 2 contre 0 » initial
   était du bruit. Deux hypothèses de mécanisme ont été **infirmées par sonde** : le focus
   est bien dans l'éditeur immédiatement après le clic du plan, et la sélection DOM est
   bien posée (offset 0 → 17 après `End`, 3/3). La recette `titres 4–6` était déjà flaky
   sur master avant le lot (run `34968387999`, commit `4c9f506`, rattrapée au retry #1).

   Les trois symptômes avaient été observés avec un enchaînement **sous le frame** — remplir un champ et cliquer dans
   la même milliseconde, presser `End` dans le frame du clic — que Playwright produit et
   qu'un humain ne produit pas. C'est pourquoi la v0.12.0 a été publiée malgré elles.
   **Ce n'est pas une preuve qu'elles sont inatteignables à la main.**

   Piste pour le lot dédié : instrumenter plutôt que deviner — journaliser chaque appel à
   `replaceMatches` (valeur + horodatage) et chaque `update({title})` dans une build de
   recette, puis boucler la suite sous contention jusqu'à capture. Les traces des runs CI
   en échec sont téléchargeables 14 jours (`gh run download <id> -n test-reports`).

1. Étendre la conversion Google pour les tableaux, images, retraits personnalisés,
   commentaires et suggestions, avec tests de conservation. Ne jamais retirer les
   refus pour faire passer un import : plusieurs onglets du document réel contiennent
   des éléments encore incompatibles. La parité complète avec Google Docs n’est pas faite.
2. Publier ce nouveau lot si demandé : suivre `07-RELEASES.md`. La v0.7.4 installée
   ne contient pas ces améliorations ; `npm run desktop` utilise le code actuel.
3. Recette manuelle de l’icône, des dialogues système, de l’impression et d’une mise à
   jour sur Mint/Fedora. Les corrections de focus/polkit viennent de v0.7.3–v0.7.4.
4. Node local 24.13.0 reste inférieur au minimum annoncé par jsdom 30 (24.15.0),
   `.nvmrc` demande 24.20.0. Licence UNLICENSED et signature des dépôts restent ouverts.
5. Express reste en 4 : la migration en 5 casse les téléchargements ; lot distinct.

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
│   └── test/            tests node:test : API, migrations et Drive
├── web/src/
│   ├── App.tsx          l'écran : en-tête + 3 colonnes
│   ├── lib.ts           types, client API, helpers purs
│   ├── markdown.ts      marked + DOMPurify
│   ├── autosave.ts      cadence d'enregistrement automatique
│   ├── components/      EntryList · EntryEditor · RichEditor · GoogleDocsEditor · GoogleDrive ·
│   │                    DocumentTabs · TaskBoard · ProjectBar · UpdateBar · Logo
│   ├── styles.css       thèmes clair/sombre, typographie du document, feuille d'impression
│   └── *.test.ts(x)     tests vitest : gestes, sauvegarde, recherche riche et Drive
├── desktop/
│   ├── main.mjs         fenêtre Electron, protocole worklogs://, téléchargements, impression
│   ├── server.mjs       API + SQLite sur port éphémère local, protégés par jeton
│   ├── update.mjs       format installé, pré-vol PackageKit, installation pkexec, electron-updater
│   ├── google.mjs       OAuth desktop, trousseau, appels Google
│   ├── google-view.mjs  vue Google Docs isolée dans le canevas : adresses, navigation, fermeture
│   ├── preload.cjs      bridge minimal : fermeture après sauvegarde, vue Google
│   ├── test/            tests node:test (serveur + mises à jour + OAuth + vue Google)
│   └── e2e/            10 parcours Playwright (sources ou paquet via WORKLOGS_EXECUTABLE)
├── e2e/                 24 parcours Playwright (web)
├── scripts/             check.sh · backup.sh · stage-desktop · verify-package ·
│                        check-release · release-notes · blockmap  (+ 16 tests)
├── .github/workflows/   ci.yml · release.yml · repos.yml
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
| Aucun test | recette complète `./scripts/check.sh`, dont Google/éditeur riche |
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
| `08-GOOGLE-DOCS.md` | documents riches/Drive : fonctionnement, configuration, limites et recette réelle validée |

## 7. Pistes suivantes (non engagées)
Recherche plein texte FTS5 · import du JSON exporté · modèles d'entrée (compte rendu, décision) ·
export PDF sans passer par l'impression · rappels sur échéance.

## 8. Machine
Linux Mint 22.3 · Node v24.13.0 (`.nvmrc` demande **24.20.0**, cf. point ouvert n°2) · npm 11.6.2.
L'application ne tourne dans aucun conteneur ; Docker/Podman ne sert qu'à **essayer les paquets**
dans des images jetables (`scripts/test-linux-package.sh`, et la matrice de `ci.yml`).
Services web lancés en `screen` (`wl-api`, `wl-web`) — ils ne survivent pas au redémarrage.
