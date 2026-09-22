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

**PWA sans secret.** Un client « Web » est confidentiel et la PWA est un site public :
publier son secret est interdit. Seul le flux « jeton » (`response_type=token`) marche
sans serveur ; le prix est une session d'une heure, reprise par une redirection
`login_hint` sans nouveau consentement, jamais déclenchée d'office en pleine saisie.
Un client personnel avec secret garde le flux code + PKCE (session longue).

**Identité minimale.** `openid email profile` en plus de `drive.file`, lus une fois via
`userinfo` pour l'affichage ; un échec n'empêche jamais Drive. Pas d'avatar : il faudrait
élargir la CSP à `googleusercontent.com` pour une image décorative.

**Rouvrir si** un serveur WorkLogs hébergé apparaît (il pourrait garder un jeton de
rafraîchissement pour la PWA), ou si Google retire le flux « jeton ».

