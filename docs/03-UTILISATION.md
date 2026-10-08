# 📖 WorkLogs — guide d'utilisation

> Ce guide décrit le socle web. Le desktop Linux est publié depuis la v0.13.0 :
> [état et reprise](06-DESKTOP-CICD.md). Il se lance avec `npm run desktop` et utilise un
> dossier de données distinct. Les paquets exploratoires ne sont pas des releases validées.

## Les onglets Google Docs (2026-09-15)

Dans **Gérer Google Drive**, ouvrir le dialogue dédié puis cliquer sur un document ouvre tous ses onglets. La liste verticale
à côté de la page conserve les sous-onglets indentés ; la recherche apparaît à partir
de six onglets. Les flèches haut/bas déplacent le focus, Entrée ouvre l’onglet. Le dernier
onglet est retenu au redémarrage. **Afficher les tâches** rouvre le panneau latéral.

Le texte et les cellules se modifient dans WorkLogs. **Enregistrer sur Drive** envoie
les changements ; la sauvegarde sur cet appareil reste automatique. **Actualiser**
recharge l’onglet Google après confirmation. Le menu **•••** garde une copie locale.
Titre local, projet, date, impression et suppression sont dans **Détails du document**.

Les éléments natifs signalés restent conservés. **Ouvrir dans Google Docs** accède au
bon onglet pour modifier un menu déroulant, une image, une suggestion ou la structure
d’un tableau. Ces fonctions ne sont pas encore toutes éditables dans WorkLogs.

Pour un ancien import simplifié, réouvrir le fichier depuis Drive récupère les onglets
intacts. Si tu as modifié un de ces brouillons, garde une copie locale puis actualise-le.
Ses modifications ne sont pas écrasées automatiquement.

## Ouvrir

<http://localhost:8411>

Si la page affiche « API injoignable » :
```bash
cd /home/timo/WorkLogs && npm run dev
```

## L'écran

Une seule page, trois zones, jamais de navigation.

| Zone | Ce qu'on y fait |
|---|---|
| **Gauche — Journal** | filtrer par projet, créer une entrée, retrouver les précédentes (groupées par jour), ouvrir la gestion Google Drive |
| **Centre — Écriture** | écrire l'entrée ouverte, la relire, l'imprimer, y joindre des fichiers |
| **Droite — Tâches** | ajouter, avancer, terminer, relier les documents de contexte |

En haut : la recherche, le résumé de la semaine, les interrupteurs de panneaux, le thème
clair/sombre, l'export (masqué une fois connecté à Google : la synchro automatique garde
déjà une copie sur Drive) et le menu du compte. Sur téléphone, les interrupteurs de
panneaux passent dans une barre fixée en bas de l'écran, à portée de pouce.

Les boutons **Journal** et **Tâches** de l'en-tête replient les panneaux latéraux
pour ne garder que ce qui sert (l'écriture en grand, par exemple) ; l'état est
retenu au redémarrage. Sur téléphone, c'est ce qui rend chaque zone utilisable
plein écran.

Pour régler les barres latérales, **cliquer-glisser la poignée entre le journal et
le document, ou entre le document et les tâches**. La largeur change immédiatement
et reste mémorisée après redémarrage. Les champs de largeur au pixel près et **Largeurs par défaut**
sont dans **Paramètres → Affichage**. Au clavier, sélectionner une poignée avec Tab puis utiliser
les flèches gauche/droite (10 px, ou 50 px avec Maj) ; Début/Fin donnent les limites.
Sur une petite fenêtre, les colonnes se resserrent pour conserver la place du document.
Les poignées disparaissent lorsque les panneaux sont empilés ou masqués.

## Écrire une entrée

1. **+ Nouvelle entrée** — elle est créée à la date du jour, le curseur est dans le titre.
2. Taper le titre, puis basculer sur **Écrire** : le texte à gauche, l'aperçu à droite.
3. **Rien à enregistrer** : ça part tout seul après une seconde d'arrêt. L'indicateur en haut
   à droite passe de « Modifications en cours… » à « Enregistré ». `Ctrl+S` force l'envoi.
4. **Lire** repasse en pleine largeur pour relire sans le code Markdown.

**Un bloc de code** (commande, script, extrait de configuration) : en mode **Écrire**, sélectionner
les lignes puis cliquer **`{ }`** à côté de Écrire/Lire — elles sont entourées de ` ``` `. Sans
sélection, le bouton insère un bloc vide au curseur : il n'y a plus qu'à coller ou taper le code.

Une entrée porte une **date** (modifiable : utile pour rattraper un compte rendu de la veille)
et un **projet** (facultatif).

**Archiver** (bouton dans la barre de l'entrée) range un document hors du journal sans
rien détruire : les tâches liées gardent leur contexte et **Supprimer** n'est pas appelé.
Terminer une tâche archive automatiquement tous ses documents liés ; les archives se
déplient en bas de la colonne de gauche, par jour comme le journal ;
**Désarchiver** remet le document à sa place. Même geste pour un document Google :
l'archiver le masque de l'application locale en conservant le fichier distant, tandis
que **Supprimer** ne retire que la copie locale (jamais le fichier Google).

### Aide-mémoire Markdown

| On tape | On obtient |
|---|---|
| `## Section` | un titre de section |
| `### Sous-section` | un sous-titre |
| `**gras**` · `*italique*` | **gras** · *italique* |
| `- point` | une liste à puces |
| `1. point` | une liste numérotée |
| `- [ ] à faire` · `- [x] fait` | une case à cocher |
| `> texte` | une citation, pour isoler une décision |
| `` `commande` `` | du code dans la phrase |
| ` ```bash ` … ` ``` ` | un bloc de code (ou le bouton `{ }` en mode Écrire) |
| `[texte](https://…)` | un lien |
| `![légende](https://…)` | une image |
| `---` | un trait de séparation |

Les tableaux, avec alignement :
```
| Poste       | Montant  | Statut     |
| ---         | ---:     | ---        |
| Toiture     | 12 400 € | validé     |
| Menuiseries |  5 100 € | en attente |
```
`---:` aligne la colonne à droite (pratique pour les montants), `:---:` la centre.

### Imprimer, ou faire un PDF

Bouton **Imprimer** (ou `Ctrl+P`). Tout l'habillage disparaît : il ne reste que le titre et le
texte mis en page, marges propres, tableaux et blocs de code lisibles en noir sur blanc, et pas
de titre orphelin en bas de page. Dans la fenêtre d'impression, choisir « Enregistrer au format
PDF » pour obtenir un document à envoyer.

### Joindre des fichiers

**📎 Joindre un fichier** attache un ou plusieurs documents à l'entrée ouverte (devis, photo,
plan…). Clic sur le nom pour le récupérer, ✕ pour le retirer. Supprimer l'entrée supprime aussi
ses fichiers.

**👁 Aperçu** affiche le fichier dans WorkLogs, sans ouvrir un autre programme : les images,
les PDF et les textes (`.txt`, `.md`, `.csv`, code…) s'y lisent directement, et le bouton
**Télécharger** du dialogue reste disponible. Les tableurs (`.xlsx`, `.ods`…) ne sont pas
décodés — l'aperçu le dit franchement et renvoie au téléchargement, plutôt que d'afficher un
rendu approximatif.

## Suivre ses tâches

- **Ajouter** : taper dans « Nouvelle tâche… » puis `Entrée`. Si un projet est filtré, la tâche
  lui est rattachée automatiquement.
- **Avancer** : glisser la carte d'une colonne à l'autre (À faire → En cours → Terminé).
- **Terminer** : cocher la case. Le titre se barre et la carte rejoint Terminé.
- **Modifier** : cliquer sur le titre ouvre le nom, l'échéance et la priorité. `Entrée` valide, `Échap` annule.
- **Priorité** : chaque carte affiche sa pastille — Basse, Normale ou Haute (▲ rouge). Elle ne réordonne pas la colonne : l'ordre reste celui du glisser-déposer.
- **★** met la tâche en avant (liseré coloré à gauche), indépendamment de sa priorité.
- Une échéance dépassée s'affiche en rouge, et le compteur « en retard » apparaît en haut.
- **Créer une tâche liée** depuis l’entrée ouverte préremplit son titre et permet d’ajouter une échéance. La tâche apparaît directement dans le panneau de droite avec cette entrée comme contexte.
- **Relier un document** ouvre la liste des entrées disponibles. Choisir une entrée locale ou un onglet Google puis cliquer sur **Relier** ; chaque document lié reste visible sur la carte avec son origine.
- Cliquer sur le titre d'un document lié l'ouvre au centre. Le bouton ✕ retire seulement l'association, sans supprimer le document. Une même entrée peut fournir le contexte de plusieurs tâches.
- **✨ Procédure** (pied de carte) fait rédiger par l'IA une procédure à partir de la tâche et de ses documents liés, à relire avant de la créer — voir « Procédures ».

## Projets

Les pastilles en haut à gauche filtrent **le journal et les tâches en même temps** : un clic sur
« Chantier » et l'écran entier ne parle plus que de ce chantier. Recliquer enlève le filtre ; le dernier
projet sélectionné est retenu au prochain démarrage. Si le projet a été supprimé, WorkLogs revient à
« Tout ».

Les documents associés restent le contexte d'une tâche même s'ils appartiennent à un autre projet.
Supprimer une entrée Google dans WorkLogs ne supprime jamais le fichier Google distant ; cela retire
seulement sa copie locale, y compris si le fichier est déjà absent ou dans la corbeille Drive.

**Gérer les projets** (dépliant sous les pastilles) permet d'en créer, de les renommer, de
changer leur couleur, de les supprimer. Supprimer un projet ne supprime **rien** : les entrées
et les tâches restent, simplement détachées.

## Procédures

Le bouton **Procédures** de l'en-tête affiche une sidebar dédiée, à droite des
tâches : elle rassemble les modes d'emploi du projet sélectionné avec leurs
pièces jointes. Une procédure est un document comme un autre (même éditeur,
mêmes fichiers, mêmes sauvegardes), simplement aiguillé ici par son type.
**Nouvelle procédure** en crée une déjà rattachée au projet filtré ; chaque ligne
a son **＋ Fichier** pour joindre sans ouvrir l'éditeur ; cliquer son titre
l'ouvre au centre **en lecture**, **Modifier** l'ouvre **en écriture** ; cliquer un
fichier le télécharge. Sans filtre, toutes les
procédures s'y retrouvent, pastille projet à l'appui. Les procédures ne
figurent **pas** dans le journal (seulement dans ses archives une fois archivées,
pour pouvoir les restaurer). Comme les autres panneaux, la sidebar est toujours
dépliée quand elle est affichée, se masque par son bouton et l'état est retenu.

Comme une entrée, une procédure a ses modes **Écrire** / **Lire**. Lire montre le
document seul, sans barre d'outils ni risque de le modifier en le suivant (les liens
s'ouvrent d'un clic) ; Écrire rend la barre de mise en forme. Une procédure neuve
s'ouvre en écriture ; une procédure liée à Google Docs garde son éditeur Google.

**Bloc de code** dans une procédure : cliquer **`{ }`** dans la barre puis coller ou
taper la commande, ou taper ` ``` ` puis Entrée en début de ligne. Des lignes déjà
collées : les sélectionner puis **`{ }`** — elles forment un seul bloc.

**Tirer une procédure de son travail, avec l'IA.** Dans une entrée du journal,
**✨ Créer une procédure** ; sur une carte de tâche, **✨ Procédure**. L'IA (le service
réglé dans ⚙ Paramètres, Gemini par défaut) lit l'entrée — ou la tâche et ses documents
liés — et rédige un mode opératoire : un titre, l'objectif, les prérequis, les étapes
numérotées, les vérifications ; « à préciser » là où la source ne dit rien. La proposition
se relit sur place : corriger le titre si besoin, puis **Créer la procédure** (ou
**Rafraîchir**, ou **Ignorer**). Rien n'est créé avant. La procédure rejoint le projet de sa
source et s'ouvre en lecture ; l'entrée et la tâche ne changent pas, et la procédure ne leur
est pas liée — terminer la tâche ne l'archive donc pas. Un document Google n'est jamais
envoyé à l'IA : pas de bouton sur lui, et depuis une tâche, seul son titre part.

## Dossier partagé (le dossier du TSE)

Sous les procédures, la section **Dossier partagé** montre le dossier de l'équipe, celui du
TSE. Sur le desktop, tape son **adresse comme sous Windows** — `\\serveur\partage` (ou
`smb://serveur/partage`, éventuellement suivie d'un sous-dossier) — puis **Se connecter** :
WorkLogs le monte comme le gestionnaire de fichiers (Nemo). S'il faut un mot de passe, c'est
la fenêtre « Authentification requise » de Nemo qui le demande (choisis « Se souvenir pour
toujours ») ; elle peut s'ouvrir derrière WorkLogs. WorkLogs ne voit jamais tes
identifiants. Si un dossier affiche **« Accès refusé »**, le partage est monté avec un compte
qui n'y a pas droit (souvent l'accès invité) : renseigne **Compte** avec celui du TSE
(`SRVMURGAT\TonNom`, même orthographe, accents compris) et reconnecte-toi ; l'adresse peut
viser directement un sous-dossier (`\\SRVMURGAT\Global\MURGAT INGENIERIE\13. SI\00. PROCEDURE`) :
la section l'ouvre alors comme racine, sans descendre dans l'arborescence. L'adresse et le
compte restent remplis pour la fois suivante (« Changer de dossier… », « Se reconnecter »),
même quand le dossier a été choisi par « ou choisir un dossier déjà monté… ». Après un redémarrage, le partage n'est plus monté : **Se reconnecter** le
remonte d'un clic. Un dossier déjà monté se choisit aussi par « ou choisir un dossier déjà
monté… ». Le choix est retenu sur cet ordinateur seulement ; la section ne lit le partage que
lorsque la colonne Procédures est affichée.

- Cliquer un fichier l'ouvre **au centre**, comme une entrée. `.txt`, `.md`, `.csv`,
  `.tsv`, **`.docx`** et **`.xlsx`** se modifient directement (grille pour les CSV et les
  classeurs : flèches, Entrée, Tab, F2, copier-coller depuis un tableur ; ＋/− ligne et
  colonne pour les CSV).
- **Documents Word** : texte, gras/italique/souligné/barré, style de paragraphe (Normal,
  Titre 1, Titre 2…), alignement, niveau de liste (Tab / Maj+Tab), texte des liens et des
  cellules de tableau. Images, champs, table des matières, zones de texte… s'affichent en
  « objet conservé » : ils repartent tels quels, modifiables dans Word (« Ouvrir avec… »).
  Seuls les paragraphes que tu as touchés sont réécrits ; le reste du fichier (styles,
  en-têtes, numérotation, images) ne change pas d'un octet. Un document en suivi des
  modifications s'ouvre en lecture seule.
- **Classeurs Excel** : une feuille à la fois, choisie dans la liste **Feuille** (les
  feuilles masquées y sont signalées). Les valeurs s'affichent comme dans Excel
  (`1 234,50 €`, `05/10/2026`, `12,5 %`) ; la barre « Contenu de la cellule » montre la
  valeur brute ou la formule. Tape comme dans Excel en français : `12,5`, `12,5 %`, une date
  dans une cellule de date, `'0123` pour garder un texte, `=SOMME(B2:B10)` ou
  `=SI(A1>0;"oui";"non")` pour une formule. Une formule mal écrite est signalée sous la
  grille et l'envoi attend qu'elle soit corrigée. Pour ajouter une ligne ou une colonne,
  tape dans la ligne ou la colonne libre en bas ou à droite.
  Seules les cellules que tu as tapées sont réécrites ; graphiques, mises en forme,
  validations et tableaux ne changent pas. WorkLogs ne calcule pas : les formules qui
  dépendent de tes cellules affichent leur formule jusqu'à l'ouverture dans Excel ou
  LibreOffice, qui les recalculent. Restent en lecture seule, avec leur raison quand tu
  cliques dessus : cellules fusionnées, en-têtes et totaux de tableaux, tableaux croisés,
  cellules verrouillées d'une feuille protégée, formules recopiées sur plusieurs cellules ;
  et tout un classeur à macros (`.xlsm`) ou protégé par un mot de passe de modification.
- Tes modifications s'enregistrent **seules sur cet ordinateur** (« Brouillon sur cet
  ordinateur »). Elles ne partent sur le partage qu'avec **Enregistrer sur le partage**
  ou `Ctrl+S`. Le fichier garde son encodage (Windows-1252 pour un CSV d'Excel), son
  séparateur et ses fins de ligne ; une ligne que tu n'as pas touchée ne change pas d'un
  octet.
- **Chacun son tour.** Un fichier ouvert dans Word, Excel ou LibreOffice par un collègue
  s'affiche « Lecture seule — Ouvert par Jean Dupont dans Word depuis 10h42 ». Tu peux
  quand même préparer un brouillon ; l'envoi attend que le fichier soit libre et part tout
  seul ensuite (ou **Réessayer maintenant**).
- **Rien n'est écrasé.** Si quelqu'un a enregistré le fichier pendant que tu le modifiais,
  WorkLogs ne l'écrase pas et te demande : **Garder ma version**, **Prendre la leur** ou
  **Garder les deux** (ta version est alors enregistrée à côté, sous
  « Nom (copie Ton Nom date heure) »). Les versions écartées restent sur cet ordinateur.
- **Hors ligne** (VPN coupé), les fichiers déjà ouverts restent modifiables ; l'envoi part
  au retour du partage. Un partage démonté est signalé « Non monté » : WorkLogs n'écrit
  jamais dans le dossier vide qui reste à sa place.
- Sans modification de ta part, la version d'un collègue s'affiche d'elle-même (toutes les
  5 secondes, et quand tu reviens sur la fenêtre).
- Pastilles de l'arbre : 🔒 ouvert par quelqu'un, ✎ brouillon ici, ⇡ envoi en attente,
  ⚠ conflit à régler, ↻ modifié sur le partage depuis ta dernière lecture.
- **Tu as la main** dès ta première frappe : WorkLogs pose un verrou à ton nom (réglable
  dans Paramètres › Dossier partagé) que LibreOffice et les autres WorkLogs voient. Il est
  rendu quand tu fermes le fichier, ou après 10 minutes sans frappe. Un verrou resté d'un
  collègue sans signe de vie depuis plusieurs minutes est signalé « probablement oublié » :
  **Prendre la main** le reprend (avec confirmation).
- Quitter un fichier dont le brouillon n'est pas envoyé (Fermer, une entrée, un autre
  fichier) demande : **Envoyer sur le partage**, **Garder le brouillon ici** ou **Annuler**.
- **Ouvrir avec…** (application desktop) ouvre le vrai fichier du partage dans LibreOffice
  ou l'application du système — pour ce que WorkLogs ne modifie pas (en-têtes Word, mise en
  forme Excel, autres formats). Envoie ou abandonne d'abord ton brouillon.
- Avec un projet filtré, **Relier … à un dossier…** associe le projet à un sous-dossier du
  partage : la section n'affiche plus que lui. **Délier** rend tout le partage.
- **Historique sur cet ordinateur** (sous l'éditeur) liste les versions lues, envoyées ou
  mises de côté ; **Restaurer** en fait ton brouillon, à envoyer comme d'habitude.
- **Fusionner.** Si un collègue a enregistré pendant que tu modifiais un fichier texte, un
  CSV ou un classeur Excel, et que vos modifications ne se touchent pas (des lignes, ou des
  cellules, différentes), le conflit propose **Fusionner** : les deux sont gardées et la
  version réunie part sur le partage. Sinon WorkLogs dit ce que vous avez modifié tous les
  deux (« la ligne 12 », « la cellule Suivi!B3 ») et les trois choix habituels restent.
  Pas de fusion automatique pour un document Word.
- **Chercher** : le champ « Chercher dans le partage » trouve un fichier ou un dossier par
  son nom, au fond de l'arborescence (sans casse ni accents : `procedure` trouve
  « 00. PROCEDURE »). Un fichier s'ouvre ; un dossier se déplie dans l'arbre. Les dossiers
  fermés à ton compte sont passés (et comptés).
- **＋ Nouveau fichier…** crée un document Word, un classeur Excel, une note Markdown, un
  texte ou un CSV dans le dossier choisi (la racine, ou un dossier que tu as déplié). Il est
  créé tout de suite sur le partage et s'ouvre au centre ; un nom déjà pris est refusé, rien
  n'est écrasé. Le document Word commence par son nom en Titre 1, le classeur a une feuille
  « Feuil1 ».
- **Supprimer** : la ✕ de l'arbre, ou **Supprimer du partage** dans l'éditeur, retire le
  fichier du partage aussitôt, pour toute l'équipe (avec confirmation). Rien n'est
  supprimé sans avoir été vu : si un collègue a enregistré le fichier depuis ta dernière
  lecture, WorkLogs refuse et te fait rouvrir le fichier ; avec un brouillon non envoyé,
  un envoi en attente, un conflit ou un fichier ouvert par un collègue, il le dit et ne
  supprime rien. Seuls les fichiers se suppriment, jamais les dossiers. L'historique
  gardé sur cet ordinateur reste.
- **Hors ligne**, l'arbre reste celui que tu as vu en dernier (« Hors ligne — liste vue à
  10h42 ») : les fichiers gardés sur cet ordinateur s'ouvrent, les autres sont grisés. La
  recherche cherche alors dans ces listes.

Limite à connaître : Word et Excel **ne voient pas** que tu modifies un fichier dans
WorkLogs (ils ignorent les verrous des autres applications). Rien n'est perdu pour autant :
si un collègue enregistre avant toi, ton envoi te demande quoi faire.

**Sur le téléphone (PWA)**, le dossier des procédures passe par le **relais du bureau** (la VM,
jointe par Tailscale) : Paramètres › Dossier partagé du TSE, adresse et code d'accès du relais
(installation : `docs/09-RELAIS.md`). Ensuite tout est pareil : lire, modifier, créer,
envoyer, conflits. Tailscale doit être allumé sur le téléphone.

## Retrouver

La recherche en haut cherche dans les **titres et le corps** des entrées, et dans les titres des
tâches. Elle se combine avec le filtre projet.

## Installer sur mobile (PWA)

Sur Android, ouvre l'URL de la PWA dans Chrome puis « Ajouter à l'écran d'accueil » :
l'application s'ouvre en plein écran, fonctionne hors-ligne (coquille en cache) et se met
à jour toute seule au rechargement suivant. Aucun compte requis : sans connexion Google,
les données restent sur l'appareil ; la synchronisation Drive arrive aux lots suivants.

## Gérer Google Drive

Le bouton **⚙ Paramètres** (en-tête) mène à **Gérer Google Drive**, qui ouvre un dialogue dédié. Toute la
gestion Drive s'y trouve : configuration OAuth, connexion, choix des fichiers autorisés, création,
recherche, ouverture, sauvegardes et déconnexion. Le dialogue est au premier plan ; fermer le dialogue
ne ferme pas le document actuellement ouvert au centre.

**Le menu du compte** (en haut à droite, à la place de ⚙) : déconnecté, il ouvre les
**Paramètres** et propose **Se connecter avec Google** ; connecté, il montre ta photo, ton
e-mail et l'état de synchro, et donne accès à **Documents Google**, **Synchroniser
maintenant**, **Paramètres**, **Changer de compte** et **Se déconnecter**.

**Synchronisation automatique.** Connecté au même compte sur le PC et le téléphone, tout suit
tout seul : à la première connexion d'un appareil, la sauvegarde du compte est chargée ;
ensuite chaque modification part quelques secondes après, et ce que l'autre appareil a
changé arrive dans la minute (ou au retour sur l'onglet). Rien n'est écrasé : chaque note,
tâche ou projet garde sa version la plus récente, et une suppression se propage.

**Documents Google** (menu du compte) : la liste des documents autorisés pour WorkLogs,
avec pour chacun **Ouvrir**, un choix de **projet**, et 🗑 (**corbeille Google Drive**,
récupérable 30 jours ; la copie dans WorkLogs est retirée). On y crée aussi un Google Docs.

**Pièces jointes et Drive.** Connecté, chaque fichier joint (procédures comprises) part dans
le dossier `WorkLogs/Pièces jointes` de ton Drive quelques secondes après l'ajout, et reste
aussi sur l'appareil ; badge **☁ Drive**. Sans connexion, il reste sur l'appareil (**local
seul**). Cliquer un fichier le télécharge ; s'il n'est pas encore sur cet appareil mais sur
Drive, il est rapatrié automatiquement.

**Tableurs et autres formats** (`.ods`, `.xlsx`, `.docx`…) : dans l'aperçu, **Ouvrir avec…**
les confie à ton application (LibreOffice sur le PC, en lecture seule — « Enregistrer sous »
puis rejoins la version modifiée ; sur le téléphone, choix de l'application), et **Ouvrir
dans Drive** les affiche dans Google Drive quand ils y sont déjà.

**Supprimer une pièce jointe** : ✕ à côté du fichier, dans la colonne Procédures comme dans
n'importe quelle entrée (y compris un document Google ouvert dans l'éditeur intégré). Après
confirmation, le fichier disparaît de WorkLogs et de tes autres appareils ; son exemplaire
Google Drive part à la corbeille (récupérable 30 jours), sauf si une copie locale d'entrée
utilise encore le même fichier.

**Se connecter avec Google** suffit (desktop comme mobile) : rien à configurer, la connexion
reste facultative et le compte connecté s'affiche en haut du dialogue. Sur mobile, WorkLogs
renouvelle normalement la session en arrière-plan : il n'est pas nécessaire de se reconnecter
à chaque heure. Si Google ne fournit pas de jeton de renouvellement pour une ancienne
autorisation, **Reprendre la session Google** reste proposé, sans ressaisir le compte.
**Utiliser mon propre client OAuth** reste possible pour qui a son projet Google Cloud.

Dans **Sauvegardes WorkLogs**, **Sauvegarder dans Google Drive** maintient un seul fichier JSON
canonique (`WorkLogs backup.json`) : une nouvelle sauvegarde remplace la précédente et les anciennes
copies sont placées à la corbeille. Le fichier est lisible par une autre installation WorkLogs
connectée au même compte. **Restaurer** demande confirmation puis remplace les projets, entrées,
tâches, associations et liens Google locaux de manière transactionnelle. Le JSON contient les
métadonnées des pièces jointes, mais pas leurs octets : les fichiers locaux devront être récupérés
avec `./scripts/backup.sh` si on veut les déplacer aussi. Les boîtes mobiles restent séparées, car
elles attendent une fusion explicite sur le PC.

## Sauvegarder

| Quoi | Comment | Quand |
|---|---|---|
| Copie complète (base + fichiers joints) | `./scripts/backup.sh` | avant toute manipulation risquée, et chaque vendredi |
| Export lisible (JSON) | bouton **Exporter** (hors connexion Google) | pour archiver ou relire ailleurs |
| Sauvegarde JSON Drive | **Gérer Google Drive → Sauvegardes WorkLogs** | pour restaurer sur un autre PC du même compte |

La sauvegarde atterrit dans `~/WorkLogs-backups/worklogs-AAAAMMJJ-HHMMSS/`.

## Ce que l'app ne fait pas — et c'est voulu

Pas de compte, pas d'écriture à plusieurs en même temps (le dossier partagé, c'est chacun son
tour), pas de synchronisation avec un agenda externe, pas d'application mobile, pas de rappel
sonore, pas de recherche plein texte avancée. Chaque ajout de ce genre
ramènerait un onglet ; le raisonnement est dans `05-DECISIONS.md`.
