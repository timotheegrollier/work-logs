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
