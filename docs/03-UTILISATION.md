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
Ces commandes et l'ouverture dans Google Docs sont regroupées près de l'état de
synchronisation. Dans l'éditeur Google intégré au desktop, la même zone contient
**Recharger l’éditeur** et **Copie locale** ; depuis cette copie, **Modifier dans
WorkLogs** rouvre l'éditeur complet après envoi du brouillon si nécessaire.
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
| **Centre — Écriture** | écrire l'entrée ouverte, la relire, l'imprimer, y joindre des fichiers ; ou lire la **vue d'ensemble** des projets |
| **Droite — Tâches** | ajouter, avancer, terminer, relier les documents de contexte |

En haut : la recherche (sans accents ni capitales : « procedure » trouve « Procédure »), le résumé de la semaine, les interrupteurs de panneaux, le thème
clair/sombre, l'export (masqué une fois connecté à Google : la synchro automatique garde
déjà une copie sur Drive) et le menu du compte.

Les boutons **Journal** et **Tâches** de l'en-tête replient les panneaux latéraux
pour ne garder que ce qui sert (l'écriture en grand, par exemple) ; l'état est
retenu au redémarrage.

### Sur téléphone : une vue à la fois

Sur téléphone (et en paysage), WorkLogs se comporte comme une application : la **barre du
bas** mène à **Journal**, **Écriture**, **Tâches** ou **Procédures**, et une seule vue occupe
l'écran. Le journal est l'accueil.

- **Ouvrir, c'est y aller** : une entrée du journal, une procédure, un document de tâche ou
  un fichier du dossier partagé s'ouvre dans **Écriture**, par le haut. Créer une entrée aussi.
- **Retour** (geste ou bouton d'Android) : ramène au journal au lieu de fermer l'application.
- Chaque vue **retrouve l'endroit où on l'avait laissée** : revenir au journal après avoir
  lu une entrée ancienne remet la liste là où elle était.
- L'en-tête tient sur une rangée (logo, recherche, thème, compte) et s'efface en descendant ;
  la rangée des projets reste collée en haut.
- Dans **Écriture**, la date, le projet, la catégorie, Imprimer, Archiver et Supprimer sont
  repliés derrière une ligne qui les résume (« aujourd'hui · Chantier ») : la toucher les
  déplie. Écrire / Lire, la tâche liée et ✨ IA restent sous le titre.
- Dans **Tâches**, les vues rapides (En retard, Aujourd'hui…) tiennent sur une rangée qui
  défile au doigt. Pour faire avancer une tâche sans glisser-déposer, touche son titre et
  choisis son **Statut**.

La vue n'est pas retenue au redémarrage. Les choix de panneaux faits sur ordinateur ne
changent pas.

Entre 640 et 900 px (tablette), les trois colonnes de tâches sont côte à côte dans la
carte Tâches ; en dessous, elles s'empilent.

Pour régler les barres latérales, **cliquer-glisser la poignée entre le journal et
le document, ou entre le document et les tâches**. La largeur change immédiatement
et reste mémorisée après redémarrage. Les champs de largeur au pixel près et **Largeurs par défaut**
sont dans **Paramètres → Affichage**. Au clavier, sélectionner une poignée avec Tab puis utiliser
les flèches gauche/droite (10 px, ou 50 px avec Maj) ; Début/Fin donnent les limites.
Sur une petite fenêtre, les colonnes se resserrent pour conserver la place du document.
Les poignées disparaissent lorsque les panneaux sont empilés ou masqués.

### Catégories et sous-catégories

Au bout des pastilles de projets, le bouton **Catégories** (l'étiquette) ouvre une fenêtre
par-dessus le contenu — sous le bouton sur ordinateur, depuis le bas sur téléphone — qui
réunit tout le classement, sans rangée de plus à l'écran :

- **filtrer** : **Toutes les catégories**, **Sans catégorie**, ou une catégorie de l'arbre ;
  le choix referme la fenêtre et le bouton du bandeau affiche la catégorie filtrée, dans sa
  couleur ;
- **Regrouper par catégorie** ;
- **ranger** : **＋ Catégorie** crée un classement, **＋** ajoute une sous-catégorie, **✎**
  renomme, recolore ou change de parent dans le même projet, **✕** supprime. À la souris, ces
  boutons apparaissent au survol d'une ligne (ou au clavier). Chaque ligne compte ses entrées
  et ses tâches ouvertes, sous-catégories comprises. Dans **Tout**, les arbres sont présentés
  par projet et le formulaire demande le projet.

Le formulaire reste en tête, même quand l'arbre est long. **Entrée** enregistre ; **Échap**
annule le formulaire, puis ferme la fenêtre au second appui, et le focus revient au bouton
d'où l'on venait.

Choisir une catégorie filtre ensemble le journal, les tâches et les procédures,
**sous-catégories comprises**. La recherche et les vues rapides des tâches restent
cumulables. **Toutes les catégories** enlève ce filtre ; **Sans catégorie** retrouve ce qui
reste à ranger. Changer de projet lève le filtre de catégorie.

Le sélecteur **Catégorie de l’entrée** et celui de l'édition d'une tâche permettent de
classer les éléments existants. Leur chemin apparaît sur les cartes. Une nouvelle entrée,
procédure ou tâche reprend la catégorie filtrée ; une création liée reprend celle de sa
source. **Regrouper par catégorie** rassemble les listes par chemin de catégorie ; les
tâches gardent leurs colonnes À faire / En cours / Terminé et leur glisser-déposer.

Lier une entrée déjà classée à une tâche sans catégorie remplit aussi la catégorie de la
tâche, si elle appartient au même projet. Classer une entrée déjà liée fait de même.
Une tâche déjà classée garde son choix ; plusieurs catégories différentes parmi ses
entrées liées laissent une tâche libre sans catégorie. Pendant l'édition d'une tâche, le
sélecteur **Catégorie de la tâche** se met à jour dès que le document est lié ; un choix fait
à la main dans ce sélecteur reste prioritaire. Au premier démarrage de cette version, les
anciennes associations non ambiguës sont également rattrapées une seule fois.

Supprimer une catégorie demande confirmation : son contenu et ses sous-catégories remontent
dans son parent, ou deviennent sans catégorie à la racine. Les notes et tâches sont conservées.
Les catégories sont disponibles sur mobile hors ligne et suivent les sauvegardes et la
synchronisation Drive. Les anciennes sauvegardes reviennent sans catégorie.

## Écrire une entrée

1. **+ Nouvelle entrée** — elle est créée à la date du jour, le curseur est dans le titre.
2. Taper le titre, puis basculer sur **Écrire** : le texte à gauche, l'aperçu à droite (colonne
   étroite : le texte seul, **Lire** montre l'aperçu). La zone grandit avec le texte.
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
Un document archivé ne s'ouvre jamais tout seul, même en changeant de projet : il faut
aller le chercher dans les Archives, et il s'affiche alors sous le bandeau
« Document archivé ».

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
- **Avancer** : glisser la carte d'une colonne à l'autre (À faire → En cours → Terminé), ou,
  sans souris (téléphone, clavier), cliquer son titre et choisir son **Statut** : la carte va
  au bas de sa nouvelle colonne.
- **▶ Mettre en cours** : le bouton avant ★ met la tâche en cours d'un clic (elle va au bas
  de la colonne En cours) ; allumé, il dit qu'elle y est, et recliquer la remet à faire — au
  bas de À faire, pas à sa place d'avant. Une tâche terminée n'a pas de ▶ : la case la rouvre.
- **« Tout » avec plusieurs projets** : le panneau ne montre plus trois colonnes mêlées mais
  **une seule liste rangée** « À faire · En cours » — en cours d'abord, puis les retards, les
  épinglées, la priorité, l'échéance la plus proche, enfin l'ordre des colonnes. Chaque carte
  dit son projet dans sa couleur et « En cours » quand c'est le cas ; Terminé reste repliée
  dessous. Pas de glisser-déposer dans cette liste : pour ranger à la main, filtrer le projet
  (ses colonnes reviennent).
- **✨ IA › Prioriser les tâches** (menu en tête du panneau) envoie au service IA réglé dans
  ⚙ Paramètres les tâches ouvertes du filtre — titre, projet, statut, priorité, échéance,
  épingle, nombre de documents liés, date de création — et les repères IA des projets, jamais
  un contenu, soixante tâches au plus. Il propose une priorité et une raison par tâche : la
  liste se range selon les priorités proposées, chaque carte concernée porte « ✨ Haute
  proposée » en pointillés et sa raison. **Appliquer** enregistre les seules priorités qui
  changent ; **Ignorer**, changer de projet ou de catégorie n'écrit rien ; **Arrêter** coupe
  la demande. L'IA ne touche ni statut, ni échéance, ni épingle, ni ordre à la main.
- **Vue d'ensemble** (bouton en tête du panneau) ouvre au centre, à la place de l'entrée,
  l'avancement de chaque projet, à la manière d'un git dont l'historique est replié : une voie
  par projet dans sa couleur, une pastille qui compte les terminées, un nœud par tâche ouverte
  (douze au plus, puis « +N ») — plein pour celle en cours, creux pour À faire, bord rouge en
  retard, anneau ambré si épinglée —, « En cours : … » sous le trait, la barre d'avancement et
  « 4/10 · 40 % », la dernière note sous le nom. L'ouvrir lève projet, catégorie et recherche.
  Cliquer un nom filtre ce projet ; cliquer un nœud mène à sa carte dans le panneau Tâches ;
  **Fermer**, ouvrir une entrée ou choisir un projet rendent le centre. Sur téléphone, elle
  s'ouvre dans la vue Écriture et un nœud ramène aux Tâches. Rien n'est retenu au redémarrage.
- **Terminer** : cocher la case. Le titre se barre et la carte rejoint Terminé.
- **Modifier** : cliquer sur le titre ouvre le nom, l'échéance et la priorité. `Entrée` valide, `Échap` annule.
- **Priorité** : chaque carte affiche sa pastille — Basse, Normale ou Haute (▲ rouge). Elle ne réordonne pas la colonne : l'ordre reste celui du glisser-déposer.
- **★** met la tâche en avant (liseré ambré à gauche), indépendamment de sa priorité. Sur
  un écran avec souris, ★ et ✕, le pied de carte (**＋ Documents**, **＋ Entrée liée**,
  **✨ IA**) et le ✕ qui retire un document lié n'apparaissent qu'au survol de la carte (ou au
  clavier) ; leur place reste réservée, rien ne bouge. L'épingle posée reste toujours visible.
  Au doigt, tout reste affiché.
- Les documents liés tiennent sur une ligne chacun ; leur origine (locale ou Google) et leur
  date sont dans l'infobulle.
- Une échéance dépassée s'affiche en rouge, et le compteur « en retard » apparaît en haut.
- **Vues rapides** : sous « Nouvelle tâche… », des pastilles comptent ce qui réclame
  l'attention — **En retard**, **Aujourd'hui** (échéance du jour), **En cours**, **Épinglées**,
  **▲ Haute** (priorité haute). Une tâche terminée n'entre dans aucune vue. Un clic n'affiche
  que ces tâches, dans leurs colonnes ; recliquer ou **Toutes** rend la colonne entière.
  Une pastille à zéro ne s'affiche pas. La vue se combine avec le projet et la recherche ;
  ajouter une tâche la lève, pour voir la nouvelle arriver. Elle n'est pas retenue au
  redémarrage.
- Sur grand écran, « N en cours » et « N en retard » de l'en-tête sont cliquables : ils
  ouvrent le panneau Tâches sur la vue correspondante. Ces compteurs portent sur toute la
  base ; si le projet filtré ou la recherche en cachent une partie, ils sont levés.
- **Créer une tâche liée** depuis l’entrée ouverte préremplit son titre et permet d’ajouter une échéance. La tâche apparaît directement dans le panneau de droite avec cette entrée comme contexte. Dans une note locale, **✨ IA › Suggérer des tâches avec l’IA** propose aussi des tâches à partir du brouillon ; elles restent à relire avant création (voir « Assistance IA »).
- Dans le panneau **Tâches**, la colonne des tâches terminées est repliée au départ. **Afficher les tâches terminées** la déplie ; **Masquer les tâches terminées** la replie sans les supprimer.
- **Relier un document** ouvre la liste des entrées disponibles. Choisir une entrée locale ou un onglet Google puis cliquer sur **Relier** ; chaque document lié reste visible sur la carte avec son origine.
- Cliquer sur le titre d'un document lié l'ouvre au centre. Le bouton ✕ retire seulement l'association, sans supprimer le document. Une même entrée peut fournir le contexte de plusieurs tâches.
- **✨ IA › Créer une procédure** (pied de carte) fait rédiger par l'IA une procédure à partir de la tâche et de ses documents liés, à relire avant de la créer — voir « Procédures ».
- **✨ IA › Trouver la doc** (pied de carte) retrouve la note, la procédure ou le fichier du dossier partagé qui aide à faire la tâche. L'IA réglée dans ⚙ Paramètres reçoit le titre et le statut de la tâche, son projet (nom, contexte IA du projet, vocabulaire) et les **titres** de ses documents liés — jamais un contenu — et propose au plus six mots. WorkLogs les cherche dans les titres et le texte de **toutes** les notes et procédures (tous projets, archives comprises) et dans les **noms** des fichiers du dossier partagé (sur le téléphone, par le relais du bureau). « Documents trouvés » liste, dans la carte, au plus huit documents : leur type (Procédure, Note, Partage), leur projet s'il n'est pas celui de la tâche ou leur dossier, et les mots qui les ont trouvés ; les documents déjà liés n'y reviennent pas. **Ouvrir** affiche le document au centre (le filtre passe à son projet) ; **Lier** l'associe à la tâche, comme « ＋ Documents ». Sans dossier partagé (non réglé, relais injoignable), la recherche se fait dans WorkLogs seulement et la liste le dit.

## Assistance IA

Dans **⚙ Paramètres → Assistance IA**, renseigner le profil métier général et,
facultativement, le **Contexte IA du projet** : objectif, environnement, contraintes et
termes utiles. Chaque fiche est conservée **sur cet appareil uniquement**.

Un clic d'assistance lit aussi des documents locaux du même projet : documents liés
d'abord, puis notes et procédures dont le titre ou l'extrait correspond au sujet et au
texte en cours. Les tâches voisines pertinentes sont privilégiées. Cette recherche est
locale ; au plus trois extraits de 2 000 caractères accompagnent la demande. Le contenu des
documents Google et des pièces jointes n'est pas transmis. Pour tirer une procédure
d'une tâche, ses cinq documents liés restent les sources principales, même d'un autre projet.
Dans le partage, le contexte local accompagne le fichier seulement si un projet est
sélectionné ; **Tout** n'ajoute aucun document local au fichier.

Les actions IA sont rangées sous un seul bouton, **✨ IA**, au bout de la rangée d'actions
d'une note, d'une procédure ou d'un fichier du partage, et au pied de chaque carte de tâche.
Il n'apparaît que si une action est possible (jamais sur un document Google). Le menu
s'ouvre au clic ou au clavier (flèches, Entrée, Échap) ; pendant la demande, le bouton
affiche l'attente (« ✨ Rédaction… », animé, avec les secondes passé trois), une place « L'IA
rédige… » montre où la proposition va venir (une proposition rafraîchie s'estompe), et **Arrêter**, juste à côté, la coupe
aussitôt : rien n'est appliqué, aucun autre modèle n'est essayé, et l'on peut relancer. Dans
une carte de tâche, le formulaire « ＋ Entrée liée » et la procédure proposée portent leur
propre **Arrêter**. Quitter la note ou le fichier coupe aussi la demande en cours. Le survol
d'une action dit ce qui part au service IA. **✨ Suggérer** du formulaire « ＋ Entrée liée »
reste à côté de sa zone de sous-tâches, qu'il remplit. Dans une note, la suggestion de
tâches est rangée dans ce même menu **✨ IA**.

**Contexte utilisé par l'IA** apparaît après la première demande : déplier pour lire
les extraits et décocher une source pour les demandes suivantes. Une modification de
sélection retire les propositions en attente issues de l'ancienne sélection. Une source
décochée ne contribue plus non plus au vocabulaire calculé depuis son titre.

**✨ IA › Compléter** rédige le document ouvert à partir de son titre et de ce qui est déjà
écrit : quelques points clés suffisent, l'IA en fait la note complète (phrases courtes ;
intertitres et cases « à faire » seulement si la note en a besoin). Tout ce qui est écrit
est gardé — commandes et valeurs à l'identique, cases cochées ou non — rien de prévu ne
devient « fait », et l'IA écrit « à préciser » plutôt que d'inventer un fait, une valeur,
une date ou un nom. Avec un titre seul, elle propose le plan de la note. Partent aussi le
contexte du projet, les titres des tâches liées et les noms des pièces jointes. La
proposition se relit : rien n'est écrit avant **Appliquer la note** (**Rafraîchir**
redemande, **Ignorer** abandonne). La même action complète une procédure et un fichier du
dossier partagé (voir « Procédures »). Pas de menu IA sur une note Google : son contenu
n'est jamais envoyé. Une note riche passe par le Markdown : appliquer remet à plat
surlignage, couleurs et alignements, et une case proposée y devient une puce.

Une **tâche** n'a pas de texte à compléter : sur sa carte, **＋ Entrée liée** (le titre
reprend la tâche), **Créer et ouvrir**, noter les points importants dans l'entrée, puis
**✨ IA › Compléter** — la demande connaît la tâche liée.

**Ajuster la proposition** précise ce qui est attendu : par exemple « Garde les commandes
exactement et détaille les vérifications ». **Affiner**, **Plus court** et **Pour un collègue**
demandent une nouvelle version, avec le texte d'origine et le brouillon précédent.
Corrections, notes et procédures restent à relire avant application ; dans le partage,
appliquer ne crée qu'un brouillon local, à envoyer avec **Enregistrer sur le partage**.

**✨ IA › Suggérer des tâches avec l’IA**, dans une note locale Markdown ou riche, propose
les actions écrites dans la note et peut aussi déduire une suite raisonnable. Le titre,
le brouillon et le contexte du projet partent au service IA configuré ; chaque proposition
est accompagnée d'un extrait exact de la note. Les déductions ne sont ni des faits accomplis
ni des engagements : vérifier les propositions avant de sélectionner et créer les tâches
liées. Chaque tâche reprend le projet et reste liée à la note, qui est conservée. L'IA propose
une priorité haute, normale ou basse :
les propositions sont présentées dans cet ordre et restent modifiables. Elle peut aussi
suggérer une échéance, même estimée, avec une courte explication ; la date actuelle locale et
la date de la note l'aident à interpréter le contexte. Pour cette suggestion, jusqu'à cinq
tâches ouvertes pertinentes du même projet accompagnent aussi la demande avec leur priorité
et leur échéance enregistrées ; elles sont visibles dans **Contexte utilisé par l'IA**. Elles
n'indiquent pas la disponibilité de l'utilisateur. Vérifier et corriger les dates, ou les
effacer : une estimation n'est pas un engagement. Sans priorité reconnue, « normale » est
retenue. Une échéance peut être explicite ou estimée ; vérifier, corriger ou effacer toute
date estimée avant création. Une création partiellement réussie garde les tâches déjà créées
pour permettre de réessayer les autres. Modifier le titre, le contenu ou la date de la note,
son projet ou les sources choisies demande de relancer la proposition. La suggestion requiert
une note non vide et ne lit pas les documents Google ni le contenu des pièces jointes.
À la création, parmi les tâches sélectionnées qui restent à créer, la plus prioritaire passe
en **En cours** ; en cas d'égalité, l'échéance la plus proche départage. Les autres sont
créées en **À faire**.

## Projets

Les pastilles en haut à gauche filtrent **le journal et les tâches en même temps** : un clic sur
« Chantier » et l'écran entier ne parle plus que de ce chantier. Recliquer enlève le filtre ; le dernier
projet sélectionné est retenu au prochain démarrage. Si le projet a été supprimé, WorkLogs revient à
« Tout ».

Changer de projet referme l'entrée et le fichier du partage ouverts au centre : les listes et le
document affiché parlent ainsi du même projet. « Tout » les garde, puisqu'ils y restent visibles.
Un fichier du partage avec un brouillon non envoyé pose d'abord sa question (Envoyer · Garder le
brouillon ici · Annuler) ; « Annuler » laisse le projet où il était.

Les documents associés restent le contexte d'une tâche même s'ils appartiennent à un autre projet.
Supprimer une entrée Google dans WorkLogs ne supprime jamais le fichier Google distant ; cela retire
seulement sa copie locale, y compris si le fichier est déjà absent ou dans la corbeille Drive.

Les pastilles tiennent sur **une seule rangée**, quel que soit le nombre de projets : elle
défile au pavé tactile ou à la molette, et la pastille du projet filtré prend sa couleur.

**Sur téléphone**, la rangée laisse place à un seul bouton qui nomme le projet courant dans sa
couleur (« Tous les projets » sans filtre). Le toucher ouvre, depuis le bas, la **liste de tous
les projets** avec leurs tâches ouvertes : toucher un nom le choisit et referme la liste.
**Retrouver un projet** (dès huit projets) filtre au fil des lettres ; Entrée prend le premier
trouvé. **Gérer les projets**, au pied de la liste, passe à la gestion décrite ci-dessous.

**Gérer les projets** (au bout de la rangée ; au pied de la liste sur téléphone) ouvre une fenêtre
par-dessus l'écran — sous le bouton sur ordinateur, depuis le bas sur téléphone — pour en
créer, les renommer (Entrée valide, Échap annule), changer leur couleur, les supprimer. Au-delà
de sept projets, **Retrouver un projet** filtre la liste. Supprimer un projet ne supprime
**rien** : les entrées et les tâches restent, simplement détachées.

## Procédures

Le bouton **Procédures** de l'en-tête affiche une sidebar dédiée, à droite des
tâches : elle rassemble les modes d'emploi du projet sélectionné avec leurs
pièces jointes. Une procédure est un document comme un autre (même éditeur,
mêmes fichiers, mêmes sauvegardes), simplement aiguillé ici par son type.
**Nouvelle procédure** en crée une déjà rattachée au projet filtré ; chaque ligne
a son **＋ Fichier** pour joindre sans ouvrir l'éditeur ; cliquer son titre
l'ouvre au centre **en lecture**, **Modifier** l'ouvre **en écriture** ; cliquer un
fichier ouvre son aperçu, où **Télécharger** reste disponible. Chaque fichier porte le
pictogramme de son type (W, X, PDF, IMG…) et une pastille qui dit où il est (`local seul`,
`☁ Drive`). Sans filtre, toutes les
procédures s'y retrouvent, pastille projet à l'appui. Les procédures ne
figurent **pas** dans le journal (seulement dans ses archives une fois archivées,
pour pouvoir les restaurer). Comme les autres panneaux, la sidebar est toujours
dépliée quand elle est affichée, se masque par son bouton et l'état est retenu.
Une procédure affichée au centre — ouverte depuis une tâche, « Trouver la doc », la
recherche ou au changement de projet — **déplie la sidebar** et y est surlignée : on voit
d'où elle vient. La masquer ensuite tient tant que la même procédure reste ouverte ; une
procédure archivée, absente de la sidebar, ne la déplie pas.

Comme une entrée, une procédure a ses modes **Écrire** / **Lire**. Lire montre le
document seul, sans barre d'outils ni risque de le modifier en le suivant (les liens
s'ouvrent d'un clic) ; Écrire rend la barre de mise en forme. Une procédure neuve
s'ouvre en écriture ; une procédure liée à Google Docs garde son éditeur Google.

**Bloc de code** dans une procédure : cliquer **`{ }`** dans la barre puis coller ou
taper la commande, ou taper ` ``` ` puis Entrée en début de ligne. Des lignes déjà
collées : les sélectionner puis **`{ }`** — elles forment un seul bloc.

**✨ IA › Compléter** (clé IA collée dans Paramètres) propose une procédure
**concise** à partir du titre et de ce qui est déjà écrit : une phrase d'objectif, des
étapes d'une ligne (10 au plus), prérequis et vérification seulement s'il y en a. Ce que
tu as écrit est gardé — commandes et valeurs à l'identique — et l'IA écrit « à préciser »
plutôt que d'inventer une valeur. **✨ IA › Mettre en page** corrige les fautes et range les
étapes en liste numérotée. Dans les deux cas, la proposition se relit d'abord :
**Appliquer**, **Rafraîchir** (nouvelle proposition) ou **Ignorer**. Rien ne part sans
clic. Les mêmes actions existent pour les fichiers du dossier partagé (ci-dessous).

**Tirer une procédure de son travail, avec l'IA.** Dans une entrée du journal,
**✨ IA › Créer une procédure**, et de même au pied d'une carte de tâche. L'IA (le service
réglé dans ⚙ Paramètres, Gemini par défaut) lit l'entrée — ou la tâche et ses documents
liés — et rédige un mode opératoire concis, comme ci-dessus : un titre, l'objectif, des
étapes d'une ligne (10 au plus), prérequis et vérification seulement s'il y en a ;
« à préciser » là où la source ne dit rien. La proposition se relit sur place : corriger
le titre si besoin, puis **Créer la procédure** (ou **Rafraîchir**, ou **Ignorer**). Rien
n'est créé avant. La procédure rejoint le projet de sa source et s'ouvre en lecture ;
l'entrée et la tâche ne changent pas, et la procédure ne leur est pas liée — terminer la
tâche ne l'archive donc pas. Un document Google n'est jamais envoyé à l'IA : pas de bouton
sur lui, et depuis une tâche, seul son titre part.

## Dossier partagé (le dossier du TSE)

Sous les procédures, la section **Dossier partagé** montre le dossier de l'équipe, celui du
TSE, en arbre : dossiers à onglet, fichiers avec le même pictogramme de type que les pièces
jointes ; un fichier que WorkLogs n'ouvre pas lui-même reste grisé. Sur le desktop, tape son **adresse comme sous Windows** — `\\serveur\partage` (ou
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
  « objet conservé » (les images se voient) : ils repartent tels quels, modifiables dans Word
  (« Ouvrir avec… »). **Image** (ou coller une capture d'écran) insère une image PNG, JPEG ou
  GIF à la place du curseur, réduite à la largeur de la page.
- Une **image** du partage (PNG, JPEG, GIF, WebP…) se voit sur place, en lecture seule.
  Seuls les paragraphes que tu as touchés sont réécrits ; le reste du fichier (styles,
  en-têtes, numérotation, images) ne change pas d'un octet. Un document en suivi des
  modifications s'ouvre en lecture seule.
- **✨ IA › Compléter** et **Mettre en page** marchent aussi sur un document Word,
  une note `.md` ou un texte `.txt` du partage, comme pour les procédures du journal : le
  titre du document (sinon le nom du fichier) et son contenu partent au service IA des
  Paramètres, la proposition se relit, puis **Appliquer** en fait ton **brouillon** — rien
  ne part sur le partage avant **Enregistrer sur le partage**. Dans un document Word, les
  images, tableaux et sommaires restent ceux du fichier (une proposition qui en perdrait un
  est refusée), un paragraphe que l'IA n'a pas changé reste tel quel, et un paragraphe neuf
  prend les styles du document (Titre 2, liste numérotée…). ↶ annule l'application.
  Inactifs quand le fichier est ouvert par un collègue.
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
  partage : la section n'affiche plus que lui. **Délier** rend tout le partage. Le lien est
  enregistré **sur le projet** et suit par Drive : relié sur le PC, il l'est aussi sur le
  téléphone (et inversement).
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
- **＋ Depuis une procédure…** envoie une procédure locale (celle hors du partage, de la
  colonne Procédures) vers le TSE, dans le dossier choisi (la racine, ou un dossier déplié —
  le même « Dans » que ci-dessus). **Format au choix** : Document Word (`.docx`, par défaut),
  Note Markdown (`.md`) ou Texte (`.txt`) ; le Word reprend le titre en Titre 1, les sections,
  les puces et les numéros écrits, lisible dans Word comme dans l'éditeur WorkLogs. Créé tout
  de suite sur le partage, ouvert au centre ; un nom déjà pris est refusé, rien n'est écrasé.
  Copie par défaut ; cocher **« Supprimer la procédure locale après l'envoi »** en fait un
  déplacement. Seul le texte part — les pièces jointes restent sur la procédure d'origine.
- **Supprimer** : la ✕ de l'arbre, ou **Supprimer du partage** dans l'éditeur, retire le
  fichier du partage aussitôt, pour toute l'équipe (avec confirmation). Rien n'est
  supprimé sans avoir été vu : si un collègue a enregistré le fichier depuis ta dernière
  lecture, WorkLogs refuse et te fait rouvrir le fichier ; avec un brouillon non envoyé,
  un envoi en attente, un conflit ou un fichier ouvert par un collègue, il le dit et ne
  supprime rien. L'historique gardé sur cet ordinateur reste.
- **Dossiers** : **＋ Nouveau dossier…** crée un dossier dans la racine ou un dossier
  déplié ; il s'ouvre aussitôt, et **＋ Nouveau fichier…** y crée le fichier suivant. Le
  bouton **⋯** d'un dossier propose :
  - **Renommer** : le nom se change dans la ligne (Entrée valide, Échap annule). Rien n'est
    remplacé : un nom déjà pris est refusé. Ce que WorkLogs garde du dossier le suit
    (historique, projet relié, fichier ouvert au centre). Refusé tant qu'un fichier du
    dossier a un brouillon non envoyé, un envoi en attente ou un conflit, ou qu'un collègue
    l'a ouvert (Word, Excel, LibreOffice, un autre WorkLogs) — WorkLogs dit lequel.
  - **Supprimer…** : WorkLogs fait d'abord le bilan, puis demande « Supprimer le dossier
    « Archives » et tout son contenu (12 fichiers et 2 sous-dossiers) ? ». Seul ce
    contenu-là part : si quelque chose a changé ou est arrivé entre-temps, rien n'est
    supprimé (ou la suppression s'arrête et dit ce qui est déjà parti). Chaque fichier
    supprimé reste gardé sur cet ordinateur. Mêmes refus que pour renommer ; un dossier
    qui contient un lien, un dossier caché, plus de 300 fichiers ou 100 dossiers, ou plus
    de 200 Mo, se supprime depuis Windows.
- **Hors ligne**, l'arbre reste celui que tu as vu en dernier (« Hors ligne — liste vue à
  10h42 ») : les fichiers gardés sur cet ordinateur s'ouvrent, les autres sont grisés. La
  recherche cherche alors dans ces listes.

Limite à connaître : Word et Excel **ne voient pas** que tu modifies un fichier dans
WorkLogs (ils ignorent les verrous des autres applications). Rien n'est perdu pour autant :
si un collègue enregistre avant toi, ton envoi te demande quoi faire.

**Sur le téléphone (PWA)**, le dossier des procédures passe par le **relais du bureau** (la VM,
jointe par Tailscale) : Paramètres › Dossier partagé du TSE, l'adresse du relais, sans code
(installation : `docs/09-RELAIS.md`). Ensuite tout est pareil : lire, modifier, créer,
envoyer, conflits. Tailscale doit être allumé sur le téléphone. L'adresse est gardée dans le
compte Google : connecté, un téléphone qui l'a perdue la retrouve tout seul.

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
Un document qui n'y est pas encore — partagé avec toi, ou créé hors de WorkLogs : **Autoriser
d'autres documents** ouvre le sélecteur Google dans le navigateur ; choisis-en un ou plusieurs,
puis **Actualiser**.
**Ouvrir** bascule le filtre sur le projet du document, comme une carte de tâche ; le journal
et le document affiché parlent alors du même projet.

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
