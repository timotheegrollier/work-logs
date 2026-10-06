# 🤝 WorkLogs — fiche de relève (LIRE EN PREMIER)

> **Mise à jour :** 2026-09-21 · Version : v0.30.0.
> **Lot courant :** sidebar Procédures séparée des entrées (4e zone repliable
> à droite, persistée, desktop comme PWA) avec envoi direct de fichiers par
> procédure ; les procédures restent des entrées (`kind`), la grille couvre
> toutes les combinaisons de panneaux.
> **Validation :** `./scripts/check.sh` vert : **141 tests API, 226 front,
> 33 desktop unitaires, 25 scripts, 34 navigateur et 10 desktop e2e**.
>
> **Lot précédent (candidat v0.24.0) :** en-tête mobile aéré (Pixel 9a, 412 px),
> rebasé sur v0.23.0 : marque, recherche, panneaux en trois lignes, cibles 44 px,
> sans JS ni dépendance.
>
> **Lot précédent :** panneaux latéraux repliables (Journal/Tâches, desktop comme
> PWA, état retenu) pour n'afficher que ce qui sert.
> **Validation :** `./scripts/check.sh` vert (lots PWA + aperçu fusionnés) :
> 128 tests API, 173 front, 33 desktop unitaires, 24 scripts, 28 navigateur
> et 10 desktop e2e.
>
> **Lot précédent :** **aperçu des pièces jointes dans l'app** — `GET /api/files/:stored/preview`
> sert les mêmes octets en `inline` avec le type enregistré (le téléchargement `attachment`
> reste inchangé) ; le dialogue `FileViewer` affiche images, PDF et texte dans l'entrée,
> annonce franchement les tableurs (`.xlsx`, `.ods`) faute de bibliothèque, et laisse
> toujours **Télécharger**. Le service worker PWA sert le binaire IndexedDB avec la bonne
> disposition. Aucune dépendance ajoutée ; les types dangereux (`text/html`, `image/svg+xml`)
> sont renvoyés en `text/plain` + `nosniff`.
>
> **Lot précédent :** correctif multipart Drive CRLF publié en v0.15.1 (travail conservé tel quel).
> **Deux courses e2e restent non élucidées : point 0 de « Ce qui reste à faire ».**
> **Reprise prioritaire : [08-GOOGLE-DOCS.md](08-GOOGLE-DOCS.md)** pour le diagnostic
> réel, les capacités de l’éditeur et les limites Google.

## Lot du 2026-10-05 (5) — dossier partagé, lot 4 : classeurs Excel (.xlsx) — v0.45.0

Décision : §27. Éditeur `XlsxFileEditor.tsx` (une feuille à la fois, liste « Feuille ») sur la
grille des CSV (`SheetGrid` : barre de saisie distincte de l'affichage, cellules en lecture
seule motivées, nombres à droite). Cœur `xlsx.ts` (lecture, écriture cellule par cellule,
formules à recalculer), `xlsx-format.ts` (formats d'Excel à la française, saisie),
`xlsx-formula.ts` (grammaire, traduction français ↔ anglais, dépendances). `ooxml.ts` reprend
de `docx.ts` ce que Word et Excel partagent ; `zip.ts` sait retirer une entrée
(`calcChain.xml`). Fixture Excel construite pour les tests : `web/src/test/xlsx-fixture.ts`.
- **Trouvé en route** : LibreOffice 24.2 **ne recalcule pas** un `.xlsx` à l'ouverture (réglage
  par défaut) et ignore `fullCalcOnLoad` : après une modification, il montrait l'ancien total.
  D'où le retrait de la valeur des seules formules qui lisent une cellule modifiée (même
  feuille, autres feuilles, noms définis, formules recopiées) : vérifié par conversion
  LibreOffice, tous les totaux justes, y compris `Résumé!A1 = SUM(Suivi!B2:B3)*(1+Taux)`.
- **Tests** : 212 API, **437 front** (+31 : `xlsx.test.ts`, `xlsx-format.test.ts`,
  `xlsx-formula.test.ts`, suppression d'entrée dans `zip.test.ts`, cellule protégée dans
  `SheetGrid.test.tsx`, 2 gestes dans `App.test.tsx`), 44 desktop, 25 scripts, 8 relais,
  **49 navigateur** (+1 : nombre et formule au clavier puis Ctrl+S), 13 desktop : 788 en tout ;
  avec le correctif de connexion ci-dessous, 45 desktop unitaires et 14 parcours desktop : **790**.
  Pendant `./scripts/check.sh`, le parcours desktop « masquer le document rend le clavier »
  (Google, sans rapport avec ce lot) a échoué une fois sur l'écran réel — focus de fenêtre ;
  relancé : 3/3 seul, puis 13/13 pour toute la suite desktop.
- **Vu dans un vrai navigateur** (Chromium, 1440 et 412 px) : classeur de test ouvert, montants
  `1 234,50 €`, dates, pourcentages, booléens et erreurs à la française, en-tête de tableau et
  formule recopiée grisés, raison affichée sur une cellule fusionnée, formule fautive listée
  sous la grille ; parcours Playwright : `87,5` puis `=SOMME(B2:B3;10)` au clavier, Ctrl+S,
  fichier écrit cellule par cellule. Excel : sur le TSE.

**Correctif du même lot — se connecter au partage (v0.45.0).** « Connexion à
\\172.16.1.20\D… » restait sans fenêtre puis échouait : `xdg-open` (via `gio open`) refuse
une adresse SMB non montée sans rien afficher. WorkLogs lance maintenant Nemo directement
sur l'adresse : sa fenêtre « Authentification requise » s'ouvre (vue sur la machine de Timo,
avec le vrai code de WorkLogs). Tests : 1 unitaire (`shared-mount.test.mjs`), 1 parcours
desktop (mot de passe à saisir : faux `gio` qui échoue, faux Nemo qui monte). Le serveur
expose les partages `D`, `Global`, `Pisciculture`… (liste anonyme `smbclient -L`).

### À vérifier par Timo (classeurs Excel)

1. Ouvrir un vrai classeur `.xlsx` de l'équipe : valeurs, dates et montants s'affichent-ils
   comme dans Excel ? Quelles cellules sont en lecture seule, et la raison est-elle juste ?
2. Modifier un nombre, un texte, une date, une formule (`=SOMME(…)`) ; envoyer ; ouvrir
   **dans Excel sur le TSE** : aucune réparation proposée ? Totaux recalculés ? Graphiques,
   mises en forme conditionnelles, validations, tableaux intacts ?
3. Même fichier ouvert par « Ouvrir avec… » dans LibreOffice : totaux justes ?
4. Le faire modifier et réenregistrer par un collègue dans Excel, puis le rouvrir dans WorkLogs.
5. M'envoyer (sans données de l'entreprise) un `.xlsx` qui pose problème, s'il y en a.

## Lot du 2026-10-05 (4) — dossier partagé, lot 3 : documents Word (.docx) — v0.44.0

Décision : §26. Éditeur `DocxFileEditor.tsx` ; cœur `docx.ts` (lecture → document Tiptap +
tranches d'origine ; écriture au plus juste), `docx-extensions.ts` (schéma dédié, numéros de
liste, refus de coller un objet conservé), `zip.ts` (extrait de `docx-preview.ts`, qui s'en
sert désormais, + écrivain), `xml-scan.ts`. Fixture Word construite pour les tests :
`web/src/test/docx-fixture.ts` ; la fixture LibreOffice réelle (`procedure.docx`) fait
l'aller-retour à l'identique.
- **Trouvé en route** : `setEditable()` de Tiptap émettait une modification ; l'éditeur
  recréait un brouillon juste après chaque envoi (parcours Playwright instable, 1 fois sur 2).
- **Tests** : `./scripts/check.sh` vert — 212 API, **406 front** (+22 : `docx.test.ts`,
  `zip.test.ts`, 2 gestes dans `App.test.tsx`), 44 desktop, 25 scripts, 8 relais,
  **48 navigateur** (+1 : taper dans un `.docx` puis Ctrl+S), 13 desktop : 756 en tout.
- **Vu dans le navigateur intégré** : document de test type Word ouvert (titre, italique et gras
  d'origine, lien, liste 1./a), image et table des matières conservées, tableau), phrase
  ajoutée + nouveau paragraphe, Ctrl+S ; le fichier écrit garde `w14:paraId`, espacements et
  `rPr` d'origine, et **LibreOffice l'ouvre** (conversion texte : tout y est). Word : sur le TSE.

### À vérifier par Timo (documents Word)

1. Ouvrir une vraie procédure `.docx` de l'équipe : le texte, les titres, les listes et les
   tableaux s'affichent-ils correctement ? Quels objets apparaissent « conservés » ?
2. Modifier une phrase, un titre, une cellule ; envoyer ; ouvrir le fichier **dans Word sur le
   TSE** : aucune réparation proposée ? Mise en forme, numérotation, en-tête, images intacts ?
3. Le faire modifier et réenregistrer par un collègue dans Word, puis le rouvrir dans WorkLogs.
4. M'envoyer (sans données de l'entreprise) un `.docx` qui pose problème, s'il y en a.

## Lot du 2026-10-05 (3) — se connecter au partage par son adresse, lecture GVFS — v0.43.1

Retour de Timo : « je n'arrive pas à ouvrir le dossier partagé par le TSE dans l'app desktop
(Linux Mint) ». Constaté sur sa machine : **aucun partage monté** (ni GVFS, ni CIFS), aucun
dossier enregistré dans WorkLogs — le sélecteur ne choisit qu'un dossier déjà monté.
- **Se connecter** par `\\serveur\partage` (GVFS, comme Nemo ; mot de passe dans la
  fenêtre de Nemo, jamais dans WorkLogs), **Se reconnecter** après redémarrage. Décision : §25.
- **Bug trouvé en route** : sur un montage GVFS, la lecture positionnée échoue (`ESPIPE`) —
  WorkLogs n'aurait lu aucun fichier d'un partage ouvert par Nemo. Lecture et écriture
  séquentielles, repli automatique ; prouvé sur une archive montée par GVFS (le test échoue
  avec l'ancien worker).
- Tests : `desktop/test/shared-mount.test.mjs` (3), `api/test/shared-gvfs.test.js` (1), parcours
  desktop « se connecter par l'adresse, puis se reconnecter ».

**À faire par Timo** : dans WorkLogs (colonne Procédures → Dossier partagé), taper l'adresse
du partage telle qu'utilisée sous Windows, Se connecter, saisir le mot de passe dans la
fenêtre qui s'ouvre si elle s'ouvre. Me dire si le montage réussit et si l'**envoi** d'un
fichier fonctionne (l'écriture par GVFS sur un vrai SMB n'a pas pu être essayée ici).

## Lot du 2026-10-05 (2) — dossier partagé TSE, lot 2 : verrou, projets, historique — v0.43.0

Demandé par Timo : « vas-y pour le lot 2, commit, pousse et bump : je teste sur la prod ».
Décision : §25 (paragraphe « Lot 2 »).

- **Verrou WorkLogs** (`acquireLock`/`releaseLock`/`expireLocks` dans `shared-service.js`,
  opérations `renewLock`/`unlinkIfMarked` du worker) : pris à la première frappe, renouvelé
  chaque minute, rendu à la fermeture, après 10 min sans frappe, par le bail serveur (3 min),
  au démarrage et à l'arrêt. Verrou WorkLogs d'un autre poste « oublié » après 3 min
  d'observation sans renouvellement → « Prendre la main ». LibreOffice ouvert sur cet
  ordinateur bloque aussi ; `describeLock` montre le verrou d'un autre avant le nôtre.
- **Question de sortie** (`web/src/shared-leave.ts`) : Envoyer · Garder le brouillon ici ·
  Annuler, posée par Fermer, une entrée, un autre fichier, une création.
- **« Ouvrir avec… »** sur le vrai fichier (IPC `worklogs:shared-open-with`, `openTarget`),
  `REFUSED` exporté de `open-file.mjs`.
- **Sous-dossier par projet** (routes `/api/shared/projects/:id/folder`), **historique** et
  restauration en brouillon (`/api/shared/versions/:id/restore`), **nom affiché** dans
  Paramètres › Dossier partagé (`SharedSettings.tsx`).
- Fusion de `master` (Dependabot : Electron 44.4.5, vitest 5.0.2, multer 2.4.0…) avant le lot.
- **Tests** : `./scripts/check.sh` vert — **211 API** (+11), **384 front** (+9), 41 desktop
  unitaires, 25 scripts, 8 relais, **47 navigateur** (+2), **12 desktop e2e** (+1) : 728 en tout.
  Deux parcours Google du desktop (« outils dans le canevas… dimensions », « masquer le document
  rend le clavier ») ont chacun échoué une fois dans `check.sh` lancé sur la vraie session (focus
  et tailles du bureau Cinnamon pendant que la machine sert) ; seuls, ensemble ou dans la suite
  desktop complète, ils passent à chaque fois (3 × 12/12). À surveiller avec les deux courses du
  point 0.

### À vérifier par Timo (en plus de la liste du lot 1)

1. Taper dans un fichier : un `.~lock.<nom>#` apparaît-il sur le TSE ? Un collègue qui ouvre
   ce fichier dans **LibreOffice** voit-il « en cours d'utilisation par <ton nom> » ?
2. Le même fichier ouvert dans **Word** par un collègue : WorkLogs refuse-t-il la main avec
   son nom ? (Word, lui, ne verra pas ton verrou : c'est attendu.)
3. « Ouvrir avec… » sur un `.docx` du partage : LibreOffice l'ouvre-t-il **en écriture** sur le
   partage, et WorkLogs affiche-t-il ensuite « Ouvert par … dans LibreOffice » ?
4. Fermer WorkLogs pendant qu'on a la main : le `.~lock` disparaît-il du TSE ?

## Lot du 2026-10-05 — dossier partagé TSE, lot 1 : socle + texte (branche `claude/worklogs-file-coedition-bcae02`)

Plan validé par Timo : le dossier du TSE (monté en SMB) devient la référence ; les fichiers
se modifient **des deux côtés, chacun son tour, sans perte**, dans WorkLogs. Décision : §25.

- **Serveur** : `api/src/shared-io.js` (worker borné, disjoncteur), `shared-locks.js` (`~$` de
  Word/Excel, `.~lock#` de LibreOffice/WorkLogs), `shared-service.js` (chemins sûrs, magasin de
  versions, brouillons, envoi gardé sur place, conflits, réessais, rétention),
  `shared-routes.js` (`/api/shared/*`, garde `localOnly`). Tables locales sans clé étrangère.
- **Desktop** : IPC `worklogs:shared-choose-root` / `forget-root` (dialogue natif ; parcours de
  test : `WORKLOGS_CHOOSE_FOLDER`). Web/dev et e2e : `WORKLOGS_SHARED_ROOT`.
- **Front** : section « Dossier partagé » sous les procédures (`SharedFolder.tsx`, ne lit le
  partage que colonne affichée), `SharedFileEditor.tsx` au centre (brouillon local, « Enregistrer
  sur le partage »/`Ctrl+S`, bandeaux lecture seule/attente/hors ligne/conflit et trois choix),
  `TextFileEditor.tsx` (.txt/.md), `CsvFileEditor.tsx` + `SheetGrid.tsx` (.csv/.tsv),
  `text-codec.ts`, `text-file.ts`, `csv-file.ts`, `shared-session.ts`.
- **Trouvés en route** : un worker `unref()` avant ses écouteurs retient le processus ; un worker
  `eval` hérite de `--input-type=module` (d'où `execArgv: []`) ; `fetch` de Node ignore l'en-tête
  `Host` et ne sait pas lire le `Blob` de jsdom (envoi des octets en `Uint8Array`) ; la grille
  doit donner le focus à sa barre **tout de suite**, sinon une frappe rapide perd des caractères
  (vu seulement dans Chromium) ; une requête de plus au démarrage rendait instable
  « supprimer un projet garde ses entrées » (le test clique avant le chargement) — la section
  ne lit plus rien tant que la colonne Procédures est masquée.
- **Vu dans le navigateur intégré** (faux partage, CSV Windows-1252) : saisie, `Ctrl+S`, lecture
  seule, conflit et « garder les deux » conformes ; fichier relu sur disque (Windows-1252, CRLF,
  une seule ligne changée). Corrigés : une **touche morte** (« ^ » puis « e » sur un clavier
  français) ou une méthode de saisie n'ouvrait pas la barre et le caractère se perdait ; un nom
  de fichier long élargissait la colonne et poussait les pastilles hors champ.
- **Tests** : `./scripts/check.sh` vert — **200 tests API** (+36), **375 front** (+35),
  **41 desktop unitaires** (+1), 25 scripts, 8 relais, **45 navigateur** (+3) et **11 desktop
  e2e** (+1) : 705 en tout. Corrigé au passage : une course préexistante de
  `GoogleDrive.test.tsx` (« un conflit Drive… », ~1 échec sur 7, mesuré aussi sur la version
  d'origine) attend maintenant l'état final au lieu de le lire à l'instant de l'erreur.

### À vérifier par Timo sur le vrai TSE (rien de cela ne se voit depuis un conteneur)

1. Monter le partage (Fichiers → Autres emplacements, ou CIFS) ; noter le chemin et si c'est
   GVFS (`/run/user/…/gvfs/…`) ou CIFS. Choisir ce dossier dans WorkLogs (Procédures →
   Dossier partagé → Choisir le dossier…).
2. Un collègue ouvre un `.csv` dans Excel : WorkLogs affiche-t-il son nom ? L'envoi passe-t-il
   en attente, puis part-il quand Excel est fermé ? Noter le message exact.
3. Même chose avec un `.docx` ouvert dans Word (seul l'affichage du nom compte en lot 1).
4. Un collègue enregistre un `.md` ou `.csv` pendant ton brouillon : conflit, puis essayer les
   trois choix.
5. Après un envoi, onglet Sécurité du fichier sur le TSE : droits inchangés ?
6. Couper le VPN : l'interface reste-t-elle réactive ? Combien de temps avant « Injoignable » ?
   L'envoi part-il au retour ?
7. Ouvrir dans Excel français un CSV modifié par WorkLogs : accents et colonnes corrects ?
8. Envoyer à Timo (sans données de l'entreprise) des fichiers `~$` réels de Word et d'Excel,
   et les fixtures du lot 0 (`word-tse.docx`, `excel-tse.xlsx`…) pour les lots .docx/.xlsx.

### Lots suivants (plan validé)

2. Verrou WorkLogs (pris à la première frappe, rendu après 10 min), dialogue de sortie avec
   brouillon, « Ouvrir avec… » sur le vrai fichier, sous-dossier du partage par projet, versions
   et restauration.
3. `.docx` par patch ciblé (zip, analyseur XML à positions, schéma Tiptap dédié).
4. `.xlsx` cellule par cellule.
5. À reconfirmer : fusion `.csv/.md`, recherche, arbre hors ligne, procédures ↔ partage.

## Lot du 2026-09-24 (4) — échec de connexion Google visible, URI de redirection affichée

- Reste du lot « secret exigé » (2026-09-22, rendu caduc par le relais : le relais détient
  le secret, la PWA n'en a plus besoin) : l'échec du retour Google restait invisible quand
  on partait du menu du compte (l'erreur de synchro ne s'affichait que connecté).
- `AccountMenu` affiche désormais l'erreur de synchro aussi déconnecté ; le formulaire
  client personnel montre l'URI de redirection exacte à autoriser (`webRedirectUri()`).
  Aucune dépendance ajoutée.
- Tests : front (2 — erreur visible déconnecté, URI exacte).

## Lot du 2026-09-26 (2) — lier une entrée à une tâche existante

- L'éditeur ne savait que *créer* une tâche liée ; le sens inverse existait côté carte
  (« Lier des documents »). Nouveau geste miroir dans l'entrée : **Lier une tâche
  existante** (recherche + sélection multiple, mêmes classes `document-linker`), via
  `POST /api/tasks/:id/documents/:entryId` (déjà idempotent) et `localApi`
  existant — aucune route ajoutée. `linkedTasks` porte désormais l'`id` pour exclure
  les déjà-liées. Aucune dépendance ajoutée.
- Tests : front (1, `App.test.tsx` — lie sans créer, la liée sort du lieur).

## Lot du 2026-09-26 — bandeau projets mobile : pastilles toute largeur

- Sur 412 px (Pixel 9a), le choix du projet partageait sa rangée avec « Gérer les
  projets » et devenait trop étroit dès 2-3 projets. Les pastilles occupent désormais
  toute leur rangée (`.project-strip .chips { flex: 1 1 100% }`, le conteneur
  enveloppait déjà), la gestion passe dessous, pastilles à 44 px de haut.
  Desktop inchangé. Aucune dépendance ajoutée.
- Tests : e2e (1, `e2e/project-strip.spec.ts` — largeur ≥ 90 % du bandeau, gestion
  dessous, 44 px, création + filtre + pas de défilement horizontal).

## Lot du 2026-09-24 — en-tête allégé, journal en fil, ergonomie desktop et mobile

- Demande : retirer **Exporter** de l'en-tête une fois connecté à Google (la synchro auto suffit)
  et améliorer nettement l'interface, desktop comme mobile. Pourquoi : `05-DECISIONS.md` §24.
- En-tête : Exporter masqué si session Google active et non expirée ; largeurs au pixel près
  déplacées dans **Paramètres → Affichage** ; panneaux en contrôle segmenté ; recherche à loupe.
- Mobile (≤ 600 px) : en-tête sur deux lignes, interrupteurs de panneaux dans une barre fixée en
  bas (toujours `aria-pressed`), pastilles projets sans retour à la ligne, fondu de défilement.
- Éditeur : titre d'abord, actions (tâche liée, IA) en pastilles dessous ; plus de « Details »
  parasite sur les entrées locales. Tâches : priorité affichée seulement si ≠ normale, pied de
  carte « ＋ Documents / ＋ Entrée liée » (noms accessibles inchangés).
- Journal en fil (ligne + nœud par jour, plein pour aujourd'hui) ; libellés en casse de phrase ;
  `--accent-solid` pour les aplats blancs ; pile de polices humanistes. Aucune dépendance.
- Tests : App (3 nouveaux : largeurs dans Paramètres, Exporter masqué connecté, gardé si expiré ;
  largeurs et priorité adaptés), e2e `mobile-header` (barre du bas) et `sidebar-widths` (champs
  dans Paramètres) réécrits. `check.sh` : 161 API, 318 front, 38 desktop unitaires, 25 scripts,
  7 relais, 38 navigateur, 9 desktop e2e (+1 ignoré sans gestionnaire de fenêtres).

## Lot du 2026-09-23 (2) — IA dans l'éditeur de procédures

- Demande : « Mise en page / correction » et « Suggérer une procédure » sur les procédures.
  Les boutons IA n'existaient que pour les entrées Markdown ; une procédure est riche.
- **✨ Suggérer une procédure** (à la place de « Suggérer des sous-tâches » sur une procédure) :
  titre, projet, noms des pièces jointes et contenu partent au service IA des Paramètres ; la
  proposition (objectif, prérequis, étapes numérotées, vérifications ; « à préciser » plutôt
  qu'une valeur inventée) se relit dans « Procédure proposée » avant « Appliquer la procédure ».
- **✨ Mettre en page** sur une procédure riche : même relecture que pour le Markdown, consigne
  adaptée (étapes en liste numérotée).
- Pont Markdown ⇄ document riche (`web/src/rich-markdown.ts`) : schéma partagé avec l'éditeur
  (`rich-extensions.ts`), `validateDocument` du serveur avant application, liens et images hors
  règles retirés. Surlignage, couleurs et alignements remis à plat (dit dans la proposition).
  Documents Google exclus. Aucune dépendance. Décision §23.
- Tests : conversion (6, `rich-markdown.test.ts`), IA (5, `ai-suggest.test.ts`), gestes (4,
  `App.test.tsx` : suggérer puis appliquer, mise en page riche, contenu modifié pendant l'appel,
  procédure Google sans IA), navigateur (1, `e2e/procedures.spec.ts` : suggestion appliquée,
  relue après rechargement, dans Chromium avec service IA simulé). Chaque garde-fou retiré fait
  échouer au moins un test (mutation). `check.sh` : 161 API, 309 front, 38 desktop unitaires,
  25 scripts, 7 relais, 38 navigateur, 9 desktop e2e (+1 ignoré sans gestionnaire de fenêtres).
- Non vérifié avec un vrai modèle : la qualité des procédures proposées dépend du service IA
  des Paramètres (Gemini par défaut) ; les tests simulent sa réponse.
- **Piège jsdom** : un bouton de la barre de l'éditeur riche (`focus()` puis défilement) lève
  `getClientRects is not a function` hors du test (erreur non gérée, run rouge) ; pour modifier
  un document riche dans un test, passer par « Rechercher et remplacer », qui ne défile pas.

## Lot du 2026-09-23 — connexion Google de la PWA réparée (relais de jetons)

- **Bug** : « Se connecter avec Google » échouait sur la PWA depuis la v0.35.0 (`0030b79`),
  sans message : au retour de Google, « Non connecté », ou « Reprendre la session Google »
  à chaque essai.
- **Mesure** (PWA en ligne v0.36.1, client intégré) : l'autorisation passe ; l'échange du
  code sans secret répond `400 invalid_request — client_secret is missing` (faux secret :
  `401 invalid_client`). Google exige le secret d'un client « Web », même avec PKCE ; déjà vu
  le 17/09 (`22f4cd4`), §19 affirmait l'inverse.
- **Diagnostic du lot (5) corrigé** : la course « code échangé deux fois » ne se produit pas
  au retour de Google (le panneau Drive n'est monté qu'avec les Paramètres ouverts). Le verrou
  `consumeRedirectCallback` reste utile (double effet du mode strict en dev) ; commentaire rectifié.
- **Correctif** :
  - `oauth-proxy/` : relais Cloudflare Worker (secret chez Cloudflare, deux échanges, origine et
    retour de la PWA seuls). Vérifié dans `workerd` local : relais → Google → réponse avec CORS.
  - PWA : client intégré → relais (`VITE_GOOGLE_TOKEN_PROXY` ← variable `GOOGLE_TOKEN_PROXY_URL`,
    `pwa.yml`) ; sans relais ni secret → flux « jeton » d'une heure ; client personnel inchangé ;
    relais injoignable → « Google injoignable ».
  - L'échec du retour Google s'affiche dans la bannière d'erreur (`startWebSync(…, onLoginError)`,
    état à part pour survivre au `reload`).
- **Tests** : relais (7, `oauth-proxy/worker.test.mjs`, ajoutés à `check.sh`), PWA (4 dans
  `store/google-web.test.ts`, 1 refait dans `GoogleDriveWeb.test.tsx`), app PWA (1,
  `App.local.test.tsx`). Chaque retour arrière du correctif fait échouer au moins un test
  (vérifié par mutation). `check.sh` : 161 API, 294 front, 38 desktop unitaires, 25 scripts,
  7 relais, 37 navigateur, 9 desktop e2e (+1 ignoré sans gestionnaire de fenêtres).
- **Piège de recette** : lancer `check.sh` sous Xvfb depuis une session graphique en gardant
  `XDG_CURRENT_DESKTOP` fait échouer « démarre en fenêtre maximisée » (aucun WM sous Xvfb,
  mais le test croit en avoir un). Même échec sur `master` ; retirer aussi `XDG_CURRENT_DESKTOP`,
  `DESKTOP_SESSION` et `GDMSESSION` pour reproduire la CI.
- **À faire par Timo** (sinon la PWA reste en flux « jeton », fonctionnel mais d'une heure) :
  compte Cloudflare, `npx wrangler deploy` puis `secret put` dans `oauth-proxy/`, variable
  `GOOGLE_TOKEN_PROXY_URL`, relancer le workflow PWA. Détail : `08-GOOGLE-DOCS.md`
  « Relais de jetons ». Décision §22.
- **Non vérifié en réel** tant que le relais n'est pas déployé avec le vrai secret : la
  connexion complète sur le téléphone reste à constater.
- **Connu, non traité** : dans `GoogleDriveWeb.test.tsx`, le verrou `consumeRedirectCallback`
  (module importé statiquement, `resetModules` sans effet) rend le 2e test de retour OAuth
  dépendant du 1er : il ne refait pas l'échange.

## Lot du 2026-09-22 (5) — reprise de session Google en vol unique (PWA)

- **Bug** : « Reprendre la session Google » échouait à chaque fois sur la PWA mobile.
  Le retour Google (`?code=…`, code + `pending` à usage unique) était consommé en
  parallèle par `startWebSync` (`sync-web.ts`) et le panneau Drive (`GoogleDriveWeb.tsx`) :
  le second échangeait un code déjà brûlé (`invalid_grant`), et cet échec effaçait
  (`writeTokens(null)`) la session que le premier venait d'enregistrer.
- Correctif : `consumeRedirectCallback()` (`store/google-web.ts`) — un seul échange par
  chargement, même promesse partagée aux deux appelants. `handleRedirectCallback` gardé
  pour les tests. Aucune dépendance ajoutée.
- Tests : front (1, `store/google-web.test.ts` — deux appels parallèles, un seul `/token`,
  session connectée et non expirée).
- **Parcours réduit** : la reprise avec compte connu (`login_hint`) demande `prompt=consent`
  seul, sans repasser par le sélecteur — un seul « Continuer », et Google réémet un
  `refresh_token` qui rend la session à nouveau silencieuse. Première connexion (compte
  inconnu) et changement de compte inchangés.

## Correctif du 2026-09-24 (4) — IA des procédures toujours « surchargée »

- Chaîne de secours Gemini (`GEMINI_FALLBACK_MODELS`, `ai-suggest.ts`) au lieu d'un
  secours unique lui aussi saturé ; mémoire de 10 min du secours qui a répondu ;
  sous-tâches à 1 024 jetons. Mesures et règles : `05-DECISIONS.md` §17.
- Défaut `gemini-3-flash-preview` (le plus fiable en gratuit), `2.5-flash` ajouté au select ;
  l'ancien défaut exact enregistré est relu comme le nouveau.
- Tests : chaîne (saturé/lent/404/429/vide), budget borné, arrêt net, mémoire, migration.

## Lot du 2026-09-24 (3) — aperçu des .docx, « Ouvrir avec… » réparé

- Aperçu Word natif (`docx-preview.ts` + `DocxView.tsx`, kind `docx`), sans dépendance :
  détail et limites dans `05-DECISIONS.md` §15. Fixture réelle produite par LibreOffice :
  `web/src/__fixtures__/procedure.docx`.
- Desktop : « Ouvrir avec… » ne répondait plus (« reply was never sent ») — `xdg-open`
  lancé détaché (`desktop/open-file.mjs` › `launchDetached`). Les parcours desktop
  remplacent `xdg-open` par `WORKLOGS_OPEN_COMMAND` (un script qui reste ouvert 3 s).
- Tests : lecteur (3), classement (1), interface (1), navigateur (1), lancement (2 + desktop).
- Travail fait dans un worktree (`../work-logs-docx`) : d'autres sessions tournent sur le
  même dépôt.

## Lot du 2026-09-24 (2) — colonne Procédures redimensionnable

- Poignée sur le bord gauche des Procédures (`ColumnResizer` généralisé : `area`, `label`,
  `min`/`max`), posée dans la même case de grille que la colonne : aucune des dix variantes
  de `grid-template-areas` n'a changé, seule leur largeur passe à `var(--col-procedures)`.
- 260–600 px (en dessous, les boutons d'une procédure ne tiennent plus), défaut 320,
  `localStorage worklogs-col-procedures`, champ « Procédures » dans Paramètres › Affichage,
  remis à 320 par « Largeurs par défaut ». Masquée sur mobile et quand la colonne est seule.
- Test : `e2e/sidebar-widths.spec.ts` (glisser, clavier, limites, Paramètres, rechargement).

## Correctif du 2026-09-24 — « document riche invalide » en tapant « 0. »

- Taper `0. ` (ou un numéro > 10 000) en début de ligne : Tiptap crée une liste numérotée
  `start: 0` ; `validateDocument` n'acceptait que 1–10 000 → **tout** le document refusé,
  plus rien ne s'enregistrait. `start` accepte désormais tout entier sûr ≥ 0 ; l'éditeur
  ramène à 1 un début hors des entiers sûrs (`normalizeDocument`, `RichEditor` → onUpdate).
- Export Google : `start || 1` traitait 0 comme 1 (liste exportée à 1 en silence) ; 0 est
  maintenant signalé « nécessite Google Docs » comme tout départ ≠ 1.
- Sonde navigateur : 48 saisies (Markdown, listes, Tab/Entrée, liens, émoji, contrôles)
  dans une note et une procédure ; seuls `0.`/`00.`/`10001.` échouaient.
- Tests : API (3), navigateur (1, `e2e/rich-document.spec.ts`).

## Lot du 2026-09-22 (4) — supprimer les pièces jointes partout

- ✕ dans la colonne Procédures (`ProcedureList.tsx`) ; l'éditeur l'avait déjà, mais la
  barre de fichiers était masquée pour un document Google ouvert en natif : elle s'affiche
  désormais dès qu'il y a une pièce jointe. Erreur de suppression affichée (avant : rejet muet).
- `DELETE /api/attachments/:id` (et `localApi.deleteAttachment`) met l'exemplaire Drive à la
  corbeille, best-effort, sauf s'il est partagé par une autre fiche (copie locale d'entrée).
  Réponse : `{ ok, driveTrashed }`. La pierre tombale propage la suppression aux appareils.
- Tests : API (4, `api/test/attachment-delete.test.js`), PWA (1), éditeur (3), Procédures (1).

## Lot du 2026-09-22 (3) — pièces jointes des procédures retéléchargeables, rangées sur Drive

- **Bug** : « Fichier non disponible sur le site » en cliquant un fichier de procédure (PWA).
  Un lien `<a download>` part au gestionnaire de téléchargements du navigateur, qui
  **contourne le service worker** : la requête tombait sur GitHub Pages (404). Même défaut
  sur « Télécharger » de l'aperçu. Correctif : `web/src/attachment-download.ts` —
  `fetch` (service worker / protocole desktop) puis enregistrement d'un blob ; binaire
  absent mais sur Drive → rapatrié d'abord (`fetchDriveAttachment`) ; sinon message clair.
  Utilisé par la colonne Procédures, l'aperçu et les fichiers de l'éditeur.
- **Rangement Drive** : binaires dans `WorkLogs/Pièces jointes` (dossiers retrouvés par
  `appProperties.worklogs_type`, créés au besoin, racine en repli), desktop comme PWA.
  La synchro envoie tout binaire local sans `driveFileId` (plus seulement la boîte d'envoi,
  vidée à chaque passage). Hors connexion : le fichier reste local, badge « local seul ».
- Tests : téléchargement (3), dossier desktop (1), dossier PWA (1).

## Lot du 2026-09-22 (2) — menu du compte, Documents Google, synchro automatique

- **Menu du compte** (`AccountMenu.tsx`) à la place du bouton ⚙ Paramètres : avatar Google
  (`picture` de userinfo, repli initiale), état de synchro, Documents Google, Synchroniser
  maintenant, Paramètres, Changer de compte (`prompt=select_account`), Se déconnecter.
  Statut Google tenu par `App` (PWA : `localApi.googleStatus` renvoie désormais l'état réel).
- **Documents Google** (`GoogleDocuments.tsx`), sortis du dialogue Drive : ouvrir, projet
  (`POST /api/google/documents/:id/project`, toutes les copies-onglets), corbeille Drive
  (`POST /api/google/documents/:id/trash`), créer. Même API côté PWA.
- **Synchro auto par fusion** (décision §20) : `api/src/sync-merge.js` (partagé),
  `api/src/google-sync.js` (desktop, `autoSync` seulement dans l'app), `web/src/store/sync-web.ts`
  (PWA). Pierres tombales : table `sync_tombstones` / `localStorage worklogs-sync-deleted`.
  Projets : colonne `updated_at` (migration additive). « Sauvegarder » = synchroniser.
  La connexion PWA est traitée au démarrage (plus besoin d'ouvrir le panneau Drive).
- Tests : fusion (11), moteur desktop (3), moteur PWA (4), menu (8), documents (5 + API).
- **Incident poste** : disque plein à répétition pendant le lot (hors WorkLogs : journaux
  Symfony `dev.log` d'autres projets en écriture). Deux fichiers vidés par l'échec d'écriture,
  reconstruits depuis git + le travail en cours ; aucune perte.

## Lot du 2026-09-22 — « Se connecter avec Google » en un clic (facultatif)

- Desktop : client OAuth intégré (`readDefaultClient`, `google-default.json` écrit par
  `stage-desktop.mjs` depuis les secrets CI), client personnel prioritaire, route
  `POST /api/google/use-builtin` pour y revenir. Scopes `+ openid email profile`,
  compte (`userinfo`) stocké chiffré et exposé dans `status().account`.
- PWA : `VITE_GOOGLE_CLIENT_ID`, flux code + PKCE sans secret, `refresh_token` conservé
  pour le renouvellement silencieux ; les anciens retours « jeton » restent acceptés,
  mais une session sans renouvellement tombe sur `GOOGLE_REAUTH` → « Reprendre la session Google ».
- UI : bouton principal « Se connecter avec Google », « Connecté : Nom · e-mail »,
  repli « Utiliser mon propre client OAuth », « Se déconnecter de Google ».
- **À faire hors code** (sinon rien ne change pour l'utilisateur) : scopes + passage en
  production dans Google Cloud, secrets/variable GitHub — détail
  `docs/08-GOOGLE-DOCS.md` « Connexion en un clic ». Décision §19.
- Non vérifié en réel : aucun vrai client OAuth dans cette session (réponses simulées).

## Lot du 2026-09-21 (2) — Procédures hors du journal, sidebar dépliée

- Demande : les procédures ne doivent pas être dans la sidebar des entrées.
  Le journal (`EntryList`) ne reçoit plus que les notes ; une procédure
  archivée reste dans ses archives pour être restaurable (la sidebar
  Procédures n'affiche que les actives).
- La sidebar Procédures n'est plus un `<details>` replié à déplier : panneau
  toujours ouvert (`section` « Procédures du projet », titre + compteur +
  projet), masquable par son bouton d'en-tête comme Journal/Tâches.
- Tests : journal sans procédure (front + e2e). Contenu désormais monté même
  masqué → sélecteurs `Joindre un fichier` passés en `exact` (e2e web et
  desktop). `check.sh` vert.
- **Piège trouvé par la CI de la 0.31.0** : au premier chargement, l'app ouvrait
  `entries[0]`, procédures comprises. Après `procedures.spec`, c'était la
  procédure riche « Envoi direct » : son « Contenu du document » satisfaisait
  le `beforeEach` de `rich-document.spec`, qui tapait alors dans la procédure
  (échecs aléatoires, reproduits en trace). L'ouverture par défaut prend
  désormais la première entrée non-procédure (test front dédié).

## Lot du 2026-09-21 — « ✨ Mettre en page » : correction IA d'une entrée Markdown

- Bouton à côté de « ✨ Suggérer des sous-tâches » (entrées Markdown seules,
  documents riches exclus). Un clic = un appel au service IA des Paramètres,
  avec profil, titre et texte entier (plafond `MAX_PROOFREAD_CHARS` = 12 000).
- **Jamais d'écrasement aveugle** : la version corrigée s'affiche dans
  « Mise en page proposée » ; « Appliquer » remplace le texte, « Ignorer » le
  laisse. Si le texte a changé pendant l'appel, Appliquer refuse et demande
  de relancer (sinon les frappes seraient perdues).
- `ai-suggest.ts` : transport commun `postChatCompletions` (suggestions et
  mise en page), messages d'erreur inchangés. Tests unitaires + deux parcours
  dans `App.test.tsx`. Aucune dépendance. `check.sh` vert (233 tests front).

## Lot du 2026-09-19 (7) — Suggérer remplace, fini le bouton Régénérer

- Correctif UX post-0.29.0 (qui embarquait un « ↻ Régénérer » séparé) :
  **« ✨ Suggérer » remplace toujours** — le contenu de la zone dans le
  créateur, le bloc suivi dans l'éditeur. « Effacer » (créateur) et « Retirer »
  (éditeur) gardent la suppression, qui fonctionnait bien.
- Suppressions : bouton Régénérer des deux écrans, paramètre `replace`
  devenu inutile. Titres des boutons Suggérer précisant le remplacement.
- Tests adaptés (remplacement constaté aux deux endroits, suppression
  inchangée). Aucune dépendance.

## Lot du 2026-09-19 (6) — projets sortis de la sidebar : bandeau global

- Demande : la gestion des projets vivait en haut du journal et disparaissait
  avec lui. `ProjectBar` déménage dans un bandeau `.project-strip` sous
  l'en-tête : filtre + « Gérer les projets » accessibles même panneaux
  repliés, sur mobile comme sur desktop. Ni onglet ni menu : le même
  composant, juste replacé (§1 des décisions).
- Mise en page : pastilles en défilement horizontal (plus de wrap qui pousse),
  résumé « Gérer » à droite ; dépliant ouvert = rangée pleine largeur
  suivante. Mobile : bandeau compact, pastilles tactiles conservées.
  `no-print` comme l'en-tête. Texte d'amorçage corrigé (« filtre à gauche »
  → bandeau), côté API et PWA locale.
- Tests : front (bandeau hors `#workspace-journal`, filtre utilisable journal
  replié), e2e 412 px (bandeau sous l'en-tête, sans débordement, filtre
  utilisable journal replié). Captures desktop + mobile contrôlées.
  Aucune dépendance ajoutée.

## Lot du 2026-09-19 (5) — régénérer ou retirer une suggestion IA

- Problème réel : une suggestion générée ne pouvait ni être rechargée
  (Suggérer empilait des doublons) ni supprimée (édition manuelle seule).
- Créateur : « ✨ Suggérer » ajoute toujours, « ↻ Régénérer » remplace tout le
  contenu par une proposition fraîche, « Effacer » vide la zone. Les deux
  n'apparaissent que quand la zone est remplie (noms `Régénérer/Effacer la
  suggestion`, distincts du « Effacer » du lieur de documents).
- Éditeur : le bloc inséré est suivi tel quel (`suggestedBlock`) — « ↻
  Régénérer » le remplace en place, « Retirer » le supprime sans toucher au
  reste ; si l'utilisateur l'a modifié entre-temps, la régénération ajoute
  plutôt qu'écraser. Les boutons disparaissent avec le bloc.
- Tests : régénération/remplacement + effacement dans le créateur (1),
  remplacement en place + retrait propre dans l'éditeur (1). Aucune dépendance.

## Lot du 2026-09-19 (4) — l'IA lit l'entrée : texte, cases, pièces jointes, liens

- Demande : suggestions aveugles au contenu déjà présent. Le prompt reçoit
  désormais l'entrée elle-même : extrait du texte (plafonné 1500 car),
  sous-tâches existantes avec statut (`parseChecklist`, consigne « ne les
  repropose jamais »), noms des pièces jointes, tâches déjà liées ; côté
  créateur, documents déjà liés à la tâche.
- Câblage : `EntryEditor` reçoit `linkedTasks` d'App (tâches non terminées,
  prop optionnelle), lit ses `attachments` et son brouillon ; `TaskBoard`
  ajoute les documents liés ; plafonds via `compactTitles`, texte via
  `truncate`. Mentions vie privée alignées (Paramètres + titres des boutons).
- Tests : `parseChecklist`/`truncate`/sections (3), éditeur prouvant texte +
  case + PJ + tâche liée dans la requête (étendu). Leçon outillage (ter) :
  bannir les `oldString` finissant par `});`.
- Limite assumée : seuls les NOMS des pièces jointes partent, jamais leur
  contenu (lire un PDF/une image coûterait un envoi lourd et flou).

## Lot du 2026-09-19 (3) — l'IA connaît le métier : profil + vocabulaire auto-appris

- Demande : suggestions génériques, l'IA ignorait l'app et le travail (dev solo
  en pisciculture). Deux mémoires, aucune inscription, aucun serveur à nous :
  un **profil** écrit une fois en Paramètres (« Mon contexte de travail »,
  joint à chaque appel) et un **vocabulaire auto-appris** des titres existants
  (fréquence puis alpha, mots vides et courts écartés, plafond 8).
- `recurringVocabulary()` pur et testé ; `taskSuggestContext()` ajoute le
  vocabulaire calculé sur tous les projets (les voisines/notes restent
  cadrées projet) ; consigne système : WorkLogs, anti-doublons, vocabulaire
  métier. Créateur : contexte complet ; éditeur : nom du projet + profil.
- Mentions vie privée alignées (Paramètres + titres des boutons) : titre,
  profil et contexte au clic seul. `suggestSubtasks(settings, title, options)`.
- Avenant lot précédent : `.env.local` polluait `npm test` — `VITE_DEFAULT_*`
  ignorés quand `MODE === 'test'`.
- Tests : vocabulaire (2), prompt profil/vocabulaire (1), fusion du profil dans
  l'appel (1), `taskSuggestContext` étendus (2), créateur prouvant profil +
  vocabulaire dans la requête (étendu), champ profil persistant (étendu).
- Leçon outillage (bis) : bannir les `oldString` qui se terminent par `});` —
  deux réparations dans ce lot ; ancrer sur des noms, relire après chaque edit.

## Lot du 2026-09-19 (2) — prompt IA conscient de l'app et du travail en cours

- Demande : l'IA répondait générique. Le prompt connaît désormais WorkLogs
  (journal dev local, notes Markdown + tâches) et reçoit le contexte :
  nom du projet, tâches voisines en cours (hors terminées et hors elle-même),
  notes récentes du projet — avec consigne anti-doublons et vocabulaire dev.
- `taskSuggestContext()` pur et testé (filtrage, sans-projet, déduplication et
  plafond via `compactTitles`, titres rognés à 80 car). Créateur carte :
  contexte complet ; éditeur : nom du projet (seule donnée sous la main).
- Mentions vie privée alignées (Paramètres + titres des boutons) : titre ET
  contexte envoyés, toujours au clic seul. `suggestSubtasks` prend
  `{ context, timeoutMs }` en options.
- Avenant au lot précédent, découvert en baseline : `web/.env.local` (clé de
  test) polluait `npm test` via Vite — `readAiSettings` ignore désormais les
  `VITE_DEFAULT_*` quand `MODE === 'test'`. Tests déterministes avec ou sans
  fichier local.
- Tests : prompt contextuel (2), `taskSuggestContext` (2), envoi du contexte
  dans le corps (1), créateur prouvant projet + voisine + note dans la requête
  (étendu). Leçon outillage : ancrer les edits sur des noms de tests, jamais
  sur des `});` — deux structures cassées puis réparées dans ce lot.

## Lot du 2026-09-19 — suggestions de sous-tâches par IA (clé AI Studio gratuite)

- Demande : depuis une tâche, obtenir des sous-tâches « concises mais précises
  et pertinentes ». Test réel concluant avant implémentation : clé AI Studio
  gratuite + `gemini-3.5-flash-lite` via l'endpoint OpenAI-compatible de Google,
  4 lignes FR pour 81 tokens.
- Un seul client générique (`web/src/ai-suggest.ts`, `fetch` natif, sans
  dépendance) : `POST {endpoint}/chat/completions` en Bearer, timeout 30 s,
  erreurs en français (clé refusée, limite 429, hors-ligne, réponse illisible),
  jamais d'envoi automatique — un clic = un envoi du titre seul.
- ⚙ Paramètres, section « IA » : endpoint (défaut l'URL OpenAI de Google),
  modèle en select (3 options testées en direct le 2026-09-24 avec la clé du
  demandeur, « OK » reçu : `gemini-3.5-flash-lite` (défaut), `gemini-3.5-flash`,
  `gemini-3.1-flash-lite`, ce dernier servant aussi de secours automatique sur
  5xx/délai ; `gemini-2.5-flash-lite` — défaut et secours de la 0.37.1 — exclu
  car Google le refuse en 404 aux nouvelles clés « no longer available » —
  clé essayée puis écartée du dépôt) + « Personnalisé… », bouton « Tester le
  modèle » gardé en diagnostic (budget 300 jetons : `gemini-3.5-flash` y
  consomme sa réflexion avant de répondre), motif du fournisseur affiché en
  cas d'échec (une 404 vient du modèle/endpoint, pas de la clé), clé en champ
  password sur l'appareil, bouton « Valeurs Gemini gratuites ». Sans clé, les
  boutons Suggérer expliquent au lieu d'appeler. Réglages par appareil : PWA
  et desktop ont chacun leur localStorage, à régler des deux côtés.
- Boutons « ✨ Suggérer » : créateur d'entrée liée (remplit la zone, modifiable
  avant création) et éditeur Markdown (ajoute le bloc en fin de contenu) ;
  documents riches exclus en v1 (pas de cases). Le parse réutilise `subtasksMd`,
  étendu aux numéros `1.`/`1)`.
- **Clé de test du demandeur essayée en direct puis écartée du dépôt**
  (public : quota pillé + révocation). Par défaut locale non versionnée
  (`VITE_DEFAULT_AI_KEY` via `web/.env.local`, `.gitignore` complété) ; en prod,
  collage unique dans Paramètres.
- Tests : `ai-suggest.test.ts` (9, fetch mocké), `subtasksMd` numérotée (1),
  flux front (4 : créateur, sans-clé sans appel réseau, éditeur, réglages).
  Pièges notés : `user.type` avale `[x]` (déjà connu) et `findByDisplayValue`
  trop juste en timing — `waitFor` + `toHaveValue` comme le reste du fichier ;
  `getByRole(name: 'Tâches')` matche désormais aussi « ✨ Suggérer des
  sous-tâches » — toggles verrouillés en `exact: true` dans les e2e.
- Pourquoi BYOK + endpoint unique : `05-DECISIONS.md` §17.

## Lot du 2026-09-18 (4) — créer une entrée liée depuis une tâche, avec sous-tâches

- Miroir de « Créer une tâche liée » : `POST /api/tasks/:id/entry` crée une
  entrée (titre repris, projet repris, datée du jour) et la lie atomiquement à
  la tâche ; tâche terminée → document archivé comme à la liaison manuelle.
  Mêmes erreurs en français (`tâche introuvable`, `titre requis`).
- La carte gagne « ＋ Créer une entrée liée » : titre prérempli + zone
  « Sous-tâches, une par ligne », chaque ligne devenant `- [ ]` (un `- [x]`
  collé garde son statut, lignes vides ignorées, `subtasksMd` pur et testé).
  « Créer et ouvrir » recharge et ouvre l'entrée aussitôt. Mêmes classes
  `.task-creator` que l'autre sens, aucun style ad hoc.
- Miroir PWA (`localApi.createEntryFromTask`, contrat `Api` imposé par le
  typecheck). Piège noté : `user.type` avale les séquences `[x]` (syntaxe
  clavier user-event) — le test du statut coché passe par `fireEvent.change`.
- Tests : API (2), `subtasksMd` (4), PWA locale (1), flux complet front (1).
  Aucune dépendance ajoutée.

## Lot du 2026-09-18 (3) — version en Paramètres mobile et blocs en cartes

- La pastille de version de l'en-tête étant masquée sur mobile, le dialogue
  ⚙ Paramètres affiche désormais `WorkLogs x.y.z` en pied (visible en mobile
  seul, redondant en desktop où la pastille reste).
- L'empilement mobile (≤ 900 px) passe en trois cartes distinctes au lieu d'un
  long continu à filets : fond, bordure, rayon 14 px, marges, et intitulés
  JOURNAL / ÉCRITURE / TÂCHES qui répondent aux boutons de l'en-tête. Aucun JSX
  de navigation ajouté, que du CSS (+ une ligne dans le dialogue).
- Tests : version présente dans le dialogue (`App.test.tsx`), visible à 412 px
  et masquée en desktop, cartes à 14 px avec intitulés (`mobile-header.spec.ts`,
  `rich-document.spec.ts`). Capture de contrôle : deux cartes identifiées,
  header à quatre icônes. Aucune dépendance ajoutée.

## Lot du 2026-09-18 (2) — en-tête mobile aéré (rebasé sur v0.23.0)

- Parti de v0.19.0, rebasé sans conflit sur v0.23.0 qui ajoutait entre-temps un
  troisième panneau (Écriture repliable) et un bouton ⚙ Paramètres : la grille
  mobile passe à quatre colonnes en première ligne et trois boutons de panneaux.
- Sur ~412 px (Pixel 9a), l'en-tête entassait logo, pastille version, recherche,
  thème, panneaux, Exporter et Paramètres sur deux lignes serrées. Il passe en
  grille de trois lignes : marque + thème + export (icône ⤓) + paramètres (icône ⚙)
  / recherche pleine largeur 44 px / Journal, Écriture et Tâches en trois grands
  boutons côte à côte.
- Pastille version masquée en mobile (elle ne sert qu'en desktop) ; Exporter et
  Paramètres deviennent des icônes à `aria-label` stable (noms exacts conservés :
  `Exporter`, `⚙ Paramètres`) ; recherche en 16 px (pas de zoom auto au focus) ;
  `safe-area` haut/bas pour la PWA ; chips, saisie rapide et lignes du journal en
  cibles tactiles. Desktop inchangé à l'exception de deux icônes masquées.
- Tests : noms accessibles de la bannière (`App.test.tsx`, Écriture et Paramètres
  inclus), disposition à 412×860 sans débordement, trois panneaux à parts égales,
  cibles ≥ 40 px, repli du journal (`mobile-header.spec.ts`). Capture de contrôle :
  trois lignes aérées, contenu intact.
- Pourquoi pas de menu hamburger pour l'en-tête : `05-DECISIONS.md` §16.

## Lot du 2026-09-18 — aperçu des pièces jointes dans l'app

- `GET /api/files/:stored/preview` : mêmes octets que le téléchargement, mais
  `Content-Disposition: inline` et le type MIME enregistré à l'envoi. La route
  `/api/files/:stored` n'a pas bougé — le nom RFC 6266 et le téléchargement desktop
  continuent de fonctionner. La recherche de la pièce jointe est partagée
  (`findAttachment`) ; `path.basename` empêche toujours toute traversée de répertoire.
- `web/src/file-preview.ts` classe la pièce jointe sur l'extension **et** le type MIME :
  `image`, `pdf`, `text`, `sheet`, `other`. `FileViewer.tsx` rend images, PDF (`<iframe>`)
  et texte (récupéré puis affiché dans un `<pre>`) ; les tableurs sont annoncés comme non
  affichables — décoder `.xlsx`/`.ods` demanderait une dépendance (accord explicite requis)
  et un rendu qu'on ne peut garantir fidèle. Le `.csv` reste du texte et s'affiche tel quel.
- `EntryEditor.tsx` gagne un bouton **👁 Aperçu** par pièce jointe ; le lien de
  téléchargement et la suppression restent en place. Dialogue au premier plan
  (`showModal`), comme « Gérer Google Drive ».
- Service worker PWA : `serveLocalFile` distingue `/preview` (disposition `inline`) du
  téléchargement ; au passage, la lecture du nom `stored` ne prend plus `preview` pour le
  nom du fichier.
- Aucune dépendance ajoutée. Tests : API (4 nouveaux dans `api/test/files.test.js`), front
  (`file-preview.test.ts`, 2 dans `App.test.tsx`, `previewUrl` dans `localApi.test.ts`),
  scripts (`pwa-sw.test.mjs`), e2e (1 dans `worklogs.spec.ts`). Le helper `upload` de
  `web/src/test/server.ts` construit son multipart à la main : en jsdom, `FormData` du DOM
  n'est pas encodable par le `fetch` de Node, multer ne voyait alors aucun fichier.
- Pourquoi cette route additive, et pourquoi « annoncer plutôt que rendre » :
  `05-DECISIONS.md` §15.

## Lot du 2026-09-17 — plusieurs documents par tâche et cartes repensées

- **＋ Lier des documents** remplace le sélecteur unique : cases à cocher avec pastille
  `local`/`Google`, recherche instantanée, `Tout sélectionner`/`Effacer`, compteur de
  sélection et **Relier la sélection (n)** en un seul rechargement. Aucun nouvel endpoint
  (les `POST /api/tasks/:id/documents/:entryId` existants sont groupés), aucune dépendance.
- Chaque document lié affiche son origine **et** sa date (`local · aujourd'hui`), son icône
  (📄/G) et un accès direct au centre ; la carte porte un compteur `📎 n` et une méta
  d'échéance en pastille (📅, rouge si en retard). Mise en page verticale : entête
  (case 19 px + titre + actions 28 px), méta, documents en tuiles.
- Rebasé sans conflit sur la v0.15.1 distante (fix multipart Drive CRLF conservé) après
  `check.sh` vert ; fonctionnalité mergée sur master avant le bump.
- Version **0.16.0** : bump manifeste/lockfile synchronisé et publiée via `CI Linux`
  (`35205133501`), `Release Linux` (`35205842162`), `Dépôts` (`35205936323`) et GitHub Pages
  (`35206234611`). Assets : DEB/RPM/AppImage, SHA256 et attestation.

## Lot du 2026-09-17 — tâches liées et sauvegarde JSON Google Drive

- L’éditeur d’une entrée locale ou d’un onglet Google propose **Créer une tâche liée** : titre
  prérempli, échéance facultative, tâche `todo` dans le projet de l’entrée et association créée
  atomiquement. La carte affiche immédiatement le document de contexte et son origine.
- Le dialogue Google est rendu dans le `body` et ouvert dans le top layer natif : il ne passe plus
  sous la grille. Il contient une section **Sauvegardes WorkLogs** séparée de la gestion des documents.
- `/api/google/backup/*` stocke un vrai fichier JSON Drive versionné avec `appProperties`, liste les
  sauvegardes et restaure projets, entrées riches, tâches, `task_entries` et liens `google_documents`
  dans une transaction après validation. L’export conserve les métadonnées de pièces jointes, pas
  les octets des fichiers locaux ; `scripts/backup.sh` reste requis pour une migration complète.
- Le client desktop autorise uniquement `/upload/drive/v3/` en plus des API existantes et gère les
  réponses texte pour les téléchargements. Aucun faux `userAgent`, aucune dépendance ajoutée.
- Version **0.15.0** : bump manifeste/lockfile synchronisé et publiée via `CI Linux`
  (`35196706807`), `Release Linux` (`35197256929`), `Dépôts` (`35197381827`) et GitHub Pages
  (`35197714781`). Assets : DEB/RPM/AppImage, SHA256 et attestation.

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
