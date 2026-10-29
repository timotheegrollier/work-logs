# 🧭 WorkLogs — décisions

> Desktop **publié** depuis la 0.2.0, dernière release vérifiée : 0.10.0 :
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

## Onglets Google : modifications ciblées et objets natifs conservés

**Décision (2026-09-15).** Ouvrir un fichier Drive charge tous ses onglets sous une
seule ligne du journal. Ils se parcourent dans une liste verticale à côté du texte.
Les tâches se replient pour laisser de la place et restent accessibles.

La synchronisation compare les paragraphes/cellules avec la révision Google et envoie
seulement les insertions, suppressions et styles modifiés. Les indices viennent de
la réponse Google courante. Les écritures partent de la fin vers le début. Commentaires,
objets et styles non représentés restent dans Google. Un élément natif ne bloque plus
tout l’onglet : son repère reste conservé pendant l’édition du texte autour.

**Pourquoi.** L’ancien import en texte simple perdait la structure des tableaux et
rendait la synchronisation impossible. Enlever simplement les refus aurait effacé
le contenu du vrai document. Les patches évitent cette réécriture globale.

**Limites.** Menus déroulants, images, suggestions et changements de structure des
tableaux passent encore par Google Docs, via le lien vers l’onglet exact. Une opération
incompatible conserve le brouillon et explique quoi faire ; elle n’est jamais annoncée
enregistrée sur Google. Les anciennes copies aplaties modifiées nécessitent une copie
locale puis un rechargement, sans conversion automatique destructive.

**Validation.** Tests d’indices UTF-16, objets, tableaux, suggestions, révisions et
brouillons ; aller-retour Google réel détaillé dans `08-GOOGLE-DOCS.md`.

## Sauvegarde JSON Drive : fichier applicatif, remplacement explicite

**Décision (2026-09-17).** WorkLogs enregistre l’export JSON comme un vrai fichier `.json`
dans Drive, avec `appProperties` dédiées, puis permet de le restaurer sur une autre installation
connectée au même compte. La restauration remplace la base locale dans une transaction après
confirmation ; elle n’est jamais une synchronisation destructive automatique.

**Pourquoi.** Un Google Docs peut réécrire ou transformer le contenu et ne garantit pas un aller-retour
exact. `drive.file` suffit pour les fichiers créés par WorkLogs et conserve le contrôle par le fournisseur.
Le JSON conserve projets, entrées riches, tâches, associations et liens vers les onglets Google.

**Ce que ça coûte.** Les octets des pièces jointes locales ne sont pas dans cet export : le fichier
Drive conserve leurs métadonnées, mais la copie complète `scripts/backup.sh` reste nécessaire pour
migrer aussi les fichiers. Une restauration demande une confirmation claire et valide tout le document
avant d’écrire.

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

**Rouverte sur téléphone (2026-10-29, §53).** Les trois zones empilées faisaient une page de
4 000 px : sur téléphone seulement, la barre du bas montre une zone à la fois. Le desktop et
la tablette gardent l'écran unique.

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

**Réouverte le 2026-09-18** (demande d'usage : distinguer l'important dans la colonne).
Trois niveaux seulement (`low`/`normal`/`high`, défaut `normal`) — pas quatre : la leçon
« basse vs moyenne » tient toujours. Pas de tri automatique : l'ordre reste celui du
glisser-déposer, l'épingle reste la mise en avant. Migration additive, anciens exports
sans priorité restaurés en « normale ».

---

## 3. Le code n'a pas rétréci — et c'est normal

| | V1 | V2 |
|---|---|---|
| Code applicatif (lignes non vides) | 1 084 | 1 403 |
| Tests | 0 | 1 298 |
| Écrans | 7 onglets | 1 |
| Tables | 5 | 4 |
| Colonnes de `tasks` | 13 | 10 (priorité réintroduite le 2026-09-18, §2) |

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

## 13. La mise à jour in-app installe via `pkexec`, pas via `pkcon` — 2026-09-15

**Ce qu'on a essayé, et pourquoi ça ne pouvait pas marcher.** Trois versions de suite ont
tenté d'installer par une transaction PackageKit (`pkcon update worklogs`) : la 0.7.3 en
retirant `--noninteractive`, la 0.7.5 en réécrivant « y » sur l'entrée standard toutes les
500 ms. Les deux formes sont sans issue depuis une application graphique, reproduit sur
Linux Mint 22 dans une session Cinnamon dont l'agent polkit est bien enregistré :

```
printf 'y\n' | pkcon --cache-age 1 update worklogs
  → Erreur fatale: user declined simulation            (code 7, en 0,5 s)
pkcon --noninteractive --cache-age 1 update worklogs
  → État: Attente de l'authentification
    Erreur fatale: Failed to obtain authentication      (code 7)
```

Sans le drapeau, pkcon veut un **vrai terminal** pour sa confirmation et renonce seul.
Avec, il interdit à polkit d'afficher le moindre dialogue. Il n'existe pas de troisième
forme — c'est pourquoi ce chemin est fermé pour de bon, et documenté comme tel dans
`07-RELEASES.md` §8.

**Ce qui est en place.** `pkcon` garde ce qu'il fait bien : lire les mises à jour sans
demander d'autorisation (`refresh force` puis `get-updates`, action polkit
`system-sources-refresh` en `implicit active: yes`). L'installation passe à `pkexec` + le
gestionnaire natif — `apt-get install -y --only-upgrade worklogs`, `dnf upgrade -y
worklogs` —, l'outil précisément conçu pour demander l'autorisation à l'agent polkit de la
session puis exécuter en root. Chemins absolus obligatoires : `pkexec` nettoie
l'environnement. `Dpkg::Use-Pty=0` évite que dpkg noie la sortie sous des retours chariot.

**Pourquoi ça n'avait été vu par personne.** Les conteneurs de recette tournent en root,
sans polkit : ils ne peuvent révéler aucun de ces défauts, et rendaient les trois
tentatives « vertes ». La seule preuve qui compte ici est une vraie session graphique —
0.8.0 → 0.9.0 → 0.8.0 → 0.9.0, pré-vol et installation compris, sur la machine de
production.

**Le message d'erreur comptait autant que le mécanisme.** L'expression qui qualifiait
l'échec attrapait `declined`, donc « user declined simulation » était annoncé comme
« autorisation administrateur non accordée » — à quelqu'un à qui aucune fenêtre n'avait
rien demandé. Un diagnostic faux coûte plus cher qu'un message vague.
`isAuthorizationFailure` sépare les deux cas et un test l'ancre.

## 14. L'éditeur Google Docs est la vraie page Google, dans le canevas — 2026-09-15

**Le problème.** Le convertisseur maison est arrivé au bout de ce qu'il pouvait rendre.
Menus déroulants, images, suggestions actives, structure des tableaux : l'API Docs ne
fournit pas d'opération pour les modifier (§12 et `08-GOOGLE-DOCS.md`). Continuer à
élargir le sous-ensemble revenait à réécrire Google Docs. Le lien « Ouvrir dans Google
Docs ↗ » renvoyait l'utilisateur dans un navigateur — donc hors du seul écran.

**Décision.** Afficher la page Google elle-même dans la colonne centrale, comme une
`WebContentsView` de premier niveau que le rendu React positionne au pixel. Ce n'est
ni une `iframe` (Google les refuse), ni une `webview` (dépréciée, `will-attach-webview`
la bloque), ni une seconde fenêtre (l'application tient sur un écran). L'éditeur Tiptap
reste : « Copie locale » quitte Google, réimporte et redonne la main à WorkLogs.

**Ce qui est isolé.** Session `persist:google-docs` séparée, aucun preload, `sandbox`,
`contextIsolation`, `webSecurity`, pas de Node. La vue n'atteint jamais `worklogsDesktop`.
Navigation limitée à quatre hôtes Google en HTTPS, sans port ni identifiants dans l'URL ;
`/o/oauth2…` en est **exclu** pour que l'autorisation des API garde le navigateur système,
comme l'exige la politique OAuth de Google. Permissions refusées par défaut.

**La limite qu'on ne contourne pas.** Google refuse ses pages de connexion dans un
navigateur embarqué. WorkLogs ne déguise pas son `userAgent` pour y échapper : ce serait
contourner un contrôle de sécurité du fournisseur, et ça casserait au premier changement
de leur détection. Tant que la connexion d'un compte réel dans la vue n'a pas été faite,
ce chemin reste **non prouvé** — et c'est écrit tel quel dans `08-GOOGLE-DOCS.md`.

**Fusion plutôt que refus.** Jusqu'ici, toute modification distante bloquait l'envoi. Une
page Google éditée en direct rend ce refus permanent. `google-merge.js` fait une fusion à
trois versions sur le JSON normalisé : une correction locale et une correction distante
qui ne se touchent pas sont réconciliées, le même passage modifié des deux côtés reste un
conflit 409 avec le brouillon conservé. Conservateur exprès — une fusion silencieuse qui
se trompe coûte plus cher qu'un conflit à trancher.

**Une seule vue vivante.** Une page Google Docs affichée n'est pas un onglet inerte :
c'est une application qui continue de tourner, sans throttling puisqu'elle doit pouvoir
finir ses enregistrements. En garder une par document ouvert revenait à empiler des
sessions jusqu'à la fermeture de l'application. Ouvrir le document suivant libère donc
le précédent — mais par un `close({ waitForBeforeUnload: true })` : si Google signale un
enregistrement en cours, la vue survit et termine son envoi. Cette éviction ne pose
aucune question, parce que l'utilisateur n'a pas demandé la fermeture de ce document-là ;
seule une fermeture explicite (copie locale, fenêtre) affiche l'avertissement.

**Testable hors Electron.** `google-view.mjs` importe `electron` par défaut au lieu de ses
exports nommés : le module reste chargeable par `node --test`, donc ses contrôles
(adresse, navigation, dimensions, focus) ont de vrais tests unitaires et ne dépendent pas
d'un parcours graphique pour être vérifiés.

**Le clavier appartient à qui l'avait.** Une `WebContentsView` garde le focus même
masquée, réduite à zéro ou détruite : les frappes continuent d'y partir et les champs
WorkLogs — recherche, nouveau projet, nouvelle tâche — restent muets. Rien ne le rétablit,
sauf minimiser puis rouvrir la fenêtre, ce qui refait le choix de la cible et déguisait
donc le défaut en remède. `focusTarget()` tranche désormais en un seul endroit, testable :
la vue rend le clavier dès qu'elle cesse d'être visible, et au retour de la fenêtre elle ne
le reprend que si elle l'avait et qu'elle est encore affichée — jamais au détriment d'un
clic, qui a tranché avant nous. C'est la **deuxième** fois que ce piège mord ici : `ask()`
dans `main.mjs` le corrige déjà pour les dialogues natifs. Les tests automatisés ne le
voient pas tout seuls, Playwright injectant les frappes sans traverser cette couche : le
parcours de non-régression mesure donc `webContents.isFocused()` côté Electron.

## 15. L'aperçu des pièces jointes sert les mêmes octets en `inline` — 2026-09-18

**Le besoin.** Une pièce jointe ne pouvait qu'être téléchargée : `GET /api/files/:stored`
force `Content-Disposition: attachment`, donc cliquer sur le nom faisait sortir le fichier de
WorkLogs. Pour relire un PDF, une photo ou un compte rendu, il fallait ouvrir un autre
programme — l'application qui sert à relire son travail ne le montrait pas.

**Une seconde route, pas un changement de la première.** `GET /api/files/:stored/preview`
sert exactement les mêmes octets avec `Content-Disposition: inline` et le type MIME enregistré
à l'envoi. Modifier la route existante aurait été un piège : le nom RFC 6266 et le
téléchargement fonctionnent aujourd'hui, y compris en desktop, et tout casser pour un confort
d'affichage aurait été un mauvais échange. La route d'aperçu est additive ; le téléchargement
garde son comportement, et l'aperçu offre toujours un bouton **Télécharger**.

**Ce qu'on affiche, et ce qu'on annonce.** `web/src/file-preview.ts` classe la pièce jointe
sur l'extension **et** le type MIME : image, PDF et texte sont rendus par le navigateur, sans
dépendance ; les tableurs (`.xlsx`, `.ods`…) sont **annoncés** comme non affichables, avec le
téléchargement en solution. Décoder ces formats demanderait une bibliothèque (accord explicite
requis) et un rendu qu'on ne peut pas garantir fidèle : afficher du charabia serait pire que
de dire la vérité. Le `.csv`, lui, reste du texte et s'affiche très bien tel quel.

**Complété le 2026-09-22 : « Ouvrir avec… » et « Ouvrir dans Drive »** (sans dépendance).
Desktop : une **copie en lecture seule** sous le vrai nom, dans le dossier temporaire, est
confiée à `shell.openPath` (`desktop/open-file.mjs`). Jamais le fichier d'`uploads` lui-même :
une modification enregistrée dessus divergerait en silence de la copie Drive. Les types que
`xdg-open` exécuterait ou installerait (`.desktop`, `.sh`, `.AppImage`, `.deb`…) sont refusés.
PWA : feuille de partage (`navigator.share` avec le fichier), repli sur le téléchargement.
Fichier déjà sur Drive : lien `drive.google.com/file/d/<id>/view`, ouvert dans le navigateur.
L'aperçu intégré des tableurs (SheetJS) reste écarté : rendu non fidèle, dépendance ~1 Mo.

**Complété le 2026-09-24 : aperçu des `.docx`, toujours sans dépendance.** Un `.docx` est
un zip de XML : `DecompressionStream('deflate-raw')` et `DOMParser` suffisent
(`web/src/docx-preview.ts`, ~250 lignes). Rendu : titres (nom de style anglais canonique,
qui survit à « Titre1 »), paragraphes et alignement, gras/italique/souligné/barré, listes
imbriquées d'un seul tenant (numérotation continue), tableaux, liens http(s)/mailto,
images PNG/JPEG/GIF/BMP/WebP en `data:` (les CSP n'autorisent pas `blob:`). Écarté :
mise en page fine, en-têtes/pieds, zones de texte, EMF/WMF — l'aperçu le dit et renvoie
à « Ouvrir avec… ». Sécurité : éléments React seulement, jamais de HTML brut ; lien
`javascript:` ignoré ; bornes contre les archives piégées (5 000 entrées, 40 Mo par
entrée **vérifiés pendant la décompression**, 20 000 blocs). L'ancien `.doc` (binaire)
reste sans aperçu.

**Corrigé le même jour : « Ouvrir avec… » sans réponse sur le desktop.** `shell.openPath`
attend la fin de `xdg-open`, qui selon le bureau ne rend la main qu'à la fermeture de
l'application ouverte : « Error invoking remote method 'worklogs:open-attachment': reply
was never sent ». `xdg-open` part maintenant détaché (`launchDetached`) ; on répond après
1,5 s ou dès un échec immédiat (code de sortie), sans attendre la fermeture.

**Types dangereux neutralisés.** Un `text/html` ou un `image/svg+xml` servi en `inline` dans
notre origine deviendrait du code actif. La route d'aperçu les renvoie en
`text/plain; charset=utf-8` avec `X-Content-Type-Options: nosniff`.

**Deux backends, un seul chemin.** Le service worker PWA intercepte `/api/files/` et sert le
binaire IndexedDB : il distingue maintenant `/preview` pour poser `inline` plutôt
qu'`attachment`. `path.basename` continue d'empêcher toute traversée de répertoire côté
serveur, et un `/preview` sur un nom inconnu répond 404 comme le téléchargement.

## 17. Suggestions IA : clé personnelle, endpoint unique, jamais d'auto-envoi — 2026-09-19

**Le besoin.** Découper une tâche en sous-tâches pertinentes sans les taper :
clé gratuite AI Studio + `gemini-3.5-flash-lite`, validé en direct (81 tokens).

**Décision.** BYOK plutôt que keyless (Pollinations) : pas de tiers imposé par
défaut, pas de limite anonyme subie (1 appel/15 s), qualité maîtrisée — au prix
d'un collage unique dans Paramètres. Un seul client OpenAI-compatible (pas de
SDK) : l'endpoint Gemini parle ce protocole avec une clé AI Studio, et
OpenRouter/autres restent utilisables en changeant l'URL. Un clic = un envoi du
titre seul ; sans clé, les boutons expliquent au lieu d'appeler. Chrome Prompt
API écartée : Gemini Nano absent d'Android et d'Electron.

**La clé ne vit jamais dans le dépôt** (public : vol de quota, révocation).
Défaut local non versionné (`.env.local` ignoré) pour les essais, collage en
Paramètres en prod. Les documents riches n'ont pas le bouton en v1 : leurs
cases demanderaient une transaction ProseMirror dédiée, pas un pis-aller.

**La CSP desktop doit laisser passer l'hôte IA.** Le renderer appelle l'endpoint
en direct, mais le document est servi par le serveur local (`desktop/server.mjs`,
relayed tel quel par le protocole `worklogs://`) : `connect-src 'self'` coupait
l'appel et Suggérer échouait en « IA injoignable ». L'allowlist reste limitée à
`https://generativelanguage.googleapis.com` (verrouillé par test) : un endpoint
personnalisé reste inutilisable côté desktop — c'est le prix assumé pour ne pas
ouvrir `connect-src` en grand et garder la garde anti-exfiltration.

**Révisé le 2026-09-23 : modèle par défaut `gemini-2.5-flash-lite`, un seul secours.**
Suggestions et mise en page « ne fonctionnaient plus » : aucun bug, `gemini-3.5-flash-lite`
(comme les autres 3.x flash) était saturé chez Google — 503 « high demand » ou 45–50 s par
réponse, au-delà des 30 s de WorkLogs ; `gemini-2.5-flash-lite` répondait en 1,5 s. Donc :
nouveau défaut ; l'ancien défaut enregistré dans les réglages est relu comme le nouveau ;
sur l'endpoint Gemini seulement, si le modèle choisi répond 500/502/503/504 ou ne répond
pas à mi-délai, **un** essai avec `gemini-2.5-flash-lite` (borné, jamais de boucle) ; et
un délai dépassé s'annonce « modèle surchargé » au lieu de « hors ligne », qui accusait à
tort la connexion. Vérifié en réel : mise en page avec le 3.5 saturé = 15,8 s au lieu d'un
échec.

**Re-révisé le 2026-09-24 : retour à `gemini-3.5-flash-lite`, secours `gemini-3.1-flash-lite`.**
Testé en direct avec une clé neuve : `gemini-3.5-flash-lite` répond « OK » en 0,7 s,
`gemini-3.1-flash-lite` en 3,2 s, `gemini-3.5-flash` aussi (avec un budget ≥ 200 jetons,
sa réflexion consommant le reste) — mais `gemini-2.5-flash-lite` est refusé en 404
« no longer available to new users ». Le défaut et le secours de la 0.37.1 ne marchent
donc que pour les anciennes clés ; pour les nouvelles, tout échouait. La migration
silencieuse est abandonnée avec : un modèle enregistré est gardé tel quel (il peut
marcher pour une ancienne clé), et le select des Paramètres ne propose que les trois
modèles validés en réel, avec bouton de diagnostic.

**Révisé le 2026-09-24 (soir) : une chaîne de secours plutôt qu'un secours unique.**
« Modèle surchargé » à chaque fonction IA d'une procédure. Mesures réelles (clé gratuite,
trois passages) : les trois modèles du select (`3.5-flash-lite`, `3.5-flash`,
`3.1-flash-lite`) répondaient 503 « high demand » en ~0,5 s ou traînaient 20–60 s ;
`3-flash-preview` et `2.5-flash` répondaient 3/3 en ~3 s. Google sert les clés gratuites
en dernier : aucun modèle n'est sûr seul. Donc, sur l'endpoint Gemini : le modèle choisi,
puis `GEMINI_FALLBACK_MODELS` (du plus fiable au moins fiable), **chaque modèle une fois**,
tranche de ⅔ du délai par modèle, budget total 1,5 × le délai ; on passe au suivant sur
5xx, délai, 404 (modèle absent pour la clé), 429 (quota compté par modèle) ou réponse
vide ; on s'arrête net sur clé refusée ou hors ligne. Le secours qui a répondu passe en
tête 10 minutes (mémoire vive), pour que seul le premier appel paie un modèle qui traîne.
Budget des sous-tâches : 300 → 1 024 jetons (les modèles à raisonnement décomptent leur
réflexion ; à 300, la réponse revenait tronquée). Vérifié en réel : 18/18 réponses avec
`3.5-flash-lite` saturé, 4–7 s d'ordinaire. **Défaut → `gemini-3-flash-preview`** (demande
explicite, 0.41.1), en tête du select avec `2.5-flash` ; libellés honnêtes pour les autres.
L'ancien défaut **exact** (`3.5-flash-lite`), enregistré avec la clé par les Paramètres, est
relu comme le nouveau : sans ça, le changement ne toucherait personne. Tout autre choix
enregistré reste intact (pas de migration silencieuse d'un choix réel).

**Révisé le 2026-10-29 : 8 000 jetons pour les textes, et une réponse coupée est refusée.**
Une procédure tirée d'une entrée s'arrêtait au milieu d'une étape (« Accéder à ») : mise
en page, procédures et notes partaient avec 1 200–1 500 jetons pour un texte court, et la
réflexion de `gemini-3-flash-preview` s'y décompte. Le budget devient un plafond fixe,
`DOCUMENT_MAX_TOKENS` = 8 000, la valeur déjà envoyée pour les longs textes : aucun
fournisseur n'est exclu de plus. Et `finish_reason: "length"` rend « Réponse IA coupée
avant la fin » au lieu d'un texte tronqué présenté comme complet. Pas de modèle suivant
dans ce cas : il aurait le même budget (une réponse **vide** passe toujours au suivant).

## 16. L'en-tête mobile se réorganise, sans hamburger — 2026-09-18

**Le besoin.** Sur un Pixel 9a (412 px), la barre entassait logo, version, recherche,
thème, panneaux, Exporter et Paramètres : tout se marchait dessus, cibles minuscules.
(Le lot a été rebasé sur v0.23.0, qui ajoutait le troisième panneau Écriture et le
bouton ⚙ Paramètres : quatre icônes en première ligne, trois boutons de panneaux.)

**Décision.** Réorganisation CSS seule, zéro JS : trois lignes (marque + icônes,
recherche pleine largeur, panneaux en trois grands boutons), cibles 44 px, version
masquée en mobile, Exporter et Paramètres en icônes à `aria-label` stable (noms exacts
inchangés). Pas de menu hamburger **pour l'en-tête** : les réglages ont déjà leur
dialogue ⚙ Paramètres, et les contrôles restants sont des interrupteurs de vue
instantanés — les enterrer dans un tiroir ajouterait état, focus et tests pour sept
contrôles qui tiennent en trois lignes une fois compactés.

**Ce que ça coûte.** Une ligne verticale de plus (~50 px) ; le contenu défilant
l'absorbe. Chaque icône mobile demande son `aria-label`, verrouillé par test.
Rouvrir si l'en-tête accueille un neuvième contrôle : ce sera le signe qu'il faut
sortir une action de la barre, pas d'y ajouter un tiroir.

## 18. Les procédures sont des entrées, pas une table — 2026-09-21

**Le besoin.** Rassembler par projet les modes d'emploi, documents et pièces jointes,
sans multiplier les concepts : une procédure s'écrit, s'imprime, se sauvegarde et se
synchronise exactement comme une entrée — parce que c'en est une (`entries.kind`,
`'note'` par défaut).

**Pas de nouvelle table.** Une table `procedures` aurait dupliqué le texte riche, les
pièces jointes, Google, la corbeille, le backup, l'outbox et la PWA. Le coût aurait été
une deuxième entrée sous un autre nom ; le gain, aucun. La colonne `kind` (migration
additive, défaut `'note'`) et le panneau `ProcedureList` (section repliable comme les
Archives, mêmes classes) suffisent : création, ouverture, suppression et archivage
passent par les chemins existants, et `/api/state` porte déjà tout l'écran — il expose
en plus `procedure_attachments`, les pièces jointes des procédures du filtre.

**Ce que ça coûte.** Un champ, une validation, un test par étage. Rouvrir si une
procédure doit un jour porter des données propres (étapes cochables persistées,
versionnage) : ce jour-là, une table fille liée à l'entrée vaudra mieux qu'un champ.

## 19. Connexion Google en un clic : client intégré, PWA sans secret — 2026-09-22

**Le besoin.** Brancher Drive exigeait de créer un client OAuth et de l'importer (desktop)
ou de coller ID + secret (PWA). Demande : « Se connecter avec Google », **facultatif**.
Ce n'est **pas** un verrou d'app : le §10 tient (desktop protégé par son jeton local,
PWA sur l'appareil) ; la connexion ne sert qu'à Drive et à afficher le compte.

**Client intégré, hors dépôt.** Le client « Application de bureau » vient des secrets CI
(`stage-desktop.mjs` écrit `google-default.json` dans le paquet). Google considère ce
secret comme non confidentiel pour une app installée, mais il reste hors de git (scanners,
rotation). L'ID du client Web est public par nature : variable de dépôt.

> **Corrigé le 2026-09-23 (§22)** : Google **refuse** d'échanger le code d'un client « Web »
> sans son secret, PKCE ou pas (`400 invalid_request — client_secret is missing`, mesuré
> contre la PWA en ligne). Le paragraphe suivant a cassé la connexion en un clic de la
> v0.35.0 à la v0.36.1 ; il reste pour l'historique.

**PWA sans secret.** Un client « Web » est confidentiel et la PWA est un site public :
publier son secret est interdit. Le flux utilise donc le code + PKCE (`response_type=code`)
et `access_type=offline`, sans secret dans le bundle ni dans l'échange du code. Quand Google
émet un `refresh_token`, il est conservé localement et renouvelle silencieusement le jeton
d'accès ; l'utilisateur ne reprend pas la session à chaque heure. Un ancien retour du flux
« jeton » (`response_type=token`) reste accepté pour ne pas casser les sessions déjà ouvertes,
mais ce flux ne peut pas être renouvelé. Un client personnel avec secret garde le même flux
code + PKCE, avec le secret envoyé uniquement à Google si le client l'exige.

**Identité minimale.** `openid email profile` en plus de `drive.file`, lus une fois via
`userinfo` pour l'affichage ; un échec n'empêche jamais Drive. **Avatar ajouté le 2026-09-22**
(demande explicite) : la CSP desktop autorisait déjà `img-src https:` ; seules les URL
`…googleusercontent.com` sont retenues, chargées en `referrerPolicy="no-referrer"`, avec
l'initiale sur une pastille si l'image échoue.

**Rouvrir si** Google refuse durablement les jetons de renouvellement pour les clients Web
publics, ou si un serveur WorkLogs hébergé apparaît (il pourrait gérer le renouvellement
côté serveur).

## 20. Synchro automatique par fusion, un seul fichier Drive — 2026-09-22

**Le besoin.** Connecté au même compte sur le PC et le téléphone, tout doit suivre sans
geste : à la première connexion d'un appareil, la sauvegarde du compte est chargée ; ensuite
chaque modification repart, tant qu'on est connecté. Choix validés : **fusion par élément**
(pas « dernier qui écrit gagne »), **PC et mobile**.

**Un seul fichier.** Le même `WorkLogs backup.json` que la sauvegarde manuelle, enrichi de
`deleted` (pierres tombales). Pas de fichier par appareil ni de journal d'opérations : Drive
reste lisible, restaurable à la main, et « Sauvegarder » devient simplement « synchroniser
maintenant » (plus jamais d'écrasement de ce que l'autre appareil a écrit).

**La fusion** (`api/src/sync-merge.js`, JS pur partagé, testé seul) : `updated_at` le plus
récent gagne par entrée, tâche, projet (les projets ont gagné `updated_at`) ; une suppression
gagne sur toute version antérieure, une modification postérieure ressuscite ; liens et pièces
jointes : union moins suppressions ; l'amorçage jamais modifié ne gagne jamais (sinon le
téléphone installé après le PC écraserait le mode d'emploi édité) ; deux copies locales du
même onglet Google : la plus récente reste. Pierres tombales purgées après 60 jours.

**Les moteurs.** Desktop : `api/src/google-sync.js`, dans le serveur (un middleware relance un
passage après toute écriture réussie, regroupée 4 s ; plus une minute ; application
transactionnelle via `restoreBackup`). PWA : `web/src/store/sync-web.ts` (signal de
`localApi`, 3 s ; minute ; retour sur l'onglet ; application *différentielle* et gardée :
une ligne modifiée pendant le passage n'est jamais écrasée, elle repart au passage suivant,
trois passages au plus). Le fichier distant n'est retéléchargé que si son `modifiedTime` a
bougé. L'écran se recharge quand la `revision` de synchro avance.

**Limites assumées.** Deux écritures simultanées du fichier : la seconde gagne sur Drive, mais
chaque appareil garde ses données et les renvoie au passage suivant — tout converge. Une
entrée ouverte dans l'éditeur n'est pas rafraîchie sous les doigts : la version distante
s'affiche à la réouverture ; si l'on continue d'écrire, la saisie (plus récente) gagne.
Pas de synchro en mode web/dev (`autoSync` seulement dans l'app desktop).

**Rouvrir si** la base dépasse ~10 Mo (le fichier entier circule à chaque changement) : il
faudra alors un fichier par appareil ou des deltas.

## 21. Documents Google dans leur propre fenêtre, menu du compte à la place de ⚙ — 2026-09-22

Le dialogue Drive mélangeait connexion, sauvegardes et liste des documents. Les documents ont
leur fenêtre (`GoogleDocuments.tsx`) ouverte depuis le menu du compte : ouvrir, ranger dans
un projet (toutes les copies-onglets du document), corbeille Google Drive (récupérable 30
jours, copie locale retirée), créer. Le menu du compte **remplace** le bouton ⚙ Paramètres,
même place et même taille : l'en-tête garde huit contrôles (§16 respecté). Déconnecté, il
reste l'accès aux Paramètres ; connecté, il montre l'avatar, l'état de synchro, et « Changer
de compte » (sélecteur de compte Google, `prompt=select_account`).


## 22. Relais de jetons pour la PWA (Cloudflare Worker) — 2026-09-23

**Le constat.** De la v0.35.0 à la v0.36.1, « Se connecter avec Google » échouait sur la PWA,
sans message : Google accepte l'autorisation, puis refuse d'échanger le code sans
`client_secret` pour un client « Application Web » (`400 invalid_request — client_secret is
missing`, mesuré le 2026-09-23 contre le client intégré ; avec un faux secret :
`401 invalid_client`). §19 supposait l'inverse ; les tests simulaient Google et ne pouvaient
pas le voir. Sans secret, seul le flux « jeton » aboutit : une heure, sans `refresh_token`.

**Le choix.** Un relais minuscule détient le secret : `oauth-proxy/worker.mjs`, Cloudflare
Worker sans dépendance. Il n'accepte que `POST /token` venant de la PWA (et de
`localhost:8411` en dev), et deux échanges : `authorization_code` (avec `code_verifier` et un
retour de la PWA) et `refresh_token`. Il ajoute le secret, rend la réponse de Google telle
quelle, ne stocke ni ne journalise rien ; `GET /` dit seulement si le secret est en place.
La PWA ne l'appelle que pour le client intégré (`VITE_GOOGLE_TOKEN_PROXY` au build) ; un client
personnel parle toujours à Google avec son propre secret. Sans relais ni secret, la PWA
repasse au flux « jeton » : la connexion en un clic ne peut plus casser de cette façon.
`wrangler` sert au déploiement via `npx`, sans entrer dans les dépendances.

**Pourquoi Cloudflare.** Gratuit (100 000 requêtes par jour, 10 ms de CPU par requête,
l'attente de Google non comptée ; la PWA en fait une à la connexion puis une par heure
d'usage), secret chiffré côté Cloudflare, pas de mise en veille. Écartés : Google Cloud Run
(carte bancaire exigée), Render (veille, 30 à 50 s au réveil), Apps Script (toujours
HTTP 200, 1 à 3 s par appel, aucun filtre d'origine).

**Limite assumée.** Un `refresh_token` volé sur l'appareil suffit, via le relais, à obtenir
de nouveaux jetons : le niveau d'un client public, comme le client desktop dont Google tient
le secret pour non confidentiel. Le filtre d'origine arrête les autres sites, pas un script
hors navigateur. Le secret, lui, ne quitte jamais Cloudflare.

**Rouvrir si** Google accepte un jour le code + PKCE sans secret pour les clients Web, ou si
le quota gratuit ne suffit plus.

## 23. IA dans les procédures : le Markdown comme pont — 2026-09-23

**Le besoin.** « ✨ Mettre en page » n'existait que pour les entrées Markdown ; une procédure
est un document riche (JSON de l'éditeur), les boutons IA y étaient masqués. Demande :
mise en page et « suggérer une procédure » dans l'éditeur de procédures.

**Le choix.** Le document riche part vers l'IA en Markdown (`rich-markdown.ts`,
`richToMarkdown`) et la réponse revient par `renderMarkdown` puis `generateJSON` de Tiptap,
avec **exactement** les extensions de l'éditeur (`rich-extensions.ts`, partagé), et passe
`validateDocument` du serveur avant d'être appliquée : ce qui s'affiche dans la proposition
s'enregistre. Liens et images hors des règles du serveur sont retirés (le texte reste), un
style que le serveur refuserait donne une erreur explicite plutôt qu'un enregistrement en
échec. Même relecture obligatoire que la mise en page Markdown : rien n'est écrit avant
« Appliquer », et rien si le contenu a changé pendant l'appel. « Suggérer une procédure »
remplace « Suggérer des sous-tâches » sur une procédure : l'IA garde ce qui est écrit, le
complète en étapes numérotées et écrit « à préciser » plutôt que d'inventer une valeur.

**Ce que ça coûte.** Le Markdown ne porte ni surlignage, ni couleurs, ni soulignement, ni
alignements : appliquer une proposition les remet à plat (la proposition le dit). Aucune
dépendance : `generateJSON` vient de `@tiptap/core`, déjà là.

**Pas pour les documents Google.** Leur JSON ne transite pas vers l'IA et n'est pas réécrit
en bloc : la synchronisation Google envoie des modifications ciblées (§ onglets Google).

**Rouvrir si** la perte de mise en forme gêne en usage réel : il faudrait alors faire
travailler l'IA en HTML, avec une validation plus fine.

## 24. En-tête allégé, journal en fil, cartes de tâche resserrées — 2026-09-24

**Le besoin.** « Retirer Exporter quand on est connecté à Google, et améliorer nettement
l'interface et l'ergonomie, desktop comme mobile. » L'en-tête portait dix contrôles, dont
des champs de largeur en pixels redondants avec les poignées ; l'éditeur empilait trois
boutons pleine largeur au-dessus du titre ; chaque tâche affichait « Normale » et deux
gros boutons pointillés.

**Décisions.**
- **Exporter** disparaît de l'en-tête quand une session Google est active (`connected` et
  non `expired`) : la synchro automatique (§20) garde déjà le fichier Drive à jour. Session
  expirée (PWA) ou pas de compte : le bouton revient, la sauvegarde reste possible.
- Les **largeurs au pixel près** passent dans Paramètres → Affichage (mêmes libellés
  accessibles). Les poignées (§ lot du 16/09) font le geste courant.
- Les **panneaux** deviennent un contrôle segmenté (même langage que Écrire / Lire) ; sur
  mobile, une **barre fixée en bas** — ce sont toujours des interrupteurs `aria-pressed`,
  pas des onglets : §1 et §16 tiennent (pas de hamburger, pas de mode). L'en-tête mobile
  perd ainsi une ligne.
- **Éditeur** : titre d'abord, puis réglages, puis une rangée de pastilles (tâche liée, IA).
  L'entrée locale n'est plus dans un `<details>` sans `<summary>`, qui affichait « Details ».
- **Tâches** : la priorité ne s'affiche que si elle s'écarte de la normale (§2 : trois
  niveaux, mais le défaut n'apprend rien) ; « ＋ Documents » et « ＋ Entrée liée » en pied de
  carte (noms accessibles inchangés).
- **Identité** : le journal devient un fil — une ligne relie les jours, un nœud par jour,
  plein pour aujourd'hui. C'est la seule signature ; le reste est plus calme (libellés en
  casse de phrase au lieu de petites capitales espacées, `--accent-solid` pour les aplats
  qui portent du blanc, pile de polices humanistes avant DejaVu Sans).

**Pas de police embarquée** : ce serait une dépendance (règle « zéro nouvelle dépendance »).
Le rendu dépend donc des polices du système ; à rouvrir si l'on accepte un fichier de police.


## 25. Dossier partagé : chacun son tour, sans perte — 2026-10-05

**Le besoin.** Les procédures et documents de l'équipe vivent dans un dossier du **TSE**
(serveur Windows), modifiés par les collègues dans Word et Excel, parfois LibreOffice ou
WorkLogs. Timo veut les modifier **des deux côtés**, dans WorkLogs, **chacun son tour** :
voir qui a le fichier, ne jamais écraser une version qu'il n'a pas vue, choisir en cas de
conflit, continuer hors ligne. Le poste Linux **monte le partage en SMB** (bureau ou VPN).
Un premier plan (export `.md` par presse-papier, pas de co-édition) a été écarté.

**Le choix.**
- **Le fichier du partage est la référence**, pas une copie importée. WorkLogs le lit par le
  montage, garde sur cet ordinateur chaque version **lue, envoyée ou mise de côté**
  (`<données>/shared-blobs`, adressées par empreinte SHA-256).
- **Brouillon d'abord, envoi explicite.** Le brouillon (le modèle de l'éditeur, en JSON)
  s'enregistre seul toutes les 600 ms, **sur cet ordinateur seulement** (§5 tient pour le
  local). Il ne part sur le partage que sur « Enregistrer sur le partage » ou `Ctrl+S` :
  les collègues ne voient jamais une version à moitié écrite.
- **Écriture gardée, sur place.** Le serveur ouvre le fichier en lecture-écriture, le relit
  par le même descripteur, compare son empreinte à la base du brouillon : différente → pas
  d'écriture, **conflit**. Sinon il tronque, écrit, `fsync`, puis relit pour vérifier. Sur
  place plutôt que fichier temporaire + renommage : on garde ACL NTFS, propriétaire et
  identité du fichier ; un renommage hériterait des droits du dossier. Une écriture
  interrompue n'est reprise que si le partage contient un **début** de nos octets.
- **Conflit : trois choix**, jamais automatique : garder ma version (la leur reste dans
  l'historique), prendre la leur (la mienne reste dans l'historique), garder les deux
  (`Nom (copie T. Grollier 2026-10-05 10h47).ext`, création exclusive à côté).
- **Les verrous informent ; seul Windows bloque.** WorkLogs lit le fichier propriétaire
  `~$…` de Word/Excel (nom de l'utilisateur Office) et le `.~lock.<nom>#` de LibreOffice ;
  le fichier s'ouvre alors en lecture seule (« Ouvert par Jean Dupont dans Word depuis
  10h42 »), avec « Écrire un brouillon quand même ». **Word et Excel ignorent les verrous
  des autres** : leur seul verrou est un fichier ouvert côté Windows, que le client CIFS
  Linux ne sait pas poser. Rien n'est perdu pour autant : l'envoi échoue tant que Windows
  tient le fichier (« envoi en attente », réessayé toutes les 30 s), et toute version
  enregistrée entre-temps est détectée par l'empreinte. Une fenêtre de quelques
  millisecondes reste entre la relecture et l'écriture ; la relecture après écriture la
  voit le plus souvent. La sonde d'écriture n'a lieu **qu'à l'envoi** : ouvrir en écriture
  pendant le sondage pourrait faire croire à Word que le fichier est pris.
- **Sondage, pas `inotify`** : il ne voit pas les modifications faites depuis le TSE. Le
  fichier ouvert est relu toutes les 5 s (fenêtre visible) et au retour du focus ; sans
  brouillon, la version du collègue s'affiche seule ; avec brouillon, un bandeau prévient.
  Empreinte recalculée seulement si taille ou date changent.
- **E/S bornées.** Un montage SMB figé bloquerait un appel `fs` des minutes. Tous les accès
  au partage passent par un `worker_threads` (`api/src/shared-io.js`) qui fait des appels
  synchrones sous délai (4 s, plus 1 s par Mo). Dépassement ou erreur réseau → disjoncteur
  ouvert, tout échoue aussitôt ; seule une sonde (toutes les 10 s) le referme ; un worker
  resté bloqué est abandonné (deux au plus, puis état « bloqué »). Le worker est `unref`
  **après** l'ajout de ses écouteurs (sinon il retient le processus) et lancé avec
  `execArgv: []` (il n'hérite pas de `--input-type=module`, qui casserait son code).
- **Un point de montage vide n'est pas le partage** : le type `statfs` relevé au choix du
  dossier (CIFS, SMB2/3, FUSE pour GVFS) est comparé à chaque contrôle. Différent → « non
  monté », rien n'est écrit dans le dossier local vide.
- **Le chemin ne se règle jamais par HTTP** : seulement par le dialogue natif du desktop
  (IPC `worklogs:shared-choose-root`) ou `WORKLOGS_SHARED_ROOT` (dev, recettes). Un
  renderer compromis ne peut pas le pointer sur `/`. La racine et le dossier personnel sont
  refusés.
- **Routes réservées à cet ordinateur** (`localOnly` : adresse et `Host` de bouclage,
  refus de `Sec-Fetch-Site: cross-site`). `api/src/server.js` écoute sur toutes les
  interfaces en mode dev : §10 supposait l'inverse ; la garde ne dépend pas de l'écoute.
- **Données de cette machine, sans clé étrangère** : `local_settings`,
  `shared_project_folders`, `shared_files`, `shared_versions`. `restoreBackup` vide et
  réinsère projets et entrées à chaque synchro (§20) : une cascade effacerait les liens,
  une restriction ferait échouer la synchro. Nettoyage explicite à la suppression d'un
  projet ; jamais exportées ni synchronisées ; une écriture partagée ne déclenche pas la
  synchro Drive.
- **Rétention** : les 30 dernières versions par fichier, 90 jours au plus, 1 Go au total —
  jamais la base, un brouillon, une version de conflit ou mise de côté.
- **Les formats se traitent dans le front** (le serveur n'a pas de `DOMParser`) et **ne
  réécrivent que ce qui a changé**. Lot 1 : `.txt`/`.md` (encodage et fins de ligne
  d'origine) et `.csv`/`.tsv` (séparateur `;` d'Excel français, Windows-1252, CRLF,
  guillemets ; chaque ligne garde son texte brut, une ligne intacte ressort à l'identique).
  `.docx` puis `.xlsx` suivent, par patch ciblé du XML d'origine (§26, §27 à venir).

**Amendements.** §1 : une section repliable dans la colonne Procédures, pas un onglet ni un
mode ; un fichier s'ouvre au centre comme une entrée. §4 : le partage a sa route
(`/api/shared/list`, sondée), hors de `/api/state` qui reste la base. §5 : deux états
(brouillon local enregistré seul ; partage sur geste). §10 : inchangé (WorkLogs reste local,
le partage passe par SMB) ; garde `localOnly`. §15 : « Ouvrir avec… » ouvrira le **vrai**
fichier du partage (lot 2) — la règle de la copie en lecture seule vaut pour `uploads/`.
§18 : la section vit avec les procédures. §20 : ces données restent sur la machine.
La section ne lit le partage que **colonne Procédures affichée** : pas de requête ni de
sondage sinon (une requête de plus au démarrage avait suffi à rendre instable un test qui
cliquait avant le chargement des projets).

**Hors périmètre, assumé.** Temps réel ; collègues seulement dans un navigateur (il
faudrait exposer WorkLogs, donc une authentification — décision à part) ; la PWA (un
navigateur n'atteint pas un partage SMB).

**À vérifier sur le vrai TSE** (règle « preuve avant annonce ») : `errno` quand Word tient le
fichier (attendu `EBUSY` en CIFS ; GVFS ?), règle des noms `~$` et décalages 54/55 sur la
version d'Office du TSE, LibreOffice qui affiche le verrou WorkLogs (lot 2), droits NTFS
inchangés après envoi, durée de blocage d'un `stat` VPN coupé, type `statfs` réel, chemin
rendu par le sélecteur pour un partage GVFS, dialecte SMB. Liste complète :
`00-HANDOVER.md`.

**Lot 2 (2026-10-05) — notre verrou, les projets, l'historique.**
- **La première frappe prend la main** : un `.~lock.<nom>#` au format LibreOffice
  (`Timothée Grollier (WorkLogs),timo,pc-timo,05.10.2026 10:47,worklogs:<instance>:<nonce>;`),
  que LibreOffice et les autres WorkLogs respectent. Refusée (fichier ouvert ailleurs) :
  l'éditeur passe en lecture seule, ce qui a été tapé reste en brouillon. Renouvelé chaque
  minute tant qu'on écrit ; rendu à la fermeture du fichier, après **10 min sans frappe**,
  et par le serveur sans nouvelles depuis **3 min** (onglet tué, veille). Les restes d'une
  session précédente sont rendus au démarrage, et à l'arrêt du desktop (2 s au plus).
  On ne retire **jamais** un verrou qui ne porte plus notre marque ; le `~$` de Word n'est
  jamais touché, même en reprise.
- **Verrou oublié** : celui d'un autre WorkLogs est renouvelé chaque minute ; s'il ne bouge
  pas pendant **3 min d'observation** (notre horloge seule : un décalage avec le TSE ne
  fausse rien), il est signalé « probablement oublié » et se reprend sur un clic confirmé.
  LibreOffice : 24 h. **LibreOffice ouvert sur cet ordinateur bloque aussi** (« Ouvrir
  avec… » puis taper dans WorkLogs écraserait l'un ou l'autre) ; seul notre propre verrou
  WorkLogs laisse la main.
- **Quitter un brouillon non envoyé** (Fermer, une entrée, un autre fichier, une création)
  demande : Envoyer sur le partage · Garder le brouillon ici · Annuler. Envoi en conflit ou
  en échec : on reste sur le fichier. Fermer la fenêtre ne demande rien (§ plus haut).
- **« Ouvrir avec… »** (desktop) ouvre **le vrai fichier** du partage, par la même route
  détachée que les pièces jointes et la même liste de types refusés. Refusé tant qu'un
  brouillon n'est pas envoyé ; notre verrou est rendu d'abord, l'application pose le sien.
  C'est aussi la voie des `.docx`/`.xlsx` en attendant leurs éditeurs.
- **Un sous-dossier par projet** (`shared_project_folders`) : le filtre de projet n'affiche
  que lui ; « Délier » rend tout le partage.
- **Historique** : « Restaurer » fait d'une version gardée le **brouillon** (modèle vide,
  octets de la version) — rien ne part avant l'envoi, qui garde sa protection habituelle.
- Nom affiché dans les verrous : Paramètres › Dossier partagé.

**v0.43.1 (2026-10-05) — se connecter par l'adresse, et GVFS.** Timo n'arrivait pas à ouvrir
le partage : rien n'était monté sur son Mint, et le sélecteur de dossiers ne sait choisir
qu'un dossier **déjà monté**, pas une adresse `smb://`.
- **Se connecter par l'adresse** (`desktop/shared-mount.mjs`, IPC `worklogs:shared-connect`) :
  `\\serveur\partage`, `//…` ou `smb://…` (+ sous-dossier). Déjà monté par GVFS → utilisé ;
  sinon `gio mount` (réussit si le trousseau a le mot de passe) ; sinon la fenêtre de
  connexion du gestionnaire de fichiers (`xdg-open smb://…`) et WorkLogs attend le montage
  (2 min). **Aucun identifiant ne passe par WorkLogs.** L'adresse est retenue
  (`shared.address`) : « Se reconnecter » quand le partage n'est plus monté (redémarrage).
  GVFS plutôt que CIFS : pas de `sudo`, pas de `/etc/fstab`, mêmes identifiants que Nemo.
- **GVFS refuse les lectures positionnées** (`ESPIPE`, mesuré sur un montage GVFS/FUSE de
  la machine de Timo) : le worker lit désormais **séquentiellement** partout, écrit
  séquentiellement sur un descripteur neuf, et n'utilise l'écriture positionnée (même
  descripteur que la relecture) qu'avec un repli `O_TRUNC` séquentiel si le montage la
  refuse. Test `api/test/shared-gvfs.test.js` sur une archive montée par GVFS (ignoré là où
  GVFS ne tourne pas). L'écriture sur un vrai partage SMB par GVFS reste à vérifier.
- Un `ENOENT` relance aussitôt le contrôle de montage : un partage démonté s'affiche
  « Non monté » avec « Se reconnecter », sans attendre le cache de 15 s.
- **v0.45.0 (2026-10-06) — la fenêtre du mot de passe ne s'ouvrait pas.** Sur le Mint de
  Timo (`\\172.16.1.20\D`), « Connexion à … » restait 2 min sans rien afficher, puis
  échouait. Cause mesurée : `xdg-open` passe, sous Cinnamon et GNOME, par `gio open`, qui
  refuse une adresse non montée (« L’emplacement indiqué n’est pas monté », code 2) **sans
  ouvrir de fenêtre** ; et WorkLogs ignorait cet échec. On lance désormais le **gestionnaire
  de fichiers lui-même** sur l'adresse (`nemo smb://…` ; Nautilus, Caja, Thunar ailleurs —
  celui du bureau d'abord), ce qui affiche sa fenêtre « Authentification requise » (vérifié
  sur la machine). Fenêtre impossible à ouvrir → erreur **aussitôt**, avec le chemin manuel.
- **v0.45.1 (2026-10-06) — le compte du partage.** `\\SRVMURGAT\Global\…` restait fermé :
  mesuré, les montages GVFS de Timo voyaient **exactement** ce que voit l'accès invité
  (`smbclient -N` : `D` listable, `Global` refusé). Le trousseau rejouait `TimotheeG`
  domaine `WORKGROUP` (« Se souvenir pour toujours »), compte que le serveur ne reconnaît
  pas ou qui n'a pas de droits réseau sur `Global` : aucune fenêtre ne redemandait.
  - Champ **« Compte »** facultatif (`SRVMURGAT\TonNom`) : il entre dans l'adresse donnée à
    GVFS (`smb://SRVMURGAT;TonNom@serveur/partage`), qui ne demande alors **que le mot de
    passe de ce compte** et ne rejoue pas un autre compte retenu (vérifié avec `gio`). Retenu
    (`shared.account`) pour « Se reconnecter ». Toujours aucun mot de passe dans WorkLogs.
  - Seul un montage **de ce compte** convient (`user=` du nom de montage GVFS) : un montage
    invité du même partage n'est plus réutilisé.
  - Refus d'accès dit comme tel : « Accès refusé … pour le compte avec lequel le partage est
    monté » au lieu de « n'existe pas » à la connexion ; sous le dossier lui-même dans l'arbre
    (`SHARED_DENIED`), au lieu d'un « Lecture… » sans fin, avec « Se connecter avec mon compte… ».

**Lot 5 (2026-10-06) — fusionner, chercher, l'arbre hors ligne.**
- **Fusionner** (`web/src/shared-merge.ts`) : fusion à trois voies — départ, ma version, la
  leur — à la **ligne** pour le texte et les CSV (fins de ligne et encodage gardés), à la
  **cellule** pour les classeurs (mes saisies posées sur leur fichier par `writeXlsx`, si
  leurs cellules n'ont pas bougé). Proposée seulement quand rien ne se touche ; deux lignes
  voisines modifiées chacune de son côté ne se touchent pas (une ligne de CSV = un
  enregistrement), deux insertions au même endroit si (l'ordre serait arbitraire). Le calcul
  est fait **dans le front** (il connaît les formats) ; le serveur (`POST /merge`) range les
  octets réunis comme « Fusion » dans l'historique et les **envoie avec leur version pour
  base** : l'écriture reste gardée, une troisième version arrivée entre-temps serait détectée.
  Pas de fusion des `.docx` : la structure d'un document ne se fusionne pas proprement à la
  ligne, il faudrait un éditeur de différences — on garde les trois choix.
- **Chercher** (`GET /search`) : noms seulement (pas le contenu : il faudrait lire chaque
  fichier par le réseau), sans casse ni accents, tous les mots. Parcours **borné** (100
  résultats, 3 000 dossiers, profondeur 12, 8 s) avec une opération du worker qui ne lit que
  noms et types (`names`), sans `stat` par fichier : sur GVFS chaque `stat` est un aller-retour
  réseau. Dossiers fermés au compte du montage passés et comptés.
- **Arbre hors ligne** : chaque liste vue est gardée (`shared_dirs`, 2 000 dossiers au plus,
  table de la machine, jamais exportée, oubliée quand on change de partage). Hors ligne, un
  dossier affiche sa dernière liste ; un fichier sans copie locale y est grisé.
- **Changer de racine** (vécu le 2026-10-06 : racine passée de `\\172.16.1.20\D` à
  `…\13. SI\00. PROCEDURE`, le projet work-logs restait relié à `Global` → « Fichier
  introuvable ») : les dossiers reliés aux projets sont traduits vers la nouvelle racine quand
  ils sont dedans, sinon le lien tombe. Un dossier absent se dit « Dossier introuvable » ; un
  projet relié à un dossier absent le dit, avec « Délier ».
- **Un dossier choisi dans un montage GVFS garde son adresse et son compte** (déduits du nom
  du montage, `smb-share:domain=…,server=…,share=…,user=…`) : « Se reconnecter » et le
  formulaire « Changer de dossier… » les reprennent — l'adresse par défaut est la dernière
  utilisée, pas une adresse de l'entreprise écrite dans le code.
- **Créer un fichier dans le partage** (demandé par Timo le 2026-10-06, à la place de « ranger
  une procédure » ; **aucune convention à contrôler**) : « ＋ Nouveau fichier… » — Word,
  Excel, Markdown, texte, CSV — dans la racine ou un dossier déplié. Les modèles sont faits
  dans le front (`web/src/new-files.ts`, zip neuf `createZip`) : minimaux mais complets
  (types de contenu, relations, styles Normal / Titre 1-3 en identifiants français de Word,
  feuille « Feuil1 », chaînes partagées), le document est titré de son nom. Texte et CSV en
  UTF-8 **avec BOM** (Bloc-notes et Excel du TSE lisent les accents), Markdown sans.
  `POST /create` crée **exclusivement** (`O_EXCL`) : un nom déjà pris est refusé, rien n'est
  écrasé ; noms refusés par Windows (`< > : " / \ | ? *`, `CON`, point final…) refusés avant.
   Le fichier existe aussitôt sur le partage (vide), puis s'édite comme les autres. Vérifiés :
   relus et réécrits par nos éditeurs, ouverts par LibreOffice (titre en `h1`, formule calculée).
   **Trouvé en route** : écrire plusieurs lignes neuves dans une feuille vide (`<sheetData/>`,
   comme l'écrit Excel) produisait deux remplacements au même endroit — le garde-fou XML
   refusait l'envoi ; les lignes ajoutées en fin forment désormais un seul bloc.
- **Supprimer un fichier du partage** (demandé par Timo le 2026-10-07) : `DELETE
  /api/shared/file` + `deleteGuarded` dans le worker (même délai borné que les autres
  opérations). La suppression est **gardée sur la dernière version vue** : si le fichier
  a changé depuis, rien n'est supprimé (`409 SHARED_STALE`, la version du collègue est
  gardée et rouvrir puis supprimer marche) ; un brouillon, un envoi en attente ou un
  conflit se règle d'abord, un fichier ouvert ailleurs (Word, Excel, LibreOffice, un
  autre WorkLogs) ne se supprime pas. Seuls les fichiers (les dossiers : point suivant) ; la ligne
  locale est oubliée, **l'historique reste** (restaurable en brouillon, qui repartirait
  comme une recréation gardée). UI : ✕ dans l'arbre et « Supprimer du partage » dans
  l'éditeur, avec confirmation ; l'éditeur se referme, l'arbre se recharge.
- **Dossiers : créer, renommer, supprimer** (demandé par Timo le 2026-10-08 : « créer/renommer/
  supprimer un dossier sur le serveur distant dans les procédures »). `POST /dir`,
  `POST /dir/rename`, `GET` puis `DELETE /dir`. Dans l'arbre : « ＋ Nouveau dossier… » et un
  bouton **⋯** par dossier (Renommer, Supprimer…) — pas ✎, déjà la pastille « brouillon ».
  - **Créer** : `mkdir` exclusif, noms refusés par Windows refusés avant, dossiers cachés
    aussi. Le dossier s'ouvre aussitôt : « Nouveau fichier » y va par défaut.
  - **Renommer** au même endroit, **sans rien remplacer** : `rename(2)` remplacerait un
    dossier vide du même nom, le worker vérifie d'abord (fenêtre de quelques µs). La casse
    seule (`procedure` → `Procedure`) passe par un nom provisoire `.~worklogs-…` : Windows ne
    distingue pas les deux, Linux prendrait l'un pour l'autre (« déjà pris », ou rien de fait
    sur CIFS). Les lignes de cette machine suivent (fichiers, historique, listes gardées,
    projets reliés), et le fichier ouvert au centre aussi.
  - **Refusé, pour renommer comme pour supprimer**, si un fichier du dossier est en route ici
    (brouillon, envoi en attente, conflit : l'éditeur écrirait ensuite à l'ancien chemin) ou
    ouvert par un collègue (`~$`, `.~lock#` lus dans le dossier, parcours borné) ; notre propre
    main est rendue avant. Windows refuse de son côté de renommer un dossier dont un fichier
    est ouvert (message « droits, ou fichier ouvert »).
  - **Supprimer avec le contenu, en deux temps** : le **bilan** (fichiers, sous-dossiers,
    taille, empreinte de ce contenu) qu'annonce la confirmation, puis la suppression **de ce
    contenu-là** — empreinte différente : `SHARED_STALE`, rien ne part. Chaque fichier est lu
    puis supprimé s'il a gardé taille et date (`deleteSeen`) : ses octets restent dans le
    magasin local (historique, rétention habituelle). Vignettes et restes de verrous partent
    sans être gardés. Les dossiers se retirent vides, du plus profond au dossier lui-même :
    un fichier arrivé entre-temps les garde. Au premier imprévu on s'arrête et le message dit
    ce qui est parti (`SHARED_DIR_PARTIAL`) ; pas de retour en arrière (recréer serait une
    écriture de plus sur le partage, qu'aucun collègue n'a demandée).
  - **Bornes** : 300 fichiers, 100 dossiers, profondeur 12, 200 Mo en tout, 100 Mo par fichier
    (chaque fichier est lu pour être gardé). Au-delà, ou avec un lien, un dossier caché, un
    sous-dossier fermé au compte : à faire depuis Windows.
  - **Corrigé en route** : un dossier dont le nom ressemble à un temporaire de Word
    (`20241231`, huit chiffres) restait caché de l'arbre et de la recherche. La règle des
    fichiers techniques ne vaut plus que pour les fichiers ; un dossier n'est caché que s'il
    commence par un point ou est un dossier système (`isTechnicalDirName`).
  - Pas faits, faute de demande : renommer un fichier, déplacer (glisser-déposer).
- Restait de l'idée « procédures ↔ partage » l'IA par le pont Markdown §23 : faite le 2026-10-08 (§30).

**Rouvrir si** Word doit voir le verrou WorkLogs (il faudrait tenir un descripteur Windows :
`libsmbclient`, dépendance native), ou si l'équipe veut écrire à plusieurs en même temps
(suite bureautique en ligne : Google, Microsoft 365, OnlyOffice/Collabora).

## 26. Documents Word du partage : réécrire au plus juste — 2026-10-05

**Le besoin.** Modifier dans WorkLogs les `.docx` que les collègues ouvrent dans Word sur le
TSE, sans abîmer leur mise en forme. Un éditeur qui reconvertirait tout le document (Word →
éditeur → Word) perdrait en route styles fins, en-têtes, champs, images ancrées : chaque envoi
dégraderait le fichier de l'équipe.

**Le choix : on ne réécrit que ce qui a changé.**
- `web/src/xml-scan.ts` lit le XML **en gardant les positions** de chaque élément ;
  `web/src/zip.ts` lit l'archive et la réécrit en **recopiant telles quelles** les entrées non
  touchées. Aucune dépendance : `DecompressionStream`/`CompressionStream`, CRC maison.
- `web/src/docx.ts` : chaque paragraphe garde sa **tranche XML d'origine**. Inchangé → recopié
  octet pour octet. Modifié → reconstruit sur son `<w:pPr>` (seuls `pStyle`, `jc` et le niveau
  `ilvl` sont retouchés) et sur les `<w:rPr>` de ses runs ; gras/italique/souligné/barré
  insérés **dans l'ordre du schéma** (`rStyle, rFonts, b, bCs, i, iCs…` — Word répare un
  document dont l'ordre est faux). Signets autour du paragraphe gardés ; un paragraphe né d'un
  Entrée hérite des propriétés de son voisin, sans `w14:paraId` ni signet en double. Les
  marqueurs du correcteur (`proofErr`) tombent quand le paragraphe est réécrit.
- **Objets conservés** (nœud `docxAtom`, non éditable, recopié tel quel) : tout paragraphe qui
  contient autre chose que du texte et des liens (image, champ, commentaire, note, modification
  suivie, saut de page, contrôle de contenu, équation), la table des matières, les tableaux à
  fusion verticale. Supprimer un objet le retire ; le coller ailleurs est refusé (identités en
  double = document à réparer).
- **Tableaux** simples : texte des cellules modifiable, structure (lignes, colonnes, fusions)
  intouchable — un changement de structure est refusé à l'envoi avec une explication. Seules
  les cellules modifiées sont réécrites.
- **Liens existants** : leur texte se modifie, leur balise d'origine et leur cible restent.
  Pas de création de lien (il faudrait ajouter des relations) : à faire dans Word.
- Propriétés du document (`docProps/core.xml`) : seul le texte de `lastModifiedBy` (nom des
  verrous), `modified` et `revision` change. En cas de conflit, ce `lastModifiedBy` du fichier
  du collègue dit **qui** a enregistré entre-temps.
- **Lecture seule motivée** : suivi des modifications actif (WorkLogs écrirait des changements
  non suivis dans un document que l'équipe suit), document protégé, OOXML strict.
- Garde-fou final : le `document.xml` produit est relu par `DOMParser` ; invalide → rien ne part.
- Schéma Tiptap **dédié** (`docx-extensions.ts`) plutôt que celui des entrées : couleurs,
  polices ou fusions de l'éditeur riche ne se ramènent pas à Word. Les listes sont des
  attributs de paragraphe (`numId`/`ilvl`), numéros et puces recalculés pour l'affichage.
- `setEditable(…, false)` : basculer en lecture seule (pendant l'envoi) n'est pas une
  modification — sans ce `false`, Tiptap en émettait une, recréait un brouillon juste après
  l'envoi et effaçait « Enregistré sur le partage » (vu par un parcours Playwright instable).

**Limites assumées (v1).** En-têtes et pieds de page, texte des notes, zones de texte, images
(insertion), création de tableaux et de liens, modification de structure de tableau : dans
Word (« Ouvrir avec… »). Rendu simplifié (polices et couleurs du thème non affichées).

**À vérifier sur le TSE** : ouvrir dans Word un document modifié par WorkLogs — aucune
réparation proposée, mise en forme, numérotation, en-tête et images intacts ; puis le faire
réenregistrer par un collègue et le rouvrir dans WorkLogs.

## 27. Classeurs Excel du partage : cellule par cellule — 2026-10-05

**Le besoin.** Modifier dans WorkLogs les `.xlsx` que les collègues ouvrent dans Excel sur le
TSE, sans toucher à ce qu'Excel seul sait faire : formules, graphiques, mises en forme
conditionnelles, validations, tableaux, tableaux croisés.

**Le choix : seules les cellules tapées sont réécrites** (`web/src/xlsx.ts`, sur `zip.ts` et
`xml-scan.ts` du §26 ; `ooxml.ts` porte ce que Word et Excel partagent : relations, propriétés).
- Dans la feuille, la balise `<c>` d'une cellule modifiée est remplacée ; référence `r`, style
  `s` et attributs d'origine gardés. Une cellule nouvelle prend le style de sa ligne ou de sa
  colonne et se place dans l'ordre ; une ligne nouvelle aussi. `dimension` et `spans` élargis.
- **Texte** : ajouté à la **fin** de `sharedStrings.xml` (compteurs `count`/`uniqueCount` à
  jour) ; une chaîne existante n'est **jamais** modifiée — d'autres cellules la partagent ; une
  chaîne identique sans mise en forme est réutilisée. Sans chaînes partagées : texte en ligne.
- **Saisie lue comme Excel en français**, sans deviner contre l'utilisateur
  (`xlsx-format.ts`) : `1 234,5`, `12,5 %`, `12,50 €` sont des nombres ; `'` force le texte ;
  une cellule au format texte garde le texte ; zéros de tête (`0123`) et numéros de plus de
  15 chiffres restent du texte ; une date (`05/10/2026`, `5/10`) n'est reconnue que dans une
  cellule **déjà** au format date (on ne crée pas de style) ; `VRAI`/`FAUX`.
- **Affichage à la française** des formats courants : nombres, milliers, pourcentages,
  monnaie (`[$€-40C]`), sections négatives, dates et heures (système 1900 et son faux
  29 février 1900, système 1904), erreurs (`#NOM?`, `#VALEUR!`…). Format inconnu → Standard :
  l'affichage peut différer d'Excel, jamais la valeur.
- **Formules** (`xlsx-formula.ts`) : Excel les enregistre en anglais et les affiche en
  français. La barre les montre en français ; on accepte les deux écritures (`=SOMME(A1;A3)`
  ou `=SUM(A1,A3)`), traduites pour ~100 fonctions courantes, `_xlfn.` ajouté aux fonctions
  récentes (`RECHERCHEX`…). **La syntaxe est vérifiée avant l'écriture** (grammaire d'Excel :
  opérateurs, appels, plages, feuilles, constantes) : une formule mal formée dans le fichier
  ferait proposer une « réparation » à Excel. Fautive → listée sous la grille, envoi refusé.
- **Recalcul** : WorkLogs ne calcule rien. `fullCalcOnLoad="1"` dans `<calcPr>` fait tout
  recalculer à Excel à l'ouverture. Mais LibreOffice, par défaut, **ne recalcule pas** un
  `.xlsx` au chargement (vérifié, 24.2 : il gardait l'ancien total) : les formules qui lisent,
  de proche en proche, une cellule modifiée — même feuille, autres feuilles, noms définis,
  formules recopiées décalées — **perdent leur valeur d'avant** (`<v>` retiré) ; Excel et
  LibreOffice les calculent alors, et WorkLogs affiche la formule plutôt qu'un chiffre périmé.
  Prudent : ce qui ne se lit pas dans le texte (`INDIRECT`, `DECALER`, tableaux structurés)
  compte comme dépendant ; une formule liée à un **autre classeur** garde sa valeur (elle ne
  se recalcule pas sans lui).
- **Chaîne de calcul** (`calcChain.xml`) : retirée — avec sa relation et son type de contenu —
  dès qu'une formule est ajoutée, remplacée ou effacée. Excel la reconstruit ; la garder
  fausse lui fait proposer une réparation.
- **Lecture seule motivée**, cellule par cellule : cellules fusionnées (sauf la première),
  en-têtes et totaux de tableaux, tableaux croisés, formule recopiée « maîtresse » (les
  autres en dépendent), formules matricielles, valeurs riches (image dans la cellule), cellules
  verrouillées d'une feuille protégée. Classeur entier : macros (`.xlsm`), mot de passe de
  modification ; OOXML strict refusé à l'ouverture.
- Une feuille à la fois, choisie dans une liste « Feuille » (masquées signalées) : **pas
  d'onglets** (règle du produit). Pas d'insertion de lignes ou colonnes au milieu : on ajoute
  en fin, en tapant dans la ligne ou la colonne libre.
- Brouillon = les saisies, cellule par cellule (`{feuille: {B3: '250'}}`) ; revenir à la
  valeur d'origine efface la modification. Rien de modifié → les octets d'origine.
- Garde-fou final : chaque XML produit est relu par `DOMParser` ; invalide → rien ne part.

**Limites assumées (v1).** Insérer/supprimer des lignes ou colonnes au milieu, mettre en
forme, créer une feuille, un graphique, un tableau : dans Excel (« Ouvrir avec… »). Les
retours à la ligne dans une cellule (Alt+Entrée) ne se tapent pas dans la barre.

**À vérifier sur le TSE** : ouvrir dans Excel un classeur modifié par WorkLogs — aucune
réparation proposée, totaux recalculés, graphiques et mises en forme intacts ; le faire
réenregistrer par un collègue et le rouvrir dans WorkLogs.

## 28. PWA sur Cloudflare Worker, mise à jour automatique — 2026-10-06

**Le constat.** La PWA (relais de jetons + front) vit sur un Cloudflare Worker unique
(`worklogs-google`, option B) : elle n’est plus hébergée sur gh-pages. Le problème :
avec un Worker, une mise à jour de l’application (bump de version, correctif web) ne
remet pas à jour la PWA en ligne automatiquement — il faudrait relancer
`npx wrangler deploy` à la main, et le flux « jeton » d’une heure redeviendrait la règle.

**Le choix.** Un workflow dédié `.github/workflows/pwa-cloudflare.yml` reconstruit la
PWA et redéploie le Worker dès qu’un commit arrive sur `master` (`web/**`,
`scripts/emit-sw.mjs`, `oauth-proxy/**`, `package.json`). Il déploie le Worker avec les
assets `web/dist/` (`[assets]` dans `wrangler.toml`) : `/` sert la PWA, `/token` le
relais. La variable de dépôt `GOOGLE_TOKEN_PROXY_URL` indique à la PWA l’adresse du
Worker (déjà injectée au build).

**Configuration hors git (une fois).** Secrets GitHub `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` ; variable `GOOGLE_TOKEN_PROXY_URL` ; `GOOGLE_WEB_CLIENT_ID`.
Déploiement initial du Worker fait à la main (`npx wrangler login` + `deploy`) avec le
secret du client Web `GOOGLE_CLIENT_SECRET` (`npx wrangler secret put`), décrit dans
`docs/08-GOOGLE-DOCS.md « Relais de jetons »`. `wrangler` n’est pas une dépendance
(`npx`).

**Pourquoi Cloudflare Workers.** Gratuit (100 000 requêtes/jour), pas de mise en veille,
secret chiffré côté fournisseur. Le Worker sert tout — front et relais — sur une seule
URL, ce qui évite les problèmes CORS et simplifie la configuration OAuth (un seul
redirect_uri). Limites : le Worker est un singleton (pas de versionning multi-URL, mais
le flux de mise à jour automatique compense), et le cache Workers doit être invalidé
si `sw.js` ou `index.html` changent — la PWA vérifie elle-même la disponibilité d’une
version fraîche au chargement.

**Pourquoi pas gh-pages uniquement.** `pwa.yml` (déjà présent) publie bien la PWA à la
racine de gh-pages à chaque push master — mais l’option B (Worker) est préférée pour le
relais de jetons et l’URL unique. Les deux workflows coexistent (concurrency `gh-pages`)
et ne doivent jamais s’exécuter en parallèle ; le futur choix (A vs B) est à revisiter si
un des deux cesse de couvrir un besoin.

## 29. Procédures en lecture par défaut, blocs de code d'un geste — 2026-10-06

**La demande.** « Pouvoir ajouter des blocs de code dans mes entrées/procédures ; les
procédures doivent aussi avoir le mode édition et lecture comme les entrées normales. »
Demande explicite d'un **mode** : la règle « rien de nouveau sans accord » est satisfaite,
et ce n'en est pas un nouveau — ce sont les deux modes que les entrées ont déjà.

**Ce qui manquait vraiment.** Le bloc de code existait (```` ``` ```` en Markdown, `{ }` dans
la barre riche), mais : une entrée Markdown n'offrait aucun bouton (il fallait connaître la
syntaxe) ; dans une procédure, coller trois commandes puis cliquer `{ }` donnait **trois
blocs**, un par paragraphe — le collage fait un paragraphe par ligne et Tiptap convertit
chaque paragraphe séparément. Et une procédure riche restait toujours en saisie, barre
d'outils comprise : « Modifier » dans la colonne n'y changeait rien de visible.

**Les choix.**
- **Lire / Écrire pour les procédures riches locales**, avec les règles des entrées : ouverte
  par son titre → Lire ; « Modifier » ou procédure neuve → Écrire. Lire, c'est **le même
  éditeur Tiptap non modifiable** (`readOnly` : ni barre, ni compteur, `aria-readonly`), pas
  un second rendu HTML qui pourrait diverger de ce qu'on écrit (images dimensionnées,
  tableaux, éléments Google). Les liens s'y ouvrent d'un clic.
- **Pas pour les documents Google** : ils gardent leur parcours (éditeur Google intégré,
  synchronisation) ; ni pour les documents riches du journal, que personne n'a demandés
  (le parcours desktop « reprise d'un document » s'y appuie).
- **`{ }` sur plusieurs lignes → un seul bloc** (`rich-code.ts`), une ligne par paragraphe,
  sauts de ligne manuels gardés, en une seule annulation ; ailleurs (une ligne, déjà du
  code, listes, tableaux) la bascule de Tiptap, inchangée.
- **`{ }` en mode Écrire des entrées Markdown** (`insertCodeFence`) : clôtures sur leurs
  propres lignes autour des lignes entières touchées, plus longues que tout ```` ``` ```` déjà
  présent, curseur rendu au textarea. Le symbole plutôt que « Bloc de code » en toutes
  lettres : même face que dans la barre riche, et la ligne Écrire/Lire ne déborde pas.

**Écartés.** Coloration syntaxique (dépendance `lowlight`/`highlight.js`, à demander) ;
bouton « Copier » sur les blocs en lecture (non demandé — à proposer) ; Tab qui indente
dans un bloc (`enableTabIndentation` existe, mais Tab ne sortirait plus de l'éditeur).

**Rouvrir si** les documents riches du journal doivent aussi s'ouvrir en lecture : il
suffit d'élargir `hasModes` dans `EntryEditor.tsx` (et d'adapter le parcours desktop).

## 29. Dossier partagé sur la PWA : un relais sur la VM du bureau, joint par Tailscale — 2026-10-07

**Le besoin.** Timo veut les procédures du TSE (`\\SRVMURGAT\…\00. PROCEDURE`) sur la PWA du
téléphone : lire, modifier, créer, comme sur le desktop. Un navigateur ne parle pas SMB et le
serveur est sur le réseau du bureau : il faut un relais.

**Le choix (Timo, 2026-10-07).** Un petit serveur sur **sa VM `172.16.1.203`** (`api/src/relay.js`),
joint par **Tailscale** (le téléphone `pixel-9a` est déjà dans son réseau), compte
`SRVMURGAT\TimothéeG` pour le montage. Écartés : le PC Linux comme passerelle (doit rester
allumé), une copie dans Google Drive (fichiers de l'entreprise hors de l'entreprise), le Wi-Fi
du bureau seul (certificat de l'AC interne à installer sur le téléphone), un service sur le
serveur Windows (le plus lourd).
- **Même code** : le relais crée un `shared-service` (verrous, envoi gardé, conflits, versions,
  création exclusive) et enregistre les mêmes routes ; la PWA utilise les mêmes composants, via
  `sharedClient(base, auth)` (`web/src/lib.ts`), dont le desktop est le cas `base = ''`.
- **Porte d'entrée** : un code d'accès aléatoire (32 octets, `Authorization: Bearer`, comparé en
  temps constant) au lieu de `localOnly` ; CORS limité à l'origine de la PWA, préliminaire
  « réseau privé » (`Access-Control-Allow-Private-Network`) accepté. Le relais écoute en local ;
  seul `tailscale serve` l'expose, en HTTPS avec un certificat `*.ts.net` valide, et **seulement
  au réseau Tailscale** : rien sur Internet.
- **Montage du seul dossier des procédures** (CIFS, sous-chemin du partage `D`) : la VM ne voit
  rien d'autre du serveur. Mot de passe dans `/etc/worklogs-relais/smb.cred` (root, 0600), saisi
  par Timo sur la VM — il ne passe pas par WorkLogs.
- **Projets** : ils vivent sur le téléphone, pas dans la base du relais : un dossier s'y relie à
  n'importe quel identifiant de projet (`projectsKnown: false`).
- Relais injoignable (Tailscale éteint, VM arrêtée) : la section reste, « Injoignable », et dit
  quoi vérifier, au lieu de disparaître.
- Le code d'accès reste sur le téléphone (stockage de la PWA), jamais synchronisé **en clair**.
  Depuis le 2026-10-21, une copie **chiffrée** vit dans le compte Google (§39).

**Limites assumées.** Hors réseau, rien (pas de copie hors ligne sur le téléphone : les
brouillons vivent sur le relais) ; un seul compte Windows pour tout ce qui passe par le relais
(les verrous portent « Timothée Grollier (mobile) »). Installation et dépannage : `09-RELAIS.md`.

**2026-10-07, publié en v0.52.0 — les dossiers reliés aux projets suivent les projets, par Drive.**
Timo veut retrouver sur le téléphone les liens projet ↔ dossier du TSE faits sur le PC.
Jusqu'ici ils vivaient dans une table **de la machine** (`shared_project_folders`, §25),
une sur le PC, une autre sur le relais. Ils sont désormais **un champ du projet**
(`projects.shared_dir`), synchronisé par Drive avec lui (fusion : la version la plus
récente du projet gagne, délier compris).
- Le champ porte l'**adresse complète** du dossier (`\\172.16.1.20\d\Global\…\00. PROCEDURE\2. TSE`),
  pas un chemin relatif : le PC et le relais n'ont pas forcément la même racine (le PC a
  monté tout `D` avant `00. PROCEDURE`). Chaque appareil la traduit sous sa racine
  (`web/src/shared-links.ts`), en comparant partage et chemin **sans le serveur ni la
  casse** (`SRVMURGAT` = `172.16.1.20`, `d` = `D`). Hors de sa racine : « relié à … qui
  n'est pas dans ce partage », tout le partage affiché, « Délier » possible.
- L'adresse de la racine de chaque appareil : déduite du montage GVFS (desktop) ou du
  montage CIFS lu dans `/proc/self/mountinfo` (relais) — `api/src/shared-address.js`.
  Sans adresse (dossier local, tests) : chemin relatif, comme avant.
- Les anciens liens (table de la machine, du PC ou du relais) sont **repris une fois** sur le
  projet à l'affichage de la section, puis effacés de la table.
- Les sauvegardes d'avant n'ont pas le champ : acceptées, aucun dossier relié. Une version
  plus ancienne de WorkLogs qui réécrirait le fichier Drive perdrait le champ : mettre à jour
  tous les appareils (le desktop par apt/dnf, la PWA se met à jour seule).
- Trouvé en route : le relais réécrivait à chaque démarrage le nom des verrous changé depuis
  le téléphone (statut lu comme s'il était synchrone) ; corrigé, test qui redémarre le relais.

## 30. IA dans les fichiers du partage, procédures concises — 2026-10-08

**La demande.** « Pouvoir utiliser les fonctions de mise en page et de suggestions dans les
procédures, afin qu'il suggère des procédures concises, basées sur le titre et le contenu de ce
qui a déjà été écrit. » Les deux boutons existaient pour les procédures du journal (§23), pas
pour les fichiers du dossier partagé — là où vivent désormais les procédures de l'équipe
(`00. PROCEDURE` : surtout des `.docx`, souvent avec captures d'écran, tableaux et sommaire).
§25 l'avait laissé « à redemander ».

**Les choix.**
- **Mêmes boutons, même relecture** : « ✨ Suggérer une procédure » et « ✨ Mettre en page »
  dans l'éditeur d'un `.docx`, `.md` ou `.txt` du partage. La proposition se relit, puis
  s'applique **comme une frappe** : un brouillon sur cet ordinateur (verrou pris comme à la
  première frappe), qui ne part sur le partage qu'avec « Enregistrer sur le partage » — §25
  tient. Refusée si le fichier a changé pendant l'appel ou a été rechargé. Lecture seule
  (verrou d'un collègue, conflit, envoi) : boutons inactifs. Pas pour les tableurs.
- **Concise, pour toutes les procédures** (celles du journal comprises, même consigne) : une
  phrase d'objectif ; prérequis et vérification seulement s'ils sont réels ; des étapes d'une
  ligne qui commencent par un verbe, 10 au plus (15 avant) ; rien de générique. Tout ce qui
  est déjà écrit est gardé — commandes et valeurs à l'identique, le reste raccourci si besoin
  — et « à préciser » remplace une valeur inventée. Le titre est celui du document (premier
  titre de niveau 1, `# …` en tête d'un `.md`), qui reste en tête et que l'IA ne réécrit pas ;
  sinon le nom du fichier. Le dossier part en contexte (« Dossier : Réseau/Imprimantes »).
- **« Automatiquement », c'est d'un clic**, pas à l'ouverture d'un fichier : §17 tient (jamais
  d'envoi sans geste), d'autant que ces fichiers sont ceux de l'entreprise. Les Paramètres
  disent ce qui part (nom, dossier, contenu du fichier ouvert).
- **Word par le Markdown, sans rien perdre** (`docx-markdown.ts`) :
  - images, tableaux, champs, sommaires partent en marqueurs `[[objet N : …]]` (avec un extrait
    de leur texte) et reviennent tels quels ; une réponse qui en perd un est **refusée** ;
  - un paragraphe dont l'IA garde le texte **reste celui d'origine** (runs, polices, liens,
    signets), octet pour octet s'il garde aussi sa forme (titre, liste, corps) ;
  - un paragraphe neuf prend les **styles du document** (titre du niveau voulu, style du texte
    courant, paragraphe de liste, liste numérotée existante) et les propriétés d'un paragraphe
    du même genre, nommé par `basedOn` (nouvel attribut du schéma) : avant, un paragraphe neuf
    héritait du dernier paragraphe d'origine écrit avant lui, bordure ou saut de page compris.
    Du run modèle, il ne garde que police, taille et langue — ni couleur, ni surlignage ;
  - un lien ne survit que vers une cible déjà dans le document (en créer un demanderait une
    relation), avec le style de son run ; une commande entre accents graves passe en Consolas.
- **Rien n'est créé dans styles.xml ni numbering.xml** (§26 : les autres parties ne sont jamais
  réécrites). Un niveau de titre que le document n'a pas devient du gras ; une liste sans
  numérotation à reprendre devient une numérotation écrite (« 1. », « • »). Deux listes
  numérotées ne partagent jamais la même liste Word (Word continuerait la numérotation de la
  première dans la seconde) : la seconde est écrite. Une liste qui reprend au numéro suivant
  après une image (« 3. ») reste la même liste.
- **À l'écriture, `numPr` suit la liste** : entrer dans une liste, en sortir ou en changer pose
  ou retire `numPr` à sa place (avant, seul le niveau se réécrivait).

**Ce que ça coûte.** Le Markdown ne porte ni souligné ni couleurs : un paragraphe réécrit les
perd (la proposition le dit). Les paragraphes vides disparaissent. Au-delà de 12 000 caractères,
la relecture est refusée. Les documents ainsi réécrits sont vérifiés par les tests et dans
Chromium, **pas encore ouverts dans Word sur le TSE** (règle « preuve avant annonce »).

**Rouvrir si** les documents créés par WorkLogs doivent avoir de vraies listes numérotées (le
modèle de `new-files.ts` n'a pas de numbering.xml : en ajouter un ne coûterait qu'une partie de
plus), ou si la perte de mise en forme gêne (travailler en HTML, comme le prévoit §23).

## 31. Procédure tirée d'une entrée ou d'une tâche par l'IA : créée à part, jamais liée — 2026-10-08

**La demande.** « Créer avec l'IA (Gemini) une procédure à partir d'une entrée/tâches. » On
note sur le moment ce qu'on a fait (une entrée, une tâche et ses notes) ; la procédure est ce
qu'on suivra la prochaine fois. Jusqu'ici, l'IA ne savait que compléter une procédure déjà
ouverte, à partir de son titre (§23).

**Les choix.**
- **Deux points d'entrée, un seul geste** : **✨ Créer une procédure** dans la rangée d'actions
  d'une note (Markdown ou document riche du journal), **✨ Procédure** au pied d'une carte de
  tâche. Même service IA que le reste (Paramètres, Gemini par défaut, chaîne de secours §17),
  même consigne (`draftProcedure`, `ai-suggest.ts`), même panneau de relecture
  (`ProcedureDraft.tsx`). Ni onglet, ni mode, ni dépendance, ni route : la procédure se crée
  par `POST /api/entries` (`kind: 'procedure'`), desktop comme PWA.
- **Ce qui part à l'IA.** Depuis une note : titre, projet, contenu (un document riche passe par
  le pont Markdown §23), noms des pièces jointes, titres des tâches liées. Depuis une tâche :
  titre, statut, projet, et le contenu de ses **5 documents liés** les plus récents. Plafond
  commun de 12 000 caractères : au-delà, le début seul part, marqué « […] », et la relecture
  le dit. Le texte coupé garde ses lignes (listes et blocs de code lisibles).
- **Un document Google ne transite pas** (§23) : pas de bouton sur une note Google ; depuis une
  tâche, il ne donne que son titre (« contenu non transmis »), sans même être relu.
- **La consigne** est concise comme celle de toutes les procédures (§30) : un titre en `# …`
  (à l'infinitif), une phrase d'objectif, des étapes d'une ligne (10 au plus), prérequis et
  vérification seulement s'ils sont réels. Elle **généralise** en plus (pas de récit, pas de
  dates), garde tels quels commandes, chemins, valeurs et blocs de code, et écrit « à préciser »
  plutôt que d'inventer. Le `# …` devient le titre proposé, modifiable avant création.
- **Relue avant d'exister** : rien n'est créé avant « Créer la procédure » ; « Rafraîchir »
  redemande, « Ignorer » abandonne. Ce qui s'affiche s'enregistre : même conversion et même
  validation serveur qu'« Appliquer la procédure » (`markdownToRich`).
- **Créée à part, jamais liée à sa source.** Terminer une tâche archive ses documents liés
  (`archiveTaskDocuments`) : une procédure liée disparaîtrait de la colonne Procédures dès la
  tâche terminée — c'est-à-dire au moment même où l'on écrit sa procédure. Elle naît donc dans
  le projet de sa source, sans `task_entries`, et la source ne change pas.
- **Ouverte aussitôt, en lecture** (`openCreatedProcedure`, `App.tsx`), comme une procédure
  ouverte depuis sa colonne. Une recherche en cours qui la masquerait est effacée ; l'état est
  relu une seule fois, sans l'ancienne recherche (sinon cette relecture pouvait répondre
  d'abord et refermer la procédure).

**Écartés.** Remplacer la note par une procédure (`kind` changé) : on perdrait le journal du
jour. Plusieurs tâches cochées pour une seule procédure : un mode de sélection à ajouter, non
demandé. Ouvrir d'office la colonne Procédures : elle rétrécirait l'éditeur sans qu'on l'ait
demandé ; la procédure s'ouvre au centre, et la colonne la montre dès qu'on l'affiche.

**Rouvrir si** une procédure doit garder trace de sa source (une ligne « Tirée de … » suffirait,
sans lien) ; si les documents Google doivent servir de source (lecture seule : seul le §23
l'interdit, pas une limite technique) ; si 12 000 caractères ne suffisent pas en usage réel.

## 32. Un titre vidé garde l'ancien ; la fermeture a toujours une sortie — 2026-10-08

**Constat.** Fenêtre impossible à fermer : « l'entrée n'a pas pu être enregistrée », « le
titre de l'entrée est requis », sans entrée sans titre au journal. Le titre avait été vidé
puis l'entrée quittée : l'éditeur démonté laissait derrière lui un brouillon en échec, que
la fermeture rejouait à chaque fois, et que « Revenir à l'entrée » ne permettait plus de
corriger. L'entrée, elle, portait toujours son ancien titre. Tout ce qui avait été écrit
après avoir vidé le titre n'était pas enregistré non plus.

**Décision.**
- Un titre vide n'est **pas envoyé** : l'entrée garde le dernier titre enregistré, montré en
  filigrane du champ vidé, et le reste du brouillon s'enregistre normalement. Le serveur
  refuse toujours un titre vide (`titre requis`).
- Le dialogue d'échec à la fermeture propose **« Revenir à WorkLogs »** (par défaut) **et
  « Fermer sans enregistrer »**, comme celui de l'enregistrement qui ne répond pas. Un
  brouillon en échec peut appartenir à un éditeur déjà quitté (entrée supprimée, projet
  supprimé…) : rien ne doit pouvoir retenir la fenêtre.

## 33. Vues rapides des tâches : un filtre, pas un mode — 2026-10-08

**La demande.** « Je veux pouvoir visualiser et accéder rapidement aux tâches marquées comme
en cours / en retard, etc. » Constaté avant de coder : la colonne empilait À faire, En cours,
Terminé ; les tâches en cours étaient **sous** toute la liste À faire, les retards dispersés
dans deux colonnes (seule la date rouge les signalait), et le compteur « en retard » de
l'en-tête, invisible sous 1 560 px, ne menait nulle part.

**Les choix.**
- **Une rangée de pastilles** sous « Nouvelle tâche… », du même langage que le filtre projet :
  En retard, Aujourd'hui, En cours, Épinglées, ▲ Haute (la face de la pastille des cartes : la
  colonne de ~300 px n'a pas la place de « Priorité haute »), chacune avec son compteur (le
  retard en rouge). « Etc. » a été lu comme ce qu'une tâche peut **porter** : statut, échéance,
  épingle, priorité. Une tâche terminée n'entre dans aucune vue.
- Un clic **filtre** les colonnes : on garde le statut de chaque tâche visible et l'ordre du
  glisser-déposer (§2 : pas de tri automatique). Les colonnes vides de la vue disparaissent.
  Recliquer ou « Toutes » lève le filtre.
- **Une pastille à zéro ne s'affiche pas** (§24 : seul l'écart se signale), sauf la vue active,
  pour qu'on puisse toujours en sortir ; rien à surveiller → pas de rangée du tout.
- **Pas un mode** (§1) : rien n'est caché ailleurs, la vue n'est pas retenue au redémarrage, et
  ajouter une tâche la lève — sinon la tâche neuve, qui n'entre dans aucune vue, disparaîtrait.
- Glisser-déposer dans une vue : la position est calculée dans la **colonne entière**, pas
  parmi les seules cartes visibles (sinon une carte déposée passait devant des tâches cachées).
- **En-tête** : « N en cours » (nouveau) et « N en retard » deviennent des liens vers la vue,
  et ouvrent le panneau Tâches s'il est replié. Ces compteurs portent sur toute la base : si le
  projet filtré ou la recherche en cachent une partie, ils sont levés — le clic montre ce que
  le chiffre annonce, et garde le projet quand il contient déjà tout.

**Écartés.** Une liste à plat « à surveiller » triée par échéance (un second rendu des mêmes
cartes, et un tri que §2 refuse) ; un onglet ou un panneau dédié (§1) ; « Cette semaine » (pas
demandé, à ajouter dans `TASK_VIEWS` si l'usage le réclame) ; retenir la vue au redémarrage
(une colonne qui s'ouvre filtrée sans qu'on s'en souvienne ferait croire à des tâches perdues).

**Rouvrir si** les pastilles ne suffisent plus à l'usage — par exemple un besoin de voir les
retards de tous les projets sans lever le filtre projet.
## 34. Un PDF du dossier partagé se lit sur place — 2026-10-07

**La demande.** « Visualiser les PDF directement dans WorkLogs dans l'app desktop, comme dans
la PWA sur mobile. »

**Constaté avant de coder.** Les PDF **joints aux entrées** s'affichaient déjà en desktop
(§15 : `<iframe>` sur `/api/files/:stored/preview`, visionneuse PDF intégrée d'Electron),
vérifié dans le paquet 0.47.0 installé comme en dev. Le trou était le **dossier partagé**
(§25), qui n'existe qu'en desktop : un PDF y affichait « WorkLogs ne modifie pas les fichiers
.pdf » et ne proposait que « Ouvrir avec… » ou « Télécharger cette version ».

**Les choix.**
- **Lecture seule, dans la colonne centrale**, à la place de l'explication : la visionneuse
  de Chromium (pages, zoom, recherche, impression, téléchargement). « Ouvrir avec… » reste
  pour annoter ou signer dans une vraie application ; « Enregistrer sur le partage » reste
  grisé (rien à envoyer).
- **Une route serveur, pas une URL `blob:`.** Le front a déjà les octets, mais la CSP du
  desktop n'autorise pas `blob:` (déjà le cas pour l'aperçu `.docx`, §15). Plutôt que de
  l'assouplir, `GET /api/shared/preview?hash=&name=` sert la version du magasin local en
  `inline`, sous son nom (le téléchargement depuis la visionneuse le garde) : même origine
  que l'app, rien à changer à la CSP, et ça marche hors ligne comme le reste du partage.
- **PDF seulement, vérifié sur les octets** (`%PDF-` dans le premier Ko) côté serveur
  (`415 SHARED_NOT_PDF`) et côté front (`looksLikePdf`) : un fichier d'équipe servi depuis
  notre origine pourrait être du HTML actif, quelle que soit son extension. `nosniff` en plus.
  Un faux `.pdf` garde l'explication et le téléchargement.
- `attachmentHeader` et `inlineHeader` passent de `app.js` à `api/src/disposition.js`, sans
  changement, pour servir aux deux routes.
- Dans l'arbre, un PDF n'est plus grisé (`is-foreign` = « WorkLogs ne l'ouvre pas lui-même »).

**Écartés.** Images et texte du partage en lecture : personne ne les a demandés, et le texte
s'ouvre déjà dans son éditeur. Annoter un PDF : demanderait une bibliothèque (accord requis).

**À l'intégration (v0.52.0).** Entre-temps, la PWA a reçu le partage par le relais (§29) :
une `<iframe>` n'envoie pas l'en-tête `Authorization` qu'il exige. Sur la PWA,
`sharedPreviewUrl` répond `null` et un PDF garde l'explication et son téléchargement.

## 35. Projets sur une rangée, gestion par-dessus ; mobile en une seule page — 2026-10-08

**Le besoin.** « Améliore grandement le design et l'UI/UX mobile afin que tous les panneaux
s'affichent mieux […] ; la liste des projets et **Gérer les projets** (aussi sur desktop)
prennent trop de place et rendent le layout moche quand il y a trop de projets. » Mesuré avec
seize projets : bandeau sur **deux rangées** même sur desktop (`flex-wrap` place d'après la
largeur max-content des pastilles, « Gérer » passait donc toujours à la ligne) ; gestion
dépliée = une ligne pleine largeur par projet, qui poussait journal, écriture et tâches hors
de l'écran ; sur mobile, ~110 px de bandeau puis une liste sans fin.

**Décisions.**
- **Une rangée, toujours** (`ProjectBar`). Les pastilles défilent : molette verticale
  convertie en défilement horizontal, fondu seulement du côté où il en reste, filtre actif
  ramené en vue. « Gérer » reste au bout, séparé d'un filet. La pastille active prend la
  **couleur de son projet** (`--project`) : on sait d'un coup d'œil dans quel projet on est.
- **La gestion s'ouvre par-dessus**, dans un `<dialog>` modal : fenêtre posée sous son bouton
  sur desktop (≤ 400 × 580 px), **feuille qui monte du bas** sur mobile. Création en tête,
  **Retrouver un projet** dès huit projets, seule la liste défile ; rien ne bouge derrière.
  Échap annule d'abord un renommage commencé, puis ferme ; fermer (bouton, Échap, clic sur le
  voile) valide le renommage en cours ; le focus revient au bouton. Clavier physique : le champ
  de création prend le focus ; écran tactile : non, pour ne pas faire surgir un clavier qui
  masque la liste. Ce n'est ni un onglet ni un mode (§1) : même nature que Paramètres.
- **Mobile (≤ 600 px) : une seule page qui défile**, en-tête compris. La marque et la
  recherche s'effacent en descendant (~120 px rendus au contenu), le bandeau projets reste
  collé en haut, la barre des panneaux en bas (§24). De 601 à 900 px rien ne change :
  l'en-tête y porte encore les interrupteurs.
- **Rien ne passe devant le contenu qui défile** (demande du même jour : « l'input Nouvelle
  tâche et le header En cours passent devant la liste des tâches », desktop comme mobile).
  La saisie et les intitulés de colonne étaient collants : les cartes défilaient dessous,
  dépassaient au-dessus de la saisie (le collant s'arrêtait à la marge du panneau) et sous
  l'intitulé sans fond. Colonnes côte à côte, la saisie devient **l'en-tête fixe du panneau
  Tâches** et seule la liste défile (`.board-lists`), coupée net sous un filet ; cartes
  empilées, tout suit la page. Audit des autres éléments collants : les **jours du journal**
  masquaient l'entrée qui passait dessous → plus collants ; sur mobile, les **barres d'outils
  des documents Google et Word du partage** restaient à moitié sous le bandeau projets → dans
  le flux (≤ 600 px). Gardés, parce qu'opaques, à fleur de leur zone et sans rien qui dépasse :
  le bandeau projets mobile (barre d'application), les barres d'outils Google et Word sur
  desktop (collées au ras de la colonne, comme dans Docs ou Word), les en-têtes du tableur
  (ligne et colonne figées dans leur propre zone) et la liste des onglets Google (colonne à
  part).
- **Cartes resserrées** : un seul cadre par panneau (plus de marge d'éditeur dans la carte,
  plus de second cadre autour des colonnes de tâches) ; « Nouvelle entrée » et « Nouveau
  document » côte à côte ; réglages de l'entrée en grille (date + projet, Écrire/Lire pleine
  largeur, Imprimer/Archiver/Supprimer à parts égales) ; actions tâche/IA sur une rangée qui
  défile ; barre de mise en forme sur une rangée qui défile au doigt.
  Paramètres et Documents Google deviennent des feuilles du bas, comme les projets.
- **Ouvrir amène à l'écriture** quand les cartes sont empilées (≤ 900 px) : ouvrir une
  entrée, une procédure, un document de tâche, un fichier partagé, ou en créer une, fait
  défiler jusqu'à la carte Écriture (`revealEditor`), titre juste sous le bandeau.

Aucune dépendance ajoutée, aucun mot de l'interface renommé : « Gérer les projets », « Nom de
… », « Supprimer … », « Nom du nouveau projet » restent les noms accessibles (le bouton
n'affiche que « Gérer » sur mobile).

**Ce que ça coûte.** Sur mobile, la recherche n'est plus visible une fois descendu : il faut
remonter. Le bouton n'est plus un `<details>` : le panneau fermé n'existe plus dans la page
(les tests vérifient son absence, plus son masquage). `:has()` décide si les actions de
l'entrée défilent sur une rangée (seulement sans formulaire ni message ouvert).

**Rouvrir** si la recherche doit rester à portée sur mobile : la réponse serait une loupe dans
le bandeau collé, pas un tiroir ni un hamburger (§16).

## 36. Procédure locale vers le partage : copiée au format choisi, dans le dossier choisi — 2026-10-08

**La demande.** « Déplacer les procédures créées en dehors des dossiers, en docx (ou au choix),
sur le TSE, dans le dossier partagé sélectionné. » Les procédures de l'équipe vivent dans
`00. PROCEDURE`, mais on les écrit d'abord hors du partage (colonne Procédures) ; il fallait
les y mettre sans repasser par un copier-coller ni écraser un fichier du même nom.

**Les choix.**
- **« ＋ Depuis une procédure… » dans la section Dossier partagé**, à côté de « ＋ Nouveau
  fichier… » : procédure (liste des locales non archivées), **format au choix** — Word
  (`.docx`, défaut demandé), Markdown (`.md`), Texte (`.txt`) — nom (prérempli du titre) et
  **« Dans » le dossier choisi** (la racine ou un dossier déplié, comme pour un fichier neuf).
  Pas d'onglet ni de mode (§1) : le même formulaire que les fichiers neufs.
- **Aucune route** : le front fabrique les octets (`procedureFileBytes`, `new-files.ts`, même
  modèle que les fichiers neufs — Word sans réparation, Markdown sans BOM, texte avec BOM
  pour les accents du TSE) puis appelle `POST /api/shared/create`, **création exclusive** :
  un nom pris est refusé, rien n'est écrasé. Le fichier s'ouvre au centre comme un neuf.
- **Word à partir du Markdown** (riche via `richToMarkdown`) : titre en `Titre1` (un `# …`
  en tête ne fait pas doublon), `##`/`###` en `Titre2`/`Titre3`, puces en `•`, cases en
  `☐`/`☑`, numéros écrits (`1.` — le modèle n'a pas de `numbering.xml`, §30), clôtures de
  code et séparateurs de tableau sautés, balisage en ligne retiré (`**`, liens…). Relu par
  `readDocxDocument` en test, comme les fichiers neufs.
- **Copie par défaut ; « Supprimer la procédure locale après l'envoi » en fait un
  déplacement.** La case est explicite et décochée : rien ne disparaît sans geste. Les
  **pièces jointes restent** sur l'origine (le partage a son propre historique, §25) —
  le formulaire le dit.
- PWA : même chemin par le relais (`createShared` relayé), comme les fichiers neufs.

**Ce que ça coûte.** Le Word perd la mise en forme riche (gras, tableaux, images : texte
seul) — c'est un envoi, pas une synchronisation. Au-delà du texte (tableaux, images),
repasser par « Ouvrir avec… » puis le partage.

**Rouvrir si** les procédures doivent garder leurs pièces jointes à l'envoi (les téléverser
dans le dossier à côté, avec le même nom) ou si le Word doit porter de vraies listes
numérotées (ajouter un `numbering.xml` au modèle, §30).

## 37. Le relais de la VM suit les releases tout seul — 2026-10-08

**La demande.** « Fais en sorte que le relais sur ma VM .203 soit mis à jour automatiquement à
chaque update. » Constat du jour même : la PWA 0.51.0 répondait « Introuvable. » en créant un
dossier, parce que le relais datait d'avant la 0.49.0 — sa mise à jour était une copie à la
main, oubliée.

**Les choix.**
- **La VM tire, GitHub ne pousse pas** : un minuteur systemd (`worklogs-relais-maj.timer`, 5 min)
  interroge l'API GitHub ; le dépôt est public, aucune clé à garder. Écarté : un job de
  `release.yml` qui se connecterait à la VM — il faudrait confier à GitHub une clé Tailscale et
  un accès root à une machine du réseau du bureau.
- **Les releases publiées, pas `master`** : c'est ce que la CI a validé, ça porte le numéro de
  la PWA et du desktop, et ça se compare. Le relais peut avoir quelques minutes de retard sur une
  PWA déployée depuis `master` avant la release ; plus des semaines.
- **Préparer à côté, basculer ensuite** : archive du tag, `npm ci --ignore-scripts` et chargement
  du module avant d'arrêter le relais ; la coupure dure une seconde.
- **La preuve est `/health`** : le relais dit sa version (`api/VERSION`, écrit par la mise à jour,
  `relayVersion()`), et la bascule ne compte que si c'est **la nouvelle** qui répond — un relais
  lancé à la main qui garderait le port ne passe pas pour elle.
- **Retour arrière automatique, code et base** (une version neuve peut migrer la base en
  démarrant), puis la version est **écartée** jusqu'à la suivante : sinon le relais serait coupé
  30 s toutes les 5 minutes. Un échec avant la bascule (réseau, npm) ne l'écarte pas : retenté.
- **Rien n'est tenté si le relais ne répond pas déjà** (partage démonté, VM qui redémarre) : la
  nouvelle version serait accusée à tort.
- Le script se remplace par celui de la release après chaque succès ; les unités systemd non,
  elles portent des chemins propres à la VM.

**Écartés.** Suivre `master` (pas encore validé au moment du push, pas de numéro) ; un paquet
`.deb` du relais (un artefact de plus à construire et publier pour une seule machine) ; garder
plusieurs versions d'avance sur le disque (la VM est pleine à 94 %, les releases restent sur
GitHub).

**Rouvrir si** la PWA se met à dépendre de routes qui arrivent sur `master` longtemps avant la
release : suivre alors les commits de `master` à CI verte.

## 38. Images dans les documents Word du partage, et images du partage — 2026-10-21

**La demande.** « Voir les images et pouvoir en insérer dans un docx directement depuis
WorkLogs, même chargé depuis un dossier partagé. » L'aperçu des pièces jointes (§15) montrait
déjà les images d'un `.docx` ; l'éditeur du partage (§26) n'en affichait que le nom, « Image —
conservé », et les fichiers image du partage étaient grisés (§34, écartés faute de demande).

**Les choix.**
- **Les images d'origine restent des objets conservés** : affichées dans leur cadre, recopiées
  octet pour octet, jamais redimensionnées. Leurs octets passent par une option de l'extension
  (`docxImages` → `DocxAtom.configure({ images })`), **pas par les attributs** : le brouillon et
  les empreintes ne portent que le document, pas des mégaoctets d'images qu'on ne modifie pas.
- **Une image insérée est un nœud `docxImage`**, son propre paragraphe, écrite comme Word
  l'écrit (`wp:inline`) : un média `word/media/worklogsN.ext`, une relation `rIdWorkLogsN`, le
  type de contenu de l'extension s'il manque, `docPr` au-dessus du plus grand du document.
  Rien d'autre ne change hors du corps. Taille : celle de l'image à 96 ppp, réduite à la
  largeur utile de la page (`pgSz` − marges de la dernière section). Espaces de noms déclarés
  sur l'élément, comme python-docx : un document qui ne les déclare pas à la racine reste
  valide. Vérifié en ouvrant le fichier envoyé dans LibreOffice (`pdfimages`) : image à sa
  place, à la bonne taille, celles d'origine intactes.
- **PNG, JPEG, GIF seulement**, reconnus à leurs octets : ce que Word et LibreOffice lisent
  sans conversion. WebP, SVG, HEIC sont refusés avec un message plutôt que convertis.
- **Coller une capture d'écran insère l'image ; coller du texte reste du texte.** Word et Excel
  joignent une image de la sélection au texte copié : dès qu'il y a du texte, c'est lui qui gagne.
- **Le brouillon porte les images insérées** (en `data:`), sinon elles seraient perdues à la
  fermeture. Il est plafonné (`MAX_DRAFT`, 4,5 Mo) et un brouillon refusé bloque l'envoi : au-delà
  d'environ 3 Mo d'images en attente, l'insertion est refusée avec un message (« enregistre sur
  le partage avant d'en ajouter une autre »). Une fois envoyée, une image devient un objet
  conservé et ne pèse plus dans le brouillon.
- **Les fichiers image du partage se voient sur place**, en `data:` depuis les octets déjà
  chargés, reconnus à leurs octets (`imageMime`) : pas de route serveur à ajouter, et ça marche
  aussi sur la PWA, où l'`<iframe>` du PDF ne passe pas (§34). Un faux `.png` (du HTML) garde
  l'explication et le téléchargement.

**Écartés.** Réduire une photo trop lourde dans le navigateur (canvas) : une perte de qualité
silencieuse, et personne ne l'a demandée ; images flottantes ou habillées, redimensionnement
à la souris, légendes : « Ouvrir avec… ». Une route serveur pour l'aperçu des images (ébauchée
sur la copie principale) : inutile une fois les octets dans le navigateur.

**Rouvrir si** des photos de téléphone (4 Mo et plus) doivent entrer telles quelles : relever
alors `MAX_DRAFT` et la limite JSON (`app.js`, `relay.js`), ou réduire l'image à l'insertion.

## 39. L'accès au relais revient du compte Google, chiffré — 2026-10-21

**La demande.** « Sur la PWA de mon téléphone j'ai perdu l'accès au serveur distant et j'ai la
flemme de remettre l'URL et de regénérer un code » — puis, précisé : **pas en clair dans Google
Drive**, mais enregistré et rechargé automatiquement. Revient en partie sur §29 (« le code reste
sur le téléphone, jamais synchronisé »).

**Le choix.** Un hash ne convient pas : le téléphone doit présenter le code lui-même
(`Authorization: Bearer`). La PWA le **chiffre** (AES-GCM, IV aléatoire, donnée associée
`worklogs-relais-v1`) avec l'adresse et la date d'enregistrement, et garde le chiffré dans
`WorkLogs/WorkLogs relais.json` (étiquette `worklogs_type=relay`, autorisation `drive.file`
déjà accordée : rien de plus à accepter).
- **La clé n'est stockée nulle part.** Le Worker la recalcule (`POST /relay-key`) :
  HMAC-SHA256 du secret qu'il détient déjà (`GOOGLE_CLIENT_SECRET`) et de l'identifiant Google
  du compte (`sub`). Il ne la rend qu'à un jeton d'accès que Google confirme (`tokeninfo`)
  émis pour le client intégré (`GOOGLE_CLIENT_ID`, variable publique de `wrangler.toml`) et
  encore valide, et seulement à l'origine de la PWA. Un autre compte obtient une autre clé.
- **À part de `WorkLogs backup.json`** : le desktop réécrit la sauvegarde sans connaître le
  relais (le champ y serait perdu), et l'export téléchargé ne doit pas emporter le code.
- **Quand.** « Enregistrer » envoie la copie, « Oublier ce relais » la met à la corbeille (un
  oubli fait hors connexion est retenu, et la copie plus ancienne ne revient pas). Une fois par
  ouverture de la PWA et à chaque connexion Google, la synchro compare : rien ici → la copie
  revient et la colonne Procédures se relit ; sinon le plus récent (`saved_at`) gagne. Un
  échec (Worker, Drive) ne gêne jamais la synchro des données ; nouvel essai au passage suivant.
- Client Google personnel (sans le Worker) : rien ne part, l'accès reste sur le téléphone.

**Limites assumées.** Qui tient le compte Google tient l'accès : c'est le but (« reload
auto »), et il faut en plus être dans le réseau Tailscale pour joindre le relais. Le fichier
Drive seul (partagé par erreur, export Google, autre application) ne livre rien. Changer le
`GOOGLE_CLIENT_SECRET` du Worker change la clé : l'ancienne copie devient illisible, elle part
à la corbeille et la suivante la remplace (ressaisie une fois si le téléphone l'avait perdue
entre-temps).

**Rouvrir si** le Worker cesse d'être le passage obligé de la connexion Google, ou si le relais
sort du seul réseau Tailscale.

## 40. Changer de projet referme ce qui appartient à l'ancien — 2026-10-21

**La demande.** « Quand on change de projet, les documents/fichiers ouverts ou édités dans le
projet précédent restent affichés alors que les procédures, entrées et tâches listées sont bien
celles du projet sélectionné ; cela crée des incohérences. »

**Constaté avant de coder.** Le journal, les tâches et les procédures relisent l'état filtré,
mais deux choses vivaient en dehors : `sharedPath` (le fichier du dossier partagé au centre)
n'était jamais refermé, et l'entrée ouverte restait affichée jusqu'au retour de la nouvelle
entrée. La fenêtre « Documents Google » ouvrait en plus un document sans suivre son projet,
contrairement à une carte de tâche.

**Les choix.**
- **Le centre suit le filtre projet.** Changer de projet referme le fichier du partage et
  l'entrée ouverte ; le rechargement rouvre ensuite la première entrée du projet choisi. Une
  lecture d'état déjà en vol est invalidée pour ne pas réafficher l'ancien filtre.
- **« Tout » ne ferme rien.** L'entrée et le fichier y restent dans les listes : les garder ne
  crée aucune contradiction. Recliquer sur la pastille active garde donc le travail en cours.
- **Le brouillon d'abord.** Un fichier du partage modifié mais pas envoyé passe par la garde
  existante (Envoyer · Garder le brouillon ici · Annuler), après un envoi des sauvegardes en
  attente. « Annuler » annule aussi le changement de projet, sinon le fichier serait resté
  ouvert sous les listes d'un autre projet.
- **Documents Google : le document mène au projet.** Ouvrir un document depuis la fenêtre
  « Documents Google » applique le même réflexe qu'une carte de tâche : le filtre passe au
  projet du document. Le journal ne montre donc pas un document qui n'appartient pas à la
  liste affichée.
- **Jamais une archive (2026-10-22).** Ce qui se rouvre tout seul est la plus récente entrée
  **non archivée** du journal, sinon une procédure non archivée, sinon rien : une archive
  ouverte sans l'avoir demandée passait pour un document en cours. Ouverte exprès depuis les
  Archives, elle porte le bandeau « Document archivé » (aussi quand une tâche terminée
  l'archive sous les yeux).

**Écartés.** Vider le centre sans rien rouvrir (un écran vide après chaque pastille, alors que
l'ouverture d'une entrée est le geste courant) ; fermer aussi le fichier en revenant à « Tout »
(il y est visible) ; demander le projet du fichier au serveur à chaque clic de pastille (un
aller-retour pour une règle qui ne dépend pas du contenu du fichier).

**Rouvrir si** plusieurs fichiers d'un même projet doivent rester ouverts côte à côte (il
faudrait alors une navigation par onglets, refusée en §1) ou si l'on veut conserver le fichier du
partage en passant d'un projet à l'autre (il faudrait alors vérifier sa présence dans le dossier
relié, adresse du partage à l'appui).

## 41. Assistance IA : contexte du projet, affinement et actions sourcées — 2026-10-21

**Le besoin.** Rendre les fonctions IA plus pertinentes et plus faciles à ajuster dans
l'écran existant. Les suggestions depuis une tâche ne connaissaient que les titres des
documents liés ; celles d'une note lisaient son début. Une régénération ne permettait
pas d'indiquer ce qui devait changer.

**Les choix.**
- `ai-context.ts` prépare le même contexte pour notes, tâches et fichiers du partage :
  fiche facultative par projet, tâches voisines et vocabulaire du même projet, puis
  documents liés ou pertinents par mots du titre et de l'extrait. Trois sources de
  2 000 caractères maximum ; les passages sont choisis dans le document, pas seulement
  au début. Projet et origine Google sont vérifiés avant et après lecture. Une lecture
  impossible interrompt la demande au lieu de faire croire à un contexte complet.
- Les fiches de projet sont dans `localStorage`, comme le profil métier : aucune
  migration ni nouvelle donnée synchronisée. Le libellé dit « sur cet appareil ».
  Pour le partage, seul un projet explicitement sélectionné apporte du contexte local.
- Les documents transmis sont visibles après le premier geste et excluables pour les
  suivants. Une sélection changée invalide les propositions et les réponses encore en
  vol qui s'appuyaient dessus. Les documents Google et le contenu des pièces jointes
  gardent l'exclusion des décisions §17/§23. Les cinq documents principaux d'une
  procédure tirée d'une tâche restent bornés à 12 000 caractères au total (§31) ; liés
  exprès, ils en restent les sources même s'ils appartiennent à un autre projet.
- Un affinement transmet la source originale, la proposition précédente et une
  instruction courte. Le brouillon précédent ne devient jamais une source de faits ;
  les règles de fidélité et les marqueurs Word restent applicables. Même composant
  `AiRefinement` dans les relectures, procédures et créateurs de sous-tâches.
- L'extraction ne produit que des propositions : JSON validé, huit actions au plus,
  extrait exact obligatoire, doublons et cases terminées écartés. Une date n'est gardée
  que si elle est calendairement valide et écrite littéralement dans le passage cité.
  L'utilisateur sélectionne et peut corriger avant création par la route transactionnelle
  existante `POST /api/entries/:id/task`. Les liens existants sont relus avant une
  nouvelle tentative ; les créations réussies ne sont pas rejouées.
  (2026-10-29) Le tableau se **lit** avec tolérance — prose ou bloc de code autour,
  enveloppe `{"actions": […]}` — mais chaque action reste validée comme ci-dessus. Même
  lecture pour « ✨ Trouver la doc ». Extraction et suggestion de tâches passent à
  `DOCUMENT_MAX_TOKENS` (8 000) : priorité, explication et extrait par tâche, plus la
  réflexion du modèle, pouvaient dépasser 3 072 jetons. Motif : refus « les actions
  doivent être un tableau JSON » sur une vraie suggestion, réponse non conservée.
- Les frappes pendant une suggestion sont conservées. Un changement de projet, de
  contenu source ou de sélection est vérifié avant application/création ; une réponse
  tardive ne rouvre pas le document quitté.

**Validation.** Tests purs des prompts, de la sélection de contexte et des réponses ;
gestes sur la vraie API de test ; parcours Chromium tâche, mobile et partage. Le service
IA est simulé dans ces tests : ils prouvent les garde-fous et le parcours, pas la qualité
d'un modèle réel. La recette §14 de `04-RECETTES.md` donne les cas à juger avec une clé réelle.
Aucune dépendance, route, migration, onglet ou mode ajouté.

**Rouvrir si** la recherche par mots manque régulièrement une procédure utile (mesurer
sur les cas réels avant d'ajouter un index sémantique), si les fiches doivent suivre Drive,
ou si l'on veut consulter des pièces jointes ou des documents Google avec l'IA.

## 42. L’IA complète le document en cours — 2026-10-21

**La demande.** « En plus de suggérer des sous-tâches je voudrais une feat qui permet de
terminer/compléter l'entrée, la tâche ou la procédure en cours d'édit (par rapport à ce qui a
déjà été saisi dedans) afin que l'IA assiste vraiment la personne qui rédige la doc, voire même
qu'il n'ait rien à rédiger à part le titre et certains points importants. »

**Les choix.**
- **Un bouton, « ✨ Compléter »**, dans la rangée IA de l'éditeur. Sur une note locale du
  journal, Markdown ou riche, il rédige la note complète (`completeNote`, `ai-suggest.ts`) ;
  sur une procédure, du journal ou du partage, c'est « ✨ Suggérer une procédure » renommé,
  consigne inchangée (§23, §30). Ni onglet, ni mode, ni route, ni dépendance, ni migration.
- **Ce qui part** : titre, contenu (une note riche passe par le pont Markdown, §23), contexte
  du projet (§41), titres des tâches liées, noms des pièces jointes ; le texte déjà écrit en
  dernier. Plafond de 12 000 caractères, comme la mise en page.
- **La consigne** développe chaque point en phrases courtes ; intertitres et cases « - [ ] »
  seulement si la note en a besoin ou les mentionne. Tout ce qui est écrit est gardé —
  commandes et valeurs à l'identique, cases cochées ou non — et le sens ne bouge pas : une
  action prévue reste à faire, rien ne devient « fait ». Fait, résultat, valeur, date ou nom
  absents du texte et du contexte : « à préciser ». Avec un titre seul : le plan de la note.
- **Relue avant d'être écrite**, comme toute proposition (§17) : « Note proposée », puis
  « Appliquer la note », « Rafraîchir » ou « Ignorer », et l'affinement de §41. Refusée si la
  note a changé pendant l'appel.
- **Une tâche n'a pas de texte**, donc pas de bouton sur sa carte : « ＋ Entrée liée »,
  « Créer et ouvrir », les points importants, puis « ✨ Compléter » ; la demande connaît la
  tâche liée.
- **Pas pour un document Google** (§17, §23) : pas de bouton, rien ne transite.

**Écartés.** Un champ de texte sur la carte de tâche (l'entrée liée porte déjà ce texte) ;
écrire sans relecture, ou compléter pendant la frappe (§17 : jamais d'envoi sans geste) ;
envoyer un document Google ; un bouton de plus sur les procédures (le geste est le même :
compléter à partir du titre et de l'existant).

**Ce que ça coûte.** Une note riche repasse par le Markdown : surlignage, couleurs et
alignements sont remis à plat, et une case proposée y devient une puce (l'éditeur riche n'a
pas de cases).

**Validation.** Tests purs de la consigne et des refus sans appel réseau ; gestes sur la vraie
API de test (note Markdown, note riche, « Plus court », note Google). Le service IA y est
simulé : la qualité d'un modèle réel se juge avec la recette §14 de `04-RECETTES.md`.

**Rouvrir si** la note complétée invente en usage réel (resserrer la consigne, ou ne compléter
que ce qui suit le dernier point) ; si la perte de mise en forme d'une note riche gêne (§23 :
faire travailler l'IA en HTML) ; si une tâche doit porter son propre texte.

## 43. Retrouver la doc d’une tâche, dans WorkLogs et sur le partage — 2026-10-21

**La demande.** « Je veux que par rapport à une tâche existante on puisse facilement à l'aide
d'un bouton sur la tâche et grâce à l'assistance de l'IA retrouver la doc ou procédure qui peut
permettre de la compléter si elle existe dans les procédures ou locales mais aussi sur le
serveur distant. »

**Les choix.**
- **Un bouton au pied de la carte**, « ✨ Trouver la doc », à côté de « ✨ Procédure » ; la liste
  « Documents trouvés » s'ouvre dans la carte, comme le lieur de documents. Ni onglet, ni mode,
  ni route, ni migration, ni dépendance.
- **L'IA choisit les mots, le code cherche.** Elle reçoit le titre et le statut de la tâche, son
  projet (nom, contexte IA du projet, vocabulaire des titres) et les titres des documents liés,
  et rend au plus six termes courts en tableau JSON (`suggestSearchTerms`). **Aucun contenu**
  ne part : des titres suffisent pour deviner les mots, et chercher dans tous les projets ne
  doit pas envoyer leurs textes à un tiers. Réponse illisible : erreur, rien n'est cherché.
- **Chaque mot est cherché tel quel, un à la fois** (`web/src/doc-finder.ts`) : dans WorkLogs
  par la recherche existante (`/api/state?q=`, titres et textes, tous projets, archives
  comprises ; le stockage de la PWA fait de même) et sur le partage par sa recherche de noms
  (`/api/shared/search`, bornée en temps §25 ; sur la PWA, par le relais §29). Seuls les
  fichiers comptent, pas les dossiers.
- **Un classement prévisible** : un mot pèse d'autant plus qu'il est haut dans la liste de l'IA,
  le double s'il est dans le titre — un nom de fichier compte comme un titre, c'est tout ce que
  lit la recherche du partage. À égalité : procédure (elle explique), note (elle raconte),
  fichier du partage (trouvé par son seul nom), puis le plus récent. Huit au plus ; les
  documents déjà liés ne reviennent pas.
- **Le partage ne bloque jamais WorkLogs.** Non réglé, relais injoignable ou en panne au premier
  mot : WorkLogs seul, et la liste le dit. Tombé en route : ce qui est trouvé reste (« recherche
  partielle ») et les mots suivants ne l'attendent plus. Hors ligne : les dernières listes vues.
- **Ouvrir suit le projet** (§40) : une entrée d'un autre projet fait basculer le filtre, même
  absente de l'état filtré (`openDocument` reçoit le projet que la recherche connaît) ; un
  fichier du partage s'ouvre au centre comme depuis l'arbre. **Lier** prend la route de
  « ＋ Documents » : sur une tâche terminée, le document passe donc aux archives (§31).

**Écartés.** Envoyer le contenu des documents candidats à l'IA pour qu'elle les classe (des
textes d'autres projets partiraient, pour un gain non mesuré) ; lire le contenu des fichiers du
partage (chaque fichier lu par le réseau SMB : trop lent, d'où une recherche bornée aux noms) ;
une recherche automatique à l'ouverture de la carte (un appel IA sans clic, contraire au §17) ;
une route de recherche « l'un des mots » sur le partage (six recherches bornées suffisent, sans
toucher au serveur ni au relais).

**Validation.** Tests purs de la consigne et du nettoyage des mots (sans clé, rien ne part), du
classement et des pannes du partage ; trois parcours sur la vraie API de test (partage relié,
partage absent, réponse illisible). Le service IA y est simulé : la pertinence des mots d'un
vrai modèle reste à juger en usage.

**Rouvrir si** les résultats sont trop bruyants (un passage IA de classement sur les seuls
**titres** trouvés), si six recherches sont trop lentes sur le vrai TSE (chercher d'abord dans
le dossier relié au projet), ou si les accents font manquer des documents : le `LIKE` de SQLite
ne plie ni les accents ni la casse hors ASCII (« procedure » ne trouve pas « procédure »).

## 44. Les actions IA derrière un seul « ✨ IA » — 2026-10-22

**Le besoin.** Chaque action IA était une pastille de plus : jusqu'à cinq dans la rangée d'une
note, à côté de « ＋ Créer une tâche liée » et « ＋ Lier une tâche existante », deux au pied de
**chaque** carte de tâche, deux dans un fichier du partage. Demande : les ranger dans un menu.

**Décision.**
- **Un bouton « ✨ IA », un menu par endroit** (`AiMenu.tsx`) : note ou procédure, fichier du
  partage, carte de tâche. Les actions dépendent de ce qui est ouvert : un menu global dans
  l'en-tête aurait dû deviner sa cible. Sans action possible (document Google), pas de bouton.
- **Au bout de sa rangée, ouvert vers la gauche** : le menu reste dans la colonne, même au pied
  d'une carte du panneau Tâches (dont le débord est coupé). Sur mobile, il se fait voir en
  entier au-dessus de la barre du bas (`scroll-margin-bottom`).
- **Le clavier du menu du compte** (flèches, Échap, Tab) plutôt qu'un `<details>` ou l'API
  `popover` : le geste existe déjà, il se teste dans jsdom, et le menu ne doit pas se coller
  ailleurs que sous son bouton (le positionnement CSS par ancre n'est pas garanti sur tous
  les navigateurs de la PWA).
- **L'attente s'affiche sur le bouton** (« Rédaction… », « Mise en page… », « Recherche… ») :
  le menu se referme au choix et rend le focus au bouton. Le résultat (proposition à relire,
  « Affiner », « Retirer ») reste où il était, sous la rangée.
- **Les actions perdent leur ✨**, porté une fois par le bouton ; leur infobulle dit toujours
  ce qui part au service IA.

**Écartés.** Mettre dans le menu le **✨ Suggérer** du formulaire « ＋ Entrée liée » : seule
action de ce formulaire, il remplit la zone juste au-dessus — un menu d'une ligne aurait
ajouté un clic sans rien ranger. Une ligne d'explication sous chaque action (l'infobulle le
fait, et le menu doublait de hauteur).

**Validation.** Un geste dans `App.test.tsx` (ordre des actions, flèches, Échap, clic
extérieur, attente sur le bouton, focus rendu) ; les tests et parcours IA existants passent
par le menu (`aiAction` dans `App.test.tsx`, trois specs Playwright).

**Rouvrir si** une action IA devient quotidienne au point de mériter sa pastille, ou si le menu
doit s'ouvrir vers le haut (bas d'écran sans place) : alors le positionner au calcul.

## 45. Une procédure ouverte déplie la colonne Procédures — 2026-10-22

**La demande.** « Si le document affiché dans le module Écriture est une procédure, il faut que
ça déplie l'onglet Procédures pour voir directement d'où provient le document. »

**Décision.** Un seul point, `App.tsx` : dès qu'une procédure non archivée s'affiche au centre,
la colonne Procédures s'affiche (`showProcedures`), où `ProcedureList` la surligne déjà. Le
réflexe vaut quel que soit le chemin (tâche, « Trouver la doc », recherche, changement de
projet, procédure créée par l'IA), parce qu'il regarde ce qui est affiché et non le geste qui
l'a ouvert.
- **Une fois par procédure.** Masquer la colonne ensuite tient tant que la même procédure reste
  ouverte : l'outil ne reprend pas la main sur un choix qu'on vient de faire. Ouvrir une autre
  procédure (ou revenir à celle-ci après une note) redéplie.
- **Rien pour une archive** : elle n'est pas dans la colonne, la déplier ne montrerait rien ;
  le bandeau « Document archivé » dit déjà d'où elle vient (§40).

**Écarté.** Déplier aussi pour un fichier du dossier partagé (son arbre est dans la même
colonne) : la demande parle des procédures, et l'arbre ne déplie pas encore les dossiers
jusqu'au fichier ouvert. **Rouvrir si** c'est demandé : la même ligne, avec `sharedPath`.

---

## 46. Catégories imbriquées dans chaque projet — 2026-10-26

**Demande.** Ranger les tâches, objectifs et entrées dans des sous-catégories visibles,
filtrer leur contenu et regrouper les listes.

**Choix.** Une arborescence par projet, commune aux notes, tâches et procédures ; chaque
élément a au plus une catégorie. Elle complète le projet et les statuts existants sur le
même écran. Le bandeau montre les arbres, les couleurs et les compteurs ; les cartes
montrent le chemin. Le filtre inclut les descendants et se cumule à la recherche ;
« Sans catégorie » aide à ranger l'existant. Le regroupement est un choix d'affichage,
sans changer les dates, statuts ou positions de glisser-déposer.

**Intégrité.** Migration additive ; parent et contenu doivent rester dans le même projet,
cycles refusés. Reclasser une catégorie conserve ses enfants ; la supprimer remonte ses
enfants et son contenu dans son parent (ou à la racine sans catégorie), avec confirmation.
Changer le projet d'un élément libère le classement précédent ; les créations liées et
copies héritent de la source. Une suppression attend les sauvegardes de l'éditeur.

**Tous les appareils.** Même modèle dans SQLite et IndexedDB v2 (service worker aligné),
sauvegardes v2 rétrocompatibles, import mobile, fusion Drive par date de modification et
pierres tombales. Des reparentages concurrents peuvent former un cycle absent des deux
sources : la fusion le casse de façon déterministe avant validation/restauration.
Aucune dépendance, aucun onglet ajouté.

**Validation.** Tests API (CRUD, migration, validations et filtres), sauvegardes/fusion,
PWA et gestes intégrés ; parcours navigateur desktop/mobile. Bilan de la recette complète
dans `00-HANDOVER.md`.

---

## 47. Le carnet de bord : une page au centre, des outils sur les côtés — 2026-10-23

**La demande.** « Améliore grandement le design, l'UI, le layout et l'UX ainsi que le
responsive afin que tout reste beau, ergonomique et intuitif ; fais aussi une passe de refactor
et optimise les performances en gardant le code propre. » Constaté avant de coder (captures
à 1440, 1100, 800, 412 et 844 × 390 px, jeu de données réaliste dans `.design/`) : tout
portait un cadre de la même force — champs, pastilles, boutons, cartes, badges — l'œil n'avait
nulle part où se poser ; le centre ressemblait à un formulaire (titre dans un cadre, réglages
et « Supprimer » en rouge plein à chaque ouverture) ; chaque procédure affichait trois
boutons dont un « Supprimer » rouge ; à 1 100 px, un bloc de code à longue ligne **élargissait
la page hors de sa colonne** (piste de grille `1fr` dont le minimum est le contenu) ; les
statistiques de l'en-tête n'apparaissaient qu'à partir de 1 560 px, jamais dans la fenêtre
desktop par défaut (1 440) ; `.columns` cumulait une quarantaine de règles de grille, une
par combinaison de panneaux (journal, écriture, tâches, procédures, document Google avec ou
sans tâches).

**Décisions.**
- **Une identité, tirée du logo** : la page crème et le marque-page ambré. Le centre est
  une page (`--paper`, entre le fond et les panneaux ; un soupçon de crème en thème clair),
  les côtés sont des outils, plus denses. L'**ambre** (`--mark`) ne sert qu'à deux signaux :
  le nœud d'**aujourd'hui** sur le fil du journal et le liseré des tâches **épinglées**. Le
  fil du journal reste la seule signature (§24) ; il est juste plus affirmé (nœud ambré,
  liseré de la couleur du projet sur la ligne ouverte).
- **Les traits disent la structure, pas la décoration** : seuls les panneaux, les champs et
  les cartes gardent un filet (`--line`, `--line-soft`) ; pastilles, badges et étiquettes
  sont une teinte sans cadre. Trois familles de boutons seulement : l'aplat accent
  (`.task-primary`), le cadre discret (`.ghost`) et le symbole (`.icon`). **Supprimer** est
  du texte rouge dont le fond ne s'allume qu'au survol. Sur les cartes de tâche, ★ et ✕
  **apparaissent au survol ou au clavier** ; l'épingle posée reste visible (c'est un état) ;
  au doigt (`hover: none`), tout reste visible. Les actions d'une procédure (Modifier,
  Supprimer, ＋ Fichier) sont du texte discret, une procédure par ligne.
- **Une seule famille de caractères** (la pile système humaniste), un seul monospace
  (`--font-mono`, qui remplace huit piles écrites à la main) ; les chiffres sont
  tabulaires partout. Pas de police embarquée (§24 tient : zéro dépendance).
- **Les colonnes sont une rangée flexible** (`display: flex`) : chaque panneau a sa largeur
  (`flex-basis` = la poignée, `min-width` = la borne), le centre prend le reste, un panneau
  replié disparaît avec sa poignée. Les quarante règles de grille deviennent une dizaine, et
  toute combinaison future est gratuite. La poignée des procédures chevauche la bordure de
  la colonne (`margin: 0 -4px`), comme avant. Les pistes de la feuille Markdown passent en
  `minmax(0, 1fr)` et `.prose` en `min-width: 0` : le débordement d'un bloc de code est
  corrigé.
- **L'en-tête s'allège** (icônes SVG en ligne, boutons sans cadre, recherche en champ plein,
  version en texte) et les **statistiques reviennent dès 1 300 px**. Sur tablette
  (640–900 px), les trois colonnes de tâches sont **côte à côte** ; sur téléphone, les icônes
  de l'en-tête sont des cibles de 44 px sur fond léger. Le reste du mobile (§16, §35) ne bouge
  pas : mêmes points de rupture, mêmes barres, mêmes cibles.
- **Performances.** Le paquet est **découpé** : l'éditeur riche (Tiptap/ProseMirror, 444 Ko),
  les éditeurs du dossier partagé (Word, Excel, CSV, 126 Ko), Google Drive et ses documents,
  l'aperçu de fichier se chargent à la demande (`React.lazy`) ; le premier chargement passe
  de 1 110 à 471 Ko (350 → 148 Ko compressés). Le service worker **précache tous les
  morceaux du build** (`emit-sw.mjs` injecte la liste), la PWA les a donc hors ligne. Les
  trois colonnes latérales sont mémoïsées et leurs gestes stables : taper dans la recherche
  ne redessine plus le journal, les cartes ni les procédures ; la saisie « Nouvelle tâche »
  vit dans son propre composant ; le contexte IA d'une carte n'est calculé qu'au clic.
  `App.tsx` retient ses réglages par un seul `usePersisted` (mêmes clés, mêmes valeurs).

**Écartés.** Un empattement pour le document et un fond crème général (le lieu commun des
pages générées, et une police de plus à embarquer) ; déplacer les statistiques hors de
l'en-tête (§33 en a fait des liens vers les vues) ; un tiroir ou un hamburger (§16) ; un
mode « compact » (§1).

**Ce que ça coûte.** Sur desktop, ★ et ✕ d'une carte demandent un survol ou le clavier
(les noms accessibles ne changent pas ; Playwright clique un élément à `opacity: 0`). Sur la
PWA, la première ouverture d'un document riche après une mise à jour télécharge son morceau
(précaché dès l'installation du service worker suivant). `styles.css` est réécrit : son
historique git repart de ce lot.

**Rouvrir si** une action révélée au survol est manquée à l'usage (la rendre visible, pas
un menu) ; si la page centrale paraît trop proche des panneaux en thème sombre (`--paper`
est la seule valeur à bouger).

---

## 48. Ranger sans encombrer l'écran et garder la saisie — 2026-10-27

**Demande.** « J'ai encore des bugs de champs de texte qui ne fonctionnent plus et ne répondent
plus dans les catégories et je trouve l'interface un peu chargée : améliore grandement l'UI/UX
et le responsive. Je veux aussi que les tâches sélectionnent automatiquement leur catégorie
lorsque les entrées associées en possèdent déjà. »

**Saisie desktop (la cause, mesurée).** Un champ WorkLogs peut garder le focus DOM pendant
que la vue Google détient le clavier natif : on tape dans le nom de catégorie, on clique dans
le document Google, on revient cliquer le même champ — aucun `focusin` ne se produit, le
correctif du §14 ne réclamait donc rien et les frappes partaient dans Google. Reproduit sous
Electron/Xvfb : `webContents.isFocused()` reste à `false` après le clic (test rouge sans le
correctif). `keyboard-claim.ts` écoute maintenant aussi `pointerdown`, en capture, sur les
champs et contenus éditables ; hors desktop, aucun écouteur. Le même parcours vérifie le
chemin du bouton (« ＋ Catégorie », focus posé par programme) : celui-là marchait déjà par
`focusin`. Une frappe Playwright seule ne prouverait rien (elle court-circuite le clavier natif) :
le test lit `isFocused()` des deux `webContents` avant et après le vrai clic.

**Catégories : un bouton, une fenêtre.** Le bandeau des catégories (une rangée de plus sous
les projets, puis un sélecteur, une case et un panneau dépliable qui poussait le contenu) est
remplacé par **un seul bouton dans le bandeau des projets**, entre les pastilles et « Gérer ».
Il ouvre la même fenêtre que la gestion des projets (§35) : sous le bouton sur desktop,
feuille du bas sur téléphone, pleine hauteur en paysage. Elle réunit filtre (Toutes, Sans
catégorie, l'arbre avec couleurs et compteurs), regroupement et rangement ; choisir un filtre
la referme, et le bouton affiche alors la catégorie dans sa couleur (son nom accessible dit
le chemin complet). Formulaire en tête, liste seule qui défile, retrait par la profondeur au
lieu des « ↳ » ; Entrée enregistre, Échap ferme le formulaire puis la fenêtre, le focus
revient au bouton d'origine. Actions ＋ ✎ ✕ au survol à la souris, cibles de 44 px au doigt.
Sur téléphone, le bouton n'est qu'une icône tant qu'aucun filtre n'est posé : le bandeau collé
reste sur une rangée. Gain : une rangée sur desktop comme sur mobile, et plus rien ne bouge
sous la souris quand on range. **Coût mesuré** : la rangée des pastilles, plus étroite sur
téléphone, a révélé un conflit latent — l'aimantation du défilement (`scroll-snap`, §35)
ramenait la rangée sur un point d'accroche juste après le défilement qui montre le projet
choisi, laissé à moitié hors champ (bord droit à 279 px pour une rangée finissant à 249).
L'aimantation est retirée ; le parcours mobile du bandeau, rouge en CI, repasse au vert.

**Écarté.** Le premier lot de cette reprise gardait un sélecteur natif permanent, une case
« Regrouper » et un panneau « Gérer » déplié dans le flux : toujours une rangée, deux
« Gérer » empilés sur mobile, un contenu poussé vers le bas. Un menu dans le `<select>`
(« Gérer… » comme dernière option) : les flèches du clavier l'auraient déclenché.

**Cartes et éditeur allégés.** Le pied des cartes (＋ Documents, ＋ Entrée liée, ✨ IA) et le
✕ d'un document lié suivent la règle de ★ et ✕ (§47) : au survol ou au clavier, place
réservée, toujours visibles au doigt. Le compteur « 📎 N » des étiquettes et l'intitulé
« 📎 N documents » répétaient la liste qu'ils annonçaient : retirés ; chaque document tient
sur une ligne, origine et date dans l'infobulle. Dans l'éditeur, Imprimer, Archiver et
Supprimer sont groupés (un retour à la ligne ne les sépare plus) et, colonnes côte à côte,
les sélecteurs prennent la largeur de leur choix (`field-sizing: content`), pas celle du
plus long chemin de catégorie. Tablette tactile : pastilles du bandeau à 40 px.

**Classement automatique.** Au lien ou au classement d'une entrée associée, une tâche libre
reprend l'unique catégorie présente parmi ses entrées du même projet. Une tâche classée garde
son choix, même si un document lié ensuite porte une autre catégorie ; plusieurs catégories
distinctes restent ambiguës pour une tâche libre. Aucun projet n'est changé implicitement.
Le rattrapage initial ne joue qu'une fois : les choix « Sans catégorie » ultérieurs restent
intacts au redémarrage. Marqueur local, sans table ni version IndexedDB supplémentaire.
SQLite groupe mutation et héritage dans une transaction ; la PWA les sérialise et inscrit
chaque tâche persistée dans l'outbox avant notification ou reprise après erreur.
**Pendant l'édition d'une tâche**, le formulaire retient le classement reçu sur lequel repose
son choix (`category_base`) : lier un document qui apporte une catégorie met le sélecteur à
jour tant qu'on n'y a pas touché — sinon « Enregistrer » renvoyait « Sans catégorie » et
effaçait l'héritage (test rouge avant, vert après) ; un choix fait à la main l'emporte.

**Validation.** Cas nominaux, choix existants, ambiguïtés, autres projets et reprise de
migration testés dans les deux backends ; gestes App (dont les deux cas du formulaire),
parcours navigateur desktop/mobile/tablette tactile, parcours Electron du clavier, captures
clair/sombre à 1440, 1100, 844 × 390, 412 et 360 px. Aucune dépendance ajoutée. Comptages
validés dans `00-HANDOVER.md`.

**Rouvrir si** le filtre par catégorie sert plusieurs fois par minute : un sélecteur natif à
côté du bouton coûterait une largeur de pastille, pas une rangée.

---

## 49. Suggérer des tâches depuis le brouillon d'une note — 2026-10-29

**Demande.** Améliorer l'assistance IA et créer des tâches directement depuis une entrée
en cours d'édition, à partir de son contexte. L'extraction du §41 ne retient que des actions
explicitement écrites : elle ne répond pas au besoin de suggérer une suite à un problème
décrit sans action formulée.

**Choix.** Dans une note locale Markdown ou riche non vide, **✨ Suggérer des tâches avec
l’IA** est accessible près de la création de tâche liée. L'IA peut proposer des tâches
raisonnablement déduites de la note, en utilisant le contexte du projet pour la comprendre.
Chaque proposition doit citer un extrait exact du texte source ; le contexte complémentaire
ne suffit pas à justifier une tâche. Ces propositions sont des hypothèses à vérifier, pas
des faits ou engagements. L'extraction explicite reste distincte et conserve ses règles.

Le panneau commun permet de sélectionner, corriger titre et échéance, puis créer les tâches
liées à la note. Huit propositions au plus ; réponse structurée et extraits vérifiés,
doublons simples et cases terminées écartés. Une date n'est préremplie que si elle est
valide et écrite littéralement au format `YYYY-MM-DD` dans l'extrait cité. Les tâches déjà
liées sont relues avant création : un échec partiel ou une réponse perdue ne rejoue pas les
réussites. Une modification du titre, du contenu, du projet ou des sources sélectionnées
invalide la proposition ; ces conditions sont aussi contrôlées avant chaque création.
La note et les frappes en cours restent conservées. Le contenu des documents Google et des
pièces jointes n'est pas transmis, comme aux §17 et §23. Aucune dépendance ni migration.

**Limite.** Les contrôles vérifient l'ancrage textuel et les doublons simples ; ils ne
prouvent pas qu'une déduction du modèle est utile ou correcte. La relecture humaine reste
nécessaire et la pertinence se juge avec une clé réelle selon `04-RECETTES.md` §14.
Les priorités et estimations d'échéances ont évolué ensuite : voir §50.


---

## 50. Contexte IA et planification des tâches suggérées — 2026-10-29

**Demande.** Améliorer les fonctions IA et leur contexte, classer les tâches générées par
priorité et leur proposer des échéances.

**Contexte.** La sélection locale des documents et des tâches voisines utilise le titre et
le texte courant : les mots du titre gardent plus de poids, les documents liés restent
prioritaires, et les correspondances pertinentes du même projet remontent. La requête est
bornée, en conservant début et fin du brouillon. Les exclusions de sources retirent aussi
leur contribution au vocabulaire ; les données intermédiaires nécessaires au recalcul restent
locales. Les documents Google, pièces jointes, autres projets et sources exclues ne sont pas
transmis par cette recherche. Même sélection de sources et plafonds (§41), relecture avant
application, changement de projet et frappes conservées.

**Planification.** Pour la suggestion et l'extraction depuis une note, l'IA propose les
priorités déjà prises en charge (`high`, `normal`, `low`). La liste de relecture les trie
de haute à basse de façon stable ; une valeur absente ou inconnue devient normale. Le titre,
la priorité et la date restent modifiables ; seules les lignes sélectionnées sont créées et
liées. L'ordre manuel des tâches existantes n'est pas modifié. Une explication concise peut
accompagner la planification des suggestions ; elle n'est pas une preuve de sa justesse.

Pour « Suggérer des tâches », la date locale du jour et la date de la note sont envoyées afin
de proposer, si elle peut être justifiée, une date valide explicite ou estimée. Au plus cinq
tâches ouvertes pertinentes du même projet, leurs priorités et échéances enregistrées sont
également transmises et visibles dans le contexte ; aucune disponibilité ni charge n'en est
déduite. Les autres gestes IA ne reçoivent pas ces détails de planification. Les dates et
priorités sont des hypothèses révisables, jamais des engagements ; un champ vide reste possible.
La proposition unique depuis une note inclut les actions écrites et les tâches raisonnablement
déduites ; elle remplace l'ancien geste séparé d'extraction. Une réponse IA reste ancrée dans un
extrait exact de la note, et les doublons simples ainsi que les actions terminées sont écartés.
Les échéances explicites ou estimées sont à relire. La date de la note entre dans les
vérifications d'obsolescence, en plus du titre, du contenu, du projet et des sources. En cas de
création partielle, les réussites restent acquises et ne sont pas rejouées.

La route transactionnelle de création liée et son miroir PWA acceptent désormais la priorité,
avec validation serveur et défaut « normale » compatible avec les anciens clients. Aucune
nouvelle dépendance ni migration. Les tests automatiques simulent le service IA : ils vérifient
les garde-fous, pas la pertinence des estimations en situation réelle. La recette §14 reste à
juger avec une clé réelle.

**Validation.** Recettes initiale isolée et finale `./scripts/check.sh` vertes, avec parcours mobile de planification ; détails dans `00-HANDOVER.md`.

---

## 51. Une seule action IA pour créer des tâches depuis une note — 2026-10-29

Le bouton « Suggérer des tâches avec l’IA » rejoint le menu **✨ IA** ; l'ancien bouton
« Extraire les actions » est supprimé. La suggestion unique couvre les actions explicites
comme les suites déduites, et conserve la relecture, les extraits exacts, la sélection,
la validation avant création et la reprise après création partielle. Aucune migration ni
dépendance ; le comportement est testé dans l'interface et le parcours mobile.

---

## 52. Démarrer la tâche suggérée la plus urgente et replier les terminées — 2026-10-29

Lors de la création d'une sélection IA, WorkLogs place sa tâche de plus haute priorité en
« En cours » ; à priorité égale, l'échéance la plus proche départage, puis l'ordre de la
proposition. Les autres tâches restent « À faire ». Le calcul se base sur les champs relus
et modifiés par l'utilisateur, et ignore les tâches déjà liées lors d'une reprise partielle.
La colonne « Terminé » du panneau Tâches est repliée par défaut ; son bouton accessible
permet de l'afficher ou la masquer. La création liée accepte un statut facultatif, avec
« À faire » comme défaut pour les anciens clients. Aucun changement de schéma.

---

## 53. Téléphone : une vue à la fois, choisie par la barre du bas — 2026-10-29

**Demande.** « Améliore grandement le design et l'UI/UX de la PWA afin que tout soit bien
plus ergonomique et intuitif sur mobile […] quitte à s'éloigner du design desktop. »

**Constat (captures à 412 × 860, jeu de démonstration de `.design/`).** Le téléphone empilait
journal, écriture, tâches et procédures en **une page de 4 000 px**. La barre du bas
ressemblait à la navigation d'une application mais **repliait** des cartes : toucher
« Tâches » faisait disparaître les tâches ; toucher « Procédures » ajoutait une carte tout en
bas, hors de vue, sans que rien ne bouge à l'écran. Atteindre les tâches depuis une entrée
demandait de faire défiler tout le texte ; revenir au journal, de tout remonter, et le geste
retour d'Android fermait l'application. L'éditeur posait six rangées de réglages (~330 px)
avant la première ligne de texte. Sans glisser-déposer au doigt, une tâche ne pouvait pas
passer « En cours ».

**Décisions (téléphone seulement : ≤ 600 px, ou ≤ 900 × 500 px en paysage).**
- **Une vue à la fois.** La barre du bas choisit Journal, Écriture, Tâches ou Procédures ;
  un seul panneau est à l'écran, de bord à bord (plus de carte dans la carte ni d'intitulé :
  la barre dit où l'on est). Le journal est l'accueil. Mêmes boutons qu'en desktop, mêmes noms
  accessibles : `aria-pressed` dit la vue affichée. Les préférences de panneaux du desktop
  (`worklogs-show-*`) ne sont pas touchées, la vue n'est pas retenue au redémarrage.
- **Ouvrir, c'est y aller** : `revealEditor`, qui faisait défiler jusqu'à la carte Écriture,
  passe à la vue Écriture, par le haut. Chaque vue **retrouve sa position** de défilement.
- **Retour d'Android.** Quitter le journal laisse une seule marche dans l'historique
  (`history.pushState`, marquée `worklogsView`) : retour ramène au journal ; revenir au journal
  par la barre la consomme. Rechargée hors du journal, la marque est oubliée. Pas d'URL, pas de
  routeur (§1) : une marche, rien d'autre.
- **En-tête sur une rangée** (logo, recherche, thème, export, compte), qui s'efface en
  descendant ; la barre du bas prend des icônes (le fil du journal, un stylo, une case, un
  livre) au-dessus de leur nom, l'icône active sur une pastille. En paysage, la même barre en
  rangée de 46 px, et l'en-tête défile lui aussi (390 px de haut).
- **Écriture** : date, projet, catégorie, Imprimer, Archiver et Supprimer se replient derrière
  une ligne qui les résume (« aujourd'hui · Chantier », `EntryEditor` `compact`) ; Écrire / Lire,
  la tâche liée et ✨ IA restent visibles. Le texte commence ~200 px plus haut. L'état
  d'enregistrement passe sous le titre, qu'il coupait.
- **Tâches** : vues rapides sur une rangée qui défile d'un bord à l'autre ; le formulaire
  d'une tâche gagne **Statut** (À faire, En cours, Terminé ; la carte va au bas de sa colonne,
  comme un dépôt en fin de colonne). Il sert aussi au clavier sur desktop.
- **Page d'écriture** : sur téléphone, le fond de la page (`--paper`) va jusqu'à la barre,
  même pour un texte court (`.app:has(> .columns:not(.hide-center))`).

**Écartés.** Refaire l'identité (posée au §47, la demande porte sur l'ergonomie) ; des gestes
de balayage entre vues (ils se battraient avec les rangées qui défilent au doigt) ; un bouton
flottant de création (chaque vue commence par sa création) ; une marche d'historique par
changement de vue (le retour traverserait chaque onglet touché) ; changer la tablette en
portrait (601–900 px), qui garde ses cartes empilées.

**Ce que ça coûte.** Sur téléphone, on ne voit plus deux zones à la fois (une tâche et sa
note) : un geste de la barre. Les parcours mobiles qui supposaient la page empilée ont été
réécrits vue par vue. La recherche reste en tête de page, pas dans le bandeau collé (§35).

**Rouvrir si** une vue doit montrer une autre zone en même temps (la note d'une tâche, par
exemple) : la réponse serait une feuille du bas, pas le retour à la page empilée.

---

## 54. Téléphone : choisir un projet dans la liste, plus dans une rangée — 2026-10-29

**Demande.** « Je trouve la navigation entre les différents projets encore un peu compliquée
sur mon Pixel : trouve une solution UI/UX mobile parfaitement adaptée. »

**Constat (412 × 860, quinze projets).** La rangée du bandeau (§35) ne montrait que « Tout » et
une pastille et demie : trouver un projet demandait de balayer de côté plusieurs écrans de
pastilles aux noms coupés. « Gérer », le seul endroit où tous les projets se voyaient, était un
piège : toucher un nom y ouvrait le **renommage** (et le clavier), pas le projet.

**Décisions (téléphone seulement, mêmes requêtes que §53).**
- **Un bouton nomme le projet courant**, en toutes lettres et dans sa couleur, à la place de la
  rangée (`ProjectBar` `compact`) ; « Tous les projets » sans filtre, avec un anneau au lieu
  d'une couleur. Les catégories gardent leur bouton à côté.
- Il ouvre **la liste de tous les projets** dans la feuille du bas existante (§35) : une ligne de
  52 px par projet, ses tâches ouvertes, le projet en cours coché et pris par le focus. Toucher
  **choisit et referme** ; **Retrouver un projet** dès huit projets, Entrée prend le premier
  trouvé.
- **Choisir et gérer sont deux gestes** : « Gérer les projets », en pied de liste, montre la
  gestion inchangée dans la même feuille. Le focus revient au bouton du bandeau.
- Desktop et tablette gardent la rangée : à la souris et sur grand écran, un clic suffit.

**Écartés.** Balayer le contenu pour passer au projet voisin (invisible, et en conflit avec les
rangées qui défilent au doigt) ; garder la rangée en plus du bouton (deux façons de faire la même
chose, et toujours une pastille et demie) ; des projets « récents » en tête (l'ordre alphabétique
se retient, la recherche fait le reste).

**Ce que ça coûte.** Deux touchers au lieu d'un pour un projet déjà visible dans l'ancienne
rangée (au plus le premier ou le deuxième). Les parcours mobiles choisissent par la liste.

**Rouvrir si** l'usage montre des allers-retours constants entre deux projets : un raccourci
« projet précédent » dans la liste, pas le retour de la rangée.
