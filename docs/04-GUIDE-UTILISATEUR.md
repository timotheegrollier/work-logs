# 📖 WorkLogs — 04 Guide utilisateur (Timo)

## Accès
Ouvre **http://localhost:8411**. Si la page dit « API injoignable », lance dans un terminal :
```bash
cd /home/timo/WorkLogs && npm run dev
```

## Les 7 espaces (sidebar)
| Onglet | À quoi ça sert | Gestes clés |
|---|---|---|
| 🏠 Dashboard | Vue matin : compteurs, ajout éclair, alertes | Tape une tâche + Entrée dans « Ajout rapide » |
| 📋 Kanban | Suivi Trello/Jira : À faire → En cours → Revue → Terminé | **Glisser-déposer** les cartes ; filtres projet/priorité/recherche ; clic = fiche détail (modifier / terminer / supprimer) ; `+ Tâche` ou `+ Ajouter` par colonne |
| ✓ Todos | Inbox zéro-friction | Entrée pour ajouter (+ échéance optionnelle) ; cocher = terminé ; ✕ = supprimer |
| 📅 Agenda | Événements 7 jours + liste 30 j | `+ Événement` (titre, début/fin, projet, description) ; ✕ pour annuler |
| 📝 Docs | Notes Markdown (comptes-rendus, specs) | `+ Doc`, éditeur à gauche (Markdown), aperçu à droite ; lier à un projet |
| 📎 Fichiers | Drive local | Choisir projet/tâche **avant** d'uploader pour lier ; clic = télécharger ; ✕ = supprimer |
| 📁 Projets | Référentiel | Créer `Nom + Clé` (ex. `Maison / MAISON`) ; compteur de tâches ouvertes ; suppression = détache les tâches (pas de perte) |

## Typologie Jira (champ « Type » des tâches)
`✓ Tâche` (courant) · `🐞 Bug` (anomalie) · `★ Story` (besoin utilisateur) · `⚡ Epic` (gros chantier à découper) · `↳ Sous-tâche` (lier via futur `parent_id` en V2).
Priorités : 🟢 Basse · 🔵 Moyenne · 🟠 Haute · 🔴 Urgente (bordure orange/rouge sur le kanban + compteur dashboard).

## Rituel conseillé (5 min / jour)
1. **Dashboard** : regarder En retard + Urgentes + Agenda 7j.
2. **Todos** : vider l'inbox (typer, dater, ou supprimer).
3. **Kanban** : avancer 1 carte (`En cours` ≤ 3 cartes), glisser ce qui est fini en `Terminé`.
4. **Agenda** : caler demain (1 event = 1 intention).

## Recherche globale (barre du haut)
≥ 2 lettres → top 5 tâches/docs/events. Bouton « Voir kanban » pour basculer.

## Sauvegarde
```bash
./scripts/backup.sh            # → ~/WorkLogs-backups/worklogs-AAAAMMJJ-HHMMSS/
```
Base + uploads copiés. À faire avant toute manip risquée (ou chaque vendredi 😉).

## Limites V1 (assumées)
Pas de compte/multi-user, pas de rappel sonore, pas de sync Google/CalDAV, pas d'appli mobile, recherche simple (pas full-text), Markdown basique (titres/gras/listes/code). → Voir `05-ROADMAP-V2.md` pour la suite.
