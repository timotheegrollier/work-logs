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

En haut : la recherche, le résumé de la semaine, le thème clair/sombre, l'export.

Les boutons **Journal** et **Tâches** de l'en-tête replient les panneaux latéraux
pour ne garder que ce qui sert (l'écriture en grand, par exemple) ; l'état est
retenu au redémarrage. Sur téléphone, c'est ce qui rend chaque zone utilisable
plein écran.

Pour régler les barres latérales, **cliquer-glisser la poignée entre le journal et
le document, ou entre le document et les tâches**. La largeur change immédiatement
et reste mémorisée après redémarrage. Les champs de largeur et **Par défaut** restent
disponibles dans l’en-tête. Au clavier, sélectionner une poignée avec Tab puis utiliser
les flèches gauche/droite (10 px, ou 50 px avec Maj) ; Début/Fin donnent les limites.
Sur une petite fenêtre, les colonnes se resserrent pour conserver la place du document.
Les poignées disparaissent lorsque les panneaux sont empilés ou masqués.

## Écrire une entrée

1. **+ Nouvelle entrée** — elle est créée à la date du jour, le curseur est dans le titre.
2. Taper le titre, puis basculer sur **Écrire** : le texte à gauche, l'aperçu à droite.
3. **Rien à enregistrer** : ça part tout seul après une seconde d'arrêt. L'indicateur en haut
   à droite passe de « Modifications en cours… » à « Enregistré ». `Ctrl+S` force l'envoi.
4. **Lire** repasse en pleine largeur pour relire sans le code Markdown.

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
| ` ```bash ` … ` ``` ` | un bloc de code |
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
l'ouvre au centre, cliquer un fichier le télécharge. Sans filtre, toutes les
procédures s'y retrouvent, pastille projet à l'appui. Les procédures ne
figurent **pas** dans le journal (seulement dans ses archives une fois archivées,
pour pouvoir les restaurer). Comme les autres panneaux, la sidebar est toujours
dépliée quand elle est affichée, se masque par son bouton et l'état est retenu.

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
| Export lisible (JSON) | bouton **Exporter** | pour archiver ou relire ailleurs |
| Sauvegarde JSON Drive | **Gérer Google Drive → Sauvegardes WorkLogs** | pour restaurer sur un autre PC du même compte |

La sauvegarde atterrit dans `~/WorkLogs-backups/worklogs-AAAAMMJJ-HHMMSS/`.

## Ce que l'app ne fait pas — et c'est voulu

Pas de compte ni de partage, pas de synchronisation avec un agenda externe, pas d'application
mobile, pas de rappel sonore, pas de recherche plein texte avancée. Chaque ajout de ce genre
ramènerait un onglet ; le raisonnement est dans `05-DECISIONS.md`.
