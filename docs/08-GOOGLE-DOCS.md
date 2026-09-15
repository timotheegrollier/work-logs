# Google Docs — éditeur natif dans WorkLogs, bilan du 2026-09-15

**Branche `codex/google-docs-integrated-editor`, sur les sources 0.10.0, sans bump ni release.**
Aucune dépendance ajoutée. Ce bilan remplace les limites de la section suivante.

## Ce qui change

- Ouvrir un document Google lié affiche **le vrai éditeur Google Docs dans la colonne
  centrale** : menus, tableaux, images, menus déroulants, suggestions et commentaires
  sont ceux de Google. Le journal à gauche et les tâches à droite restent WorkLogs.
  Toujours un seul écran, ni onglet ni routeur ; l’application ne change pas de forme.
- « Copie locale » quitte l’éditeur Google, réimporte le document et actualise au passage
  les onglets restés intacts. Un brouillon local modifié est conservé tel quel.
- Un brouillon local en attente est envoyé avant d’ouvrir l’éditeur complet. Si l’envoi
  échoue, l’éditeur ne s’ouvre pas et le brouillon reste affiché.
- `api/src/google-merge.js` réconcilie une correction locale et une correction distante
  **indépendantes** au lieu de refuser l’envoi. Deux modifications du même passage — ou
  un paragraphe ajouté des deux côtés — restent un conflit explicite, brouillon conservé.
- Impression : `Ctrl+P` et le bouton *Imprimer* passent la main à Google quand son éditeur
  est affiché ; c’est Google qui prépare le document complet.
- Fermer la fenêtre, changer de document ou demander la copie locale respectent
  l’avertissement « modifications en cours » de Google avant de quitter.
- Un document Google affiché est une application complète qui continue de tourner :
  ouvrir le suivant libère le précédent, sauf s’il est encore en train d’enregistrer.

## Comment c’est isolé

La page Google est une `WebContentsView` de premier niveau — pas une `iframe`, pas une
`webview`, pas une seconde fenêtre. Elle tient dans sa propre session
`persist:google-docs`, **sans preload**, `sandbox`, `contextIsolation` et `webSecurity`
actifs, sans Node : `window.worklogsDesktop` et `require` y sont indéfinis, et un parcours
Electron l’ancre. Le renderer WorkLogs ne reçoit jamais de jeton Google.

| Contrôle | Comportement |
|---|---|
| Navigation | HTTPS seulement, sur `docs`, `accounts`, `drive`, `myaccount`.google.com ; ni port, ni identifiants dans l’URL |
| Autre document Google, lien externe, `file:`, fenêtre surgissante | Refusés avec un message dans la barre de l’éditeur |
| `/o/oauth2…` | **Jamais** dans la vue : l’autorisation des API garde le navigateur système ([politique Google](https://developers.google.com/identity/protocols/oauth2/policies)) |
| Permissions (presse-papiers, micro/caméra) | Refusées par défaut ; une demande explicite passe par un dialogue WorkLogs |
| Téléchargements | Dialogue « Enregistrer sous » natif, dossier Téléchargements par défaut |

`googleViewUrl`, `allowedGoogleNavigation` et `viewBounds` sont testés directement dans
`desktop/test/google-view.test.mjs` ; les parcours `desktop/e2e/desktop.spec.ts` couvrent
l’isolation, les dimensions suivies au pixel, l’impression et le refus de quitter.

## Limites connues — à ne pas présenter autrement

| Point | État |
|---|---|
| Navigation entre onglets pendant l’édition Google | Celle de Google ; la navigation verticale WorkLogs revient avec la copie locale |
| Documents ouverts dans la session | Une seule vue Google vivante : ouvrir le document suivant libère le précédent. Une vue que Google déclare en cours d’enregistrement survit, sans dialogue, et finira son envoi |
| Hors ligne | L’éditeur Google ne fonctionne pas ; la copie locale, si |
| Fusion automatique | Corrections indépendantes seulement ; longueurs de document différentes = conflit |

## Connexion Google dans la vue intégrée

**Vérifiée par Timo le 2026-09-15**, sur sa session : Google accepte la connexion du
compte dans la vue intégrée. C'était le risque qui pouvait condamner tout ce lot —
Google refuse ses pages de connexion dans certains navigateurs embarqués, et WorkLogs
ne déguise pas l'`userAgent` d'Electron (il annonce `Electron/44.3.0`). Si un futur
durcissement de Google referme ce chemin, **ne pas contourner la détection** : c'est un
contrôle de sécurité du fournisseur, et un déguisement casserait à leur mise à jour
suivante. Consigner le refus et rouvrir la question du lien vers le navigateur.

L'autorisation **des API** reste, elle, dans le navigateur système : c'est une exigence
de la [politique OAuth de Google](https://developers.google.com/identity/protocols/oauth2/policies),
pas un choix révisable.

Reste à passer sur une vraie session, avec un vrai document :

1. Modifier un menu déroulant, une image et une suggestion dans l'éditeur Google, puis
   « Copie locale » : vérifier que WorkLogs relit bien le document modifié.
2. Modifier localement un onglet, modifier un autre passage dans Google, envoyer :
   vérifier la réconciliation. Puis modifier le même passage des deux côtés et vérifier
   le conflit et la conservation du brouillon.
3. Fermer la fenêtre pendant un enregistrement Google : vérifier l'avertissement.
4. Enchaîner deux documents Google : vérifier que le premier se libère.
5. Couper le réseau : l'éditeur Google signale l'échec, la copie locale reste éditable.

## Validation de ce lot

`./scripts/check.sh` : **265 tests** (99 API, 87 front, 32 desktop unitaires, 16 scripts,
21 navigateur, 10 Electron), `CHECK OK`. Aucun compte Google réel, aucun jeton, aucun
contenu privé n’a été utilisé ni ajouté au dépôt.

Fichiers principaux : `desktop/google-view.mjs`, `desktop/main.mjs`, `desktop/preload.cjs`,
`web/src/components/GoogleDocsEditor.tsx`, `web/src/google-desktop.ts`, `EntryEditor.tsx`
et `api/src/google-merge.js`.

---

# Google Docs — onglets et synchronisation, bilan du 2026-09-15

**Branche `codex/google-docs-layout-sync` mergée sur master, publiée en v0.10.0.**
Aucune dépendance ajoutée ; Tiptap déjà approuvé est réutilisé.

## Ce qui change

- Un clic Drive ouvre tous les onglets. Le sélecteur qui désactivait les onglets
  complexes a été retiré. Navigation verticale, recherche, noms complets, profondeur,
  clavier, indicateur de brouillon et dernier onglet retenu au redémarrage.
- Un fichier reste une ligne du journal même si ses onglets ont des dates différentes.
  Les filtres ne retirent plus les autres onglets du document ouvert.
- Document plus large, tâches repliables, détails secondaires regroupés, états
  local/Google distincts, barre de mise en forme persistante et petits écrans adaptés.
- Les tableaux et objets Google restent dans le document ; les cellules sont éditables.
  Les suggestions deviennent des blocs conservés, sans bloquer les autres paragraphes.
  La présence de commentaires ne refuse plus tout l’import.
- Les patches modifient seulement les plages et styles concernés, de la fin vers le
  début, avec indices UTF-16 et `requiredRevisionId`. Pas de reset global des styles.
- Une écriture WorkLogs avance les associations d’onglets lues à cette même révision,
  ce qui évite un faux conflit sur l’onglet suivant.
- Réouvrir depuis Drive récupère les anciens imports aplatis intacts. Un brouillon
  modifié est conservé et nécessite une copie/relecture explicite.

## Périmètre exact

| Contenu / opération | Comportement |
|---|---|
| Texte, titres 1–6, Titre/Sous-titre Google, styles courants, liens web | Édition et envoi ciblé |
| Cellules de tableaux existants | Texte/styles éditables ; structure native conservée |
| Nouveaux paragraphes dans une région/cellule compatible | Synchronisés sans aplatir le tableau |
| Retraits, exposants/indices, listes imbriquées | Import/conservation ; édition du texte |
| Commentaires | Restent dans Google ; ne bloquent plus les autres modifications |
| Menus déroulants, puces enrichies, images, objets intégrés | Repères conservés ; texte autour éditable et synchronisable |
| Suggestions actives, table des matières, sauts de section | Blocs conservés ; édition exacte dans Google Docs |
| Lignes/colonnes/fusions/en-têtes/largeurs de tableaux, nouveaux tableaux/images, certains changements de listes | Pas encore synchronisés ; erreur explicite et brouillon conservé |
| Collaboration en temps réel / envoi automatique en arrière-plan | Non ; envoi explicite |

L’[API Docs décrit les éléments de paragraphe](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents#ParagraphElement)
et les [opérations d’écriture disponibles](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request).
Elle ne fournit pas d’opération pour modifier les options d’un menu déroulant. Le lien
« Ouvrir dans Google Docs » reste nécessaire pour ces éléments. Les caractères privés
renvoyés pour les widgets sont des repères : Google les supprime lors d’insertText,
ils ne doivent donc jamais être renvoyés comme du texte.

## Validation de ce lot

`./scripts/check.sh` : **244 tests** (92 API, 81 front, 28 desktop unitaires, 16 scripts,
21 navigateur, 6 Electron). Le test historique de surlignage/rechargement peut être
intermittent ; cela était également observé avant le lot. Rendu inspecté à 1440 px
(sombre) et 390 px (clair).

**Vraie API Google validée le 15/09 :** création d’un document temporaire avec texte,
emoji, style Titre, retrait et tableau à deux cellules. Modification du texte et du
montant d’une cellule puis ajout d’un paragraphe dans la cellule. La relecture confirme
contenu, style, retrait et commentaire conservé. Document temporaire mis à la corbeille.

**Document existant, lecture seule :** **11 onglets** importés, **54 éléments natifs**
conservés. Chaque import inchangé produit zéro requête d’écriture. Aucun original
modifié, aucun contenu privé ni identifiant Google ajouté au dépôt. Les jetons de
recette sont restés chiffrés dans un profil temporaire, puis retirés.

Fichiers principaux : `api/src/google-preserve.js`, `api/src/google-routes.js`,
`web/src/google-content.ts`, `web/src/components/DocumentTabs.tsx`, `EntryEditor.tsx`
et `styles.css`. La migration ajoute uniquement `google_documents.tab_depth`.

---

## Historique du lot initial (2026-09-14)

Le périmètre et la validation ci-dessus remplacent les limites historiques ci-dessous.

# Documents riches et Google Drive — reprise du 2026-09-14

**Branche : `codex/integrated-documents`. Implémentation locale, pas de release publiée pour ce lot.**
L’utilisateur a choisi « On fait tout dans worklogs » et a explicitement approuvé
Tiptap 3.31.3 et les neuf modules listés dans `AGENTS.md`.

## Ce qui fonctionne

- **Nouveau document** dans le journal existant : édition visuelle, titres 1–3,
  gras, italique, souligné, barré, police/taille/couleur, surlignage, alignement,
  listes, liens, tableaux, images locales, annuler/rétablir, impression.
- Sauvegarde locale automatique via la file `Autosave`, `Ctrl+S`, sauvegarde avant
  fermeture Electron, recherche dans le texte et export JSON avec la mise en forme.
- Les anciennes entrées Markdown restent utilisables. Aucun onglet ni routeur ajouté.
- Panneau **Google Drive** repliable dans le journal desktop : configuration, connexion,
  sélection de documents autorisés, liste paginée, ouverture dans l’éditeur WorkLogs.
- **Synchroniser avec Drive** crée un Google Docs pour un document local compatible ;
  **Enregistrer sur Drive** met à jour le document associé. L’envoi est explicite,
  distinct de l’enregistrement automatique local. Le titre WorkLogs d’un document déjà
  lié reste local ; il ne renomme pas le fichier Google.
- Révision Google vérifiée avant envoi, puis imposée atomiquement au `batchUpdate`.
  Un conflit conserve le brouillon. **Garder une copie locale** duplique aussi les
  fichiers ; **Recharger depuis Google** exige une confirmation et contrôle que le
  brouillon n’a pas changé pendant le réseau.
- Supprimer une entrée WorkLogs ne supprime jamais le fichier Google.

## Limites actuelles — ne pas promettre la parité Google Docs

| Fonction | Local | Synchronisation Google |
|---|---|---|
| Texte, titres 1–6 importés, gras/italique/souligné/barré, liens web | Oui | Oui |
| Police, taille, couleurs usuelles, alignement | Oui | Oui, valeurs représentables par le convertisseur |
| Listes à puces / numérotées | Oui | Listes simples, numérotation décimale depuis 1 |
| Tableaux, images et listes imbriquées | Oui | Refusés avant import/écriture |
| Commentaires, suggestions, plusieurs onglets Google, objets intégrés | Non | Refusés avant import/écriture |
| Signets internes, notes de bas de page, styles Google Titre/Sous-titre, retraits personnalisés, exposants/indices | Non | Refusés avant import/écriture |
| Collaboration en temps réel / synchronisation en arrière-plan | Non | Non |

L’éditeur est propre à WorkLogs. L’[API Docs](https://developers.google.com/workspace/docs/api/how-tos/overview)
fournit l’édition du contenu, pas l’interface Google Docs. L’intégration Google
[« Publier sur le Web »](https://support.google.com/docs/answer/183965?hl=fr) est une
consultation publiée, qui ne répond pas à l’édition privée demandée.

**Les tests Google utilisent des réponses simulées. Aucun vrai compte/client OAuth
n’a été configuré dans cette session : la connexion réelle et l’aller-retour sur
un document Google de test restent à valider.** Ne pas annoncer ce parcours comme
validé en production avant la recette ci-dessous.

## Configuration depuis l’application desktop

1. Dans [Google Cloud](https://console.cloud.google.com/), créer ou choisir un projet.
2. Activer **Google Docs API**, **Google Drive API** et **Google Picker API**.
3. Configurer Google Auth Platform : nom de l’application, audience et compte de test
   si le projet est en mode test. Demander uniquement le scope
   `https://www.googleapis.com/auth/drive.file`.
4. Créer un client OAuth de type **Application de bureau**, puis télécharger son JSON
   (objet `installed`, avec `client_id` et, si fourni, `client_secret`).
5. Lancer `npm run desktop`, déplier **Google Drive**, puis **Importer la configuration
   Google**. Ce fichier identifie le client desktop ; ce n’est pas un compte de service.
6. **Connecter Google Drive** ouvre le navigateur système. Autoriser et sélectionner
   un Google Docs de test compatible. Revenir dans WorkLogs puis ouvrir le document
   depuis la liste. **Choisir des documents dans Drive** accorde l’accès à d’autres fichiers.

Le [flux OAuth desktop](https://developers.google.com/identity/protocols/oauth2/native-app)
utilise PKCE et un retour HTTP sur `127.0.0.1` à port éphémère. Google interdit les
[demandes OAuth dans une vue web embarquée](https://developers.google.com/identity/protocols/oauth2/policies).
Le [Picker desktop](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker)
passe lui aussi par le navigateur, avec `trigger_onepick=true`, puis renvoie
`picked_file_ids`. L’édition, elle, se fait dans WorkLogs.

Le scope [`drive.file`](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
limite l’accès aux documents autorisés pour WorkLogs ; coller une URL n’accorde pas cet
accès. Aucun serveur hébergé ni SDK Google supplémentaire n’est nécessaire.

## Données, confidentialité et architecture

- `entries.content_json` : JSON riche sérialisé en SQLite TEXT, NULL pour les anciennes
  entrées. Migration additive testée sur une base V2 antérieure. `content_md` fournit
  le texte de recherche pour les documents riches ; il ne remplace pas leur JSON.
- `google_documents` : association entrée/fichier Google, dernière révision confirmée,
  JSON envoyé et date de synchronisation. Aucun jeton dans SQLite ou l’export du journal.
- Profil desktop : `google-client.json` (configuration du client public desktop),
  `google-tokens.enc` (jetons chiffrés via Electron `safeStorage`), permissions 0600.
  Le stockage Linux `basic_text` est refusé ; le trousseau de session doit être disponible.
- Connexion annulable et expirant après cinq minutes, état aléatoire contrôlé,
  renouvellement des jetons sérialisé, effacement local à la déconnexion/révocation.
- Les appels Google passent par Node. Le renderer reste isolé, sans jeton OAuth ni
  nouveau bridge IPC. Le service Google n’est injecté que dans le serveur desktop
  protégé par son jeton local ; le mode web annonce Drive indisponible.

| Fichier | Rôle |
|---|---|
| `web/src/components/RichEditor.tsx` | éditeur Tiptap et barre de mise en forme |
| `web/src/components/EntryEditor.tsx` | sauvegarde locale, envoi/rechargement Drive, copie |
| `web/src/components/GoogleDrive.tsx` | connexion, configuration et liste des documents |
| `api/src/rich-document.js` | validation JSON, extraction du texte, décodage SQLite |
| `api/src/google-document.js` | conversion du sous-ensemble Google, opérations ciblées et `requiredRevisionId` |
| `api/src/google-routes.js` | import, création, envoi, rechargement, conflits et sérialisation des opérations |
| `desktop/google.mjs` | OAuth, chiffrement et accès aux API Google |
| `scripts/stage-desktop.mjs` | inclut explicitement `google.mjs` dans le paquet |

La [révision requise](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)
refuse une écriture si un autre client a modifié le document entre la lecture et l’envoi.
Le convertisseur conserve les portions de texte inchangées via un calcul de préfixe/suffixe
UTF-16 et réapplique les styles pris en charge. L’extension à d’autres formats doit inclure
les tests de conservation correspondants ; ne pas enlever simplement les refus.

## Validation et reprise rapide

`./scripts/check.sh` est vert : **188 tests** (71 API, 64 front, 21 desktop/OAuth,
10 scripts, 16 navigateur, 6 Electron). L’éditeur a aussi été inspecté visuellement.

```bash
npm run install:all
./scripts/check.sh
npm run desktop
```

Tests ajoutés : `api/test/rich-document.test.js`, `api/test/google-document.test.js`,
`desktop/test/google.test.mjs`, `web/src/GoogleDrive.test.tsx`,
`e2e/rich-document.spec.ts` et un parcours riche dans `desktop/e2e/desktop.spec.ts`.
Ils couvrent migration, persistance, copie avec fichiers, OAuth/PKCE/refus/renouvellement,
contenus incompatibles, conflits et absence d’écrasement local, édition et impression.

Recette réelle Google à effectuer :

1. Avec un client OAuth et un trousseau disponibles, connecter un compte de test et
   sélectionner un document avec texte, titre 2, gras, lien et liste simple.
2. Ouvrir dans WorkLogs, modifier texte/styles, envoyer, vérifier dans Google Docs,
   fermer WorkLogs et vérifier la persistance au redémarrage.
3. Modifier le fichier dans Google Docs, vérifier le refus d’envoi depuis l’ancien
   brouillon, créer une copie locale, puis recharger Google dans WorkLogs.
4. Vérifier le refus explicite des documents complexes et des permissions insuffisantes.
5. Couper le réseau : la sauvegarde locale doit continuer, l’envoi doit signaler l’échec.
   Déconnecter puis reconnecter ; vérifier le renouvellement et les permissions.

Une fois cette recette verte, décider si l’on élargit le sous-ensemble Google ou publie
un premier lot. Le lot n’a créé ni tag ni release ; suivre `07-RELEASES.md` pour publier.
