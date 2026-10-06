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
- Restent de l'idée « procédures ↔ partage » : IA par le pont Markdown §23 — à redemander.

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
