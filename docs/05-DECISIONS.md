# 🧭 WorkLogs — décisions

> Desktop **publié** depuis la 0.2.0, dernière release vérifiée : 0.7.4 :
> [dossier technique](06-DESKTOP-CICD.md), [process de release](07-RELEASES.md).

## Extension desktop, demandée le 2026-09-11

L’utilisateur demande Mint, Fedora, AppImage et une pipeline de tests/releases. Il a
explicitement approuvé **Electron 44.3.0 + electron-builder 26.15.3**. Ce choix réutilise
React, Express et `node:sqlite` en embarquant Chromium/Node. Le coût est un paquet plus
volumineux ; l’utilisateur final n’a pas de runtime Node à installer.

Les données desktop restent dans un dossier utilisateur, hors paquets. Une origine stable
`worklogs://app` conserve le thème malgré le port privé variable. Le jeton reste dans le
main ; le bridge IPC se limite à la fermeture après sauvegarde.

Docker sert **uniquement à essayer les installations**, jamais à lancer l'application : la
décision historique « pas de Docker » portait sur l'exécution, elle tient toujours. Les
décisions sur les trois étages de tests décrivent le socle web ; le desktop en ajoute deux
(tests serveur `node:test` et parcours Electron).

Le lot a été mené en trois temps : interrompu une première fois pour sauvegarde sur GitHub,
repris par un second agent qui a débloqué `check.sh` et validé les paquets sur les trois
cibles CI, puis mené jusqu'à la publication continue (19 releases, `v0.2.0` → `v0.6.12`).
Détail dans [06-DESKTOP-CICD.md](06-DESKTOP-CICD.md). Trois décisions techniques en ont
découlé, valables tant qu'Electron et Ubuntu se comportent ainsi :

- **Observer `will-download` sur `session.defaultSession`, pas `page.waitForEvent('download')`,
  dans les tests desktop.** Pour un téléchargement servi par un protocole personnalisé
  (`protocol.handle`), l'API haut niveau de Playwright ne voit jamais l'événement, alors que
  le téléchargement fonctionne réellement côté Electron. Ne pas revenir à `page.waitForEvent`
  en pensant « corriger » le test.
- **Construire nous-mêmes l'en-tête `Content-Disposition` (`attachmentHeader` dans `app.js`)
  plutôt que `res.download()`.** La bibliothèque sous-jacente n'émet `filename*=UTF-8''…`
  que si le nom n'est pas représentable en Latin-1 — jamais le cas des accents français —
  et Electron ne décode correctement ni l'un ni l'autre format pour un téléchargement via
  protocole personnalisé. `desktop/main.mjs` relit cet en-tête lui-même pour corriger le nom
  proposé dans la boîte de dialogue de sauvegarde.
- **Dépendance Debian `'libasound2t64 | libasound2'`, pas `libasound2` seul.** Sur Ubuntu
  24.04/Mint 22.x, `libasound2` (virtuel) peut être satisfait par `liboss4-salsa-asound2`, une
  couche de compatibilité OSS incomplète qui empêche l'application de démarrer
  (`undefined symbol`). Un bug Ubuntu connu, pas une erreur de configuration locale.

Ces trois points, et le détail complet des investigations, sont dans `06-DESKTOP-CICD.md`.

## Onglets Google : tout est modifiable, seul l'envoi peut être bloqué

**Décision.** Ouvrir un document Google crée **tous** ses onglets d'un coup, sous une seule
ligne du journal. Chaque onglet est **modifiable**, sans exception. Quand un onglet contient un
élément que le convertisseur ne sait pas réécrire (tableau, image, note de bas de page,
suggestion, retrait personnalisé…), c'est **l'envoi vers Google** qui est refusé, pas l'édition.

**Pourquoi.** L'écriture vers Google remplace le contenu de l'onglet. Renvoyer un onglet dont
nous ne savons pas reproduire un élément l'effacerait **du vrai document**. Le refus protège
donc le document d'origine — mais il n'y a aucune raison d'empêcher de travailler en local :
la version locale est conservée et enregistrée normalement.

**Ce que ça coûte.** Un onglet marqué ⚠ diverge de Google tant que le convertisseur ne sait pas
le réécrire. L'utilisateur le voit : un bandeau dit quel élément bloque.

**Quand la rouvrir.** En étendant le convertisseur dans les deux sens. Les tableaux et les
images existent déjà dans le modèle local : ce sont les meilleurs candidats. Ne **jamais**
lever un refus sans savoir réécrire l'élément — ce serait une perte de données chez
l'utilisateur, pas un test qui passe.

---

Pourquoi c'est comme ça. À lire avant de proposer une « amélioration » : la plupart des choses
qui manquent manquent **exprès**.

Format : la décision, la raison, ce qu'elle coûte, et à quelle condition la rouvrir.

---

## 1. Un seul écran, pas de navigation

**Décision.** Journal à gauche, écriture au centre, tâches à droite. Ni onglet, ni menu, ni
routeur.

**Pourquoi.** La V1 avait sept onglets (Dashboard, Kanban, Todos, Agenda, Docs, Fichiers,
Projets) dont trois affichaient la même liste de tâches sous trois formes. Documenter son
travail demandait de savoir *où* aller ; noter une tâche pendant qu'on écrit demandait de
quitter ce qu'on écrivait. Sur un seul écran, écrire et organiser se font sans se déplacer.

**Ce que ça coûte.** Au-delà d'une cinquantaine d'entrées, la colonne de gauche devient longue.
La recherche et le filtre projet compensent ; c'est le prix accepté.

**Quand la rouvrir.** Si la colonne de gauche devient inutilisable en usage réel. La réponse
serait alors un regroupement par mois repliable — **pas** un onglet.

---

## 2. Ce qui a été retiré en V2, et pourquoi

| Retiré | Raison | Ce qui le remplace |
|---|---|---|
| Onglet **Agenda** (table `events`) | un événement noté nulle part ailleurs, jamais relu | une **entrée datée** — c'est le même geste |
| **Types Jira** (task/bug/story/epic/subtask) | cinq catégories pour un usage mono-personne | rien : le titre suffit |
| **4 priorités** (basse/moyenne/haute/urgente) | personne ne distingue « basse » de « moyenne » | l'**épingle** ★, binaire |
| **4 statuts** (todo/in_progress/review/done) | « revue » n'a de sens qu'à plusieurs | 3 colonnes : à faire / en cours / terminé |
| **Estimation en heures** | jamais remplie | rien |
| **`parent_id`** (sous-tâches) | exposé nulle part dans l'interface | rien ; des cases à cocher dans une entrée font le travail |
| Onglet **Fichiers** | fichiers flottants, rattachables à trois choses | pièces jointes **d'une entrée**, à côté du texte qu'elles illustrent |
| Onglet **Dashboard** | recopiait les autres onglets | le résumé de la semaine dans l'en-tête |

**Rien n'a été perdu** : la migration convertit les docs, les événements et les descriptions de
tâches en entrées de journal (`api/test/migration.test.js` le vérifie ligne à ligne).

**Quand rouvrir.** Sur un manque constaté à l'usage, pas sur une intuition. Une priorité
supplémentaire coûte un champ, un contrôle, un tri, un test et une ligne de doc — pour un gain
réel à démontrer.

---

## 3. Le code n'a pas rétréci — et c'est normal

| | V1 | V2 |
|---|---|---|
| Code applicatif (lignes non vides) | 1 084 | 1 403 |
| Tests | 0 | 1 298 |
| Écrans | 7 onglets | 1 |
| Tables | 5 | 4 |
| Colonnes de `tasks` | 13 | 9 |

La V2 est plus simple **à utiliser** et plus verbeuse **à lire**. Ce qui a grossi :

- la **migration V1→V2** (74 lignes) — code jetable, supprimable dès qu'aucune base V1 ne
  traîne, ainsi que le test qui va avec ;
- l'**amorçage** (45 lignes) — le mode d'emploi affiché à la première ouverture ;
- la **validation serveur** systématique, qui n'existait pas ;
- l'**enregistrement automatique**, les **pièces jointes**, les **deux thèmes**, la **feuille
  d'impression**.

Réduire le nombre de lignes n'était pas l'objectif ; réduire le nombre de décisions à prendre
pour écrire une note, si.

---

## 4. `/api/state` : un seul appel de lecture

**Décision.** Une requête renvoie projets + entrées (titre et extrait seulement) + tâches +
compteurs. Le front la rejoue après chaque mutation.

**Pourquoi.** Le front n'a aucun cache à tenir cohérent, aucune invalidation à raisonner :
il affiche ce que le serveur vient de dire. C'est ce qui permet à `App.tsx` de tenir en
159 lignes sans bibliothèque d'état.

**Ce que ça coûte.** Chaque mutation entraîne un aller-retour complet. Sur une base locale de
quelques centaines de lignes, c'est de l'ordre de la milliseconde.

**Quand la rouvrir.** Si `/api/state` dépasse quelques dizaines de millisecondes. La réponse
serait la pagination des entrées, pas un cache côté client.

---

## 5. Enregistrement automatique, pas de bouton

**Décision.** Six cents millisecondes après la dernière frappe, l'entrée part. `Ctrl+S` force.

**Pourquoi.** Un bouton « Enregistrer » est une occasion de perdre son texte. L'indicateur
« Enregistré / Enregistrement… / Échec » garde l'information visible sans réclamer un geste.

**Ce que ça coûte.** Pas d'annulation : ce qui est effacé est enregistré effacé. `./scripts/backup.sh`
est le filet.

**Le piège qu'il a fallu traiter.** `EntryEditor` est monté avec `key={entry.id}` : changer
d'entrée **remonte** le composant, donc un brouillon non enregistré ne peut pas atterrir sur
l'entrée suivante. Sans cela, cliquer vite d'une entrée à l'autre écrasait la mauvaise. Un test
dédié le verrouille (`ne remonte pas le brouillon d'une entrée sur une autre`).

---

## 6. `marked` + `DOMPurify` plutôt que du fait-maison

**Décision.** Deux dépendances (~35 Ko) pour le rendu Markdown.

**Pourquoi.** La V1 rendait le Markdown avec dix lignes d'expressions régulières : pas de
tableaux, pas de blocs de code, pas de liens, pas de cases à cocher. Or « documenter avec une
belle mise en page » est la raison d'être de l'application — c'était le mauvais endroit où
économiser une dépendance.

**Pourquoi DOMPurify en plus.** Le HTML produit part dans `dangerouslySetInnerHTML`. Rien
n'empêche de coller du HTML dans une entrée. Trois tests couvrent l'assainissement
(`<script>`, attributs `onerror`, liens `javascript:`).

**Ce que ça coûte.** Deux dépendances à suivre. C'est le seul endroit où on a accepté d'en
ajouter au socle web.

---

## 7. Les tests du front tapent sur la vraie API

**Décision.** `web/src/test/server.ts` démarre `createApp()` sur une base jetable et détourne
`fetch`. Aucun faux serveur, aucune réponse simulée.

**Pourquoi.** Un faux serveur dérive du vrai sans prévenir : les tests restent verts pendant que
l'application casse. Ici, changer le contrat de l'API fait échouer les tests du front
immédiatement.

**Ce que ça coûte.** `npm test` prend une vingtaine de secondes au lieu de trois, et le front
dépend du code de l'API **en test seulement** (`vite.config.ts` la marque externe pour que Node
la charge telle quelle).

---

## 8. Trois étages de tests, chacun pour ce qu'il sait faire

| Étage | Ce qu'on y met | Ce qu'on n'y met pas |
|---|---|---|
| `api/test/` (node:test) | règles métier, validations, intégrité de la base, migration | rien qui concerne l'affichage |
| `web/src/*.test.tsx` (vitest + jsdom) | parcours complets, état, rendu Markdown | ce qui dépend d'une vraie mise en page |
| `e2e/` (Playwright) | glisser-déposer, envoi et téléchargement de fichier, impression, persistance après rechargement, styles calculés | ce qui se teste plus vite en dessous |

jsdom ne calcule pas de mise en page : tout ce qui touche à `getComputedStyle`, au glisser-déposer
natif ou à l'impression **doit** monter en e2e.

---

## 9. SQLite via `node:sqlite`, sans compilation

**Décision.** Le module natif de Node (≥ 22.5), synchrone.

**Pourquoi.** Zéro compilation, zéro service à lancer : `npm install` puis `npm run dev`. Le
fichier `worklogs.db` se copie, se sauvegarde, se lit avec Python.

**Ce que ça coûte.** Une API synchrone, donc bloquante : parfait pour un poste unique, à ne
jamais exposer à du trafic. Un avertissement « ExperimentalWarning » au démarrage — normal.

---

## 10. Pas d'authentification

**Décision.** Aucun compte, aucune session. CORS ouvert.

**Pourquoi.** L'application n'écoute que sur `localhost`, pour une personne.

**Quand la rouvrir.** Le jour où elle serait exposée au réseau. Ce jour-là, l'authentification
n'est pas une option mais un prérequis, et CORS doit être refermé dans le même mouvement.

---

## 11. Express 4 conservé, pour l'instant

**Décision.** Ne pas passer à Express 5 dans le lot V2.

**Pourquoi.** Express 4 entraîne `qs` avec deux avis de sécurité modérés. Sans effet ici :
localhost, mono-utilisateur, aucune entrée non fiable. Changer de version majeure au milieu
d'une refonte, c'est mélanger deux sources de panne.

**Quand la rouvrir.** Dans un lot dédié, avec `./scripts/check.sh` comme filet. Points à
vérifier : les motifs de route (`app.get(/.*/)`), `req.query` devenu non modifiable, le
middleware d'erreur.


## 12. Documents riches intégrés et Drive facultatif — 2026-09-14

**Demande explicite.** Ouvrir/éditer des documents Google dans WorkLogs. L’utilisateur
retient l’éditeur intégré et approuve Tiptap 3.31.3 avec les extensions d’`AGENTS.md`.
Le principe « sans cloud » devient « local par défaut, Drive facultatif ».

**Décision.** Nouveau document riche dans le journal existant, sans onglet ni routeur.
Les anciennes entrées restent en Markdown. Sauvegarde locale via la même file
`Autosave`, JSON validé côté serveur, copie locale incluant les fichiers.

**Google.** OAuth desktop avec PKCE, navigateur système et trousseau Linux, scope
`drive.file`. API disponibles seulement dans le serveur desktop protégé. Synchronisation
manuelle explicite, révision requise et refus des contenus incompatibles avant écriture.
Pas de conversion globale Markdown ni de promesse de parité avec l’éditeur Google.

**Recette réelle validée le 14/09.** OAuth était déjà configuré, mais Drive API et Docs API
étaient désactivées. Les réponses `SERVICE_DISABLED` doivent proposer l’activation de
l’API concernée, jamais être présentées comme un défaut de permission du document.
Après activation par l’utilisateur : liste, lecture, création, envoi, conflit et rechargement
réels réussis sur un document temporaire ensuite mis à la corbeille.

**Onglets Google.** Un document peut en contenir plusieurs, imbriqués. Un choix dans le
panneau Drive ouvre une entrée distincte pour chaque onglet, sans ajouter de navigation
à l’application. La clé de l’association devient `(document_id, tab_id)` ; la révision
reste celle du document et chaque opération transmet le `tabId`. Les autres onglets ne
sont pas réécrits. Un changement distant conserve la règle de conflit explicite.

**Éditeur.** Recherche/remplacement avec les primitives ProseMirror déjà installées,
recherche littérale entre marques, positions UTF-16, une transaction d’annulation,
limite de 2 000 décorations avec remplacement global désactivé au-delà. Les liens
s’éditent dans un formulaire intégré. Les commandes de tableau restent contextuelles.
Aucune dépendance supplémentaire. Configuration et limites : `08-GOOGLE-DOCS.md`.
