# 🤝 WorkLogs — Fiche de relève agent (LIRE EN PREMIER)

> **Date de rédaction :** 2026-09-11 · **Version :** V1 fonctionnelle
> **Auteur :** Cline (agent précédent) · **Pour :** Timo + prochain agent
> **État :** ✅ App qui tourne en local, validée API + build web OK

## 1. C'est quoi ?
Cockpit perso 100% local fusionnant **Trello (kanban) + Jira (types/priorités/projets à clé) + TodoList (inbox) + Agenda + Drive/Docs (fichiers + notes Markdown)**.
Aucun cloud, aucune auth (mono-utilisateur local).

## 2. Où est le code ?
Racine : `/home/timo/WorkLogs` (vide au départ, tout a été scaffoldé le 2026-09-11).

```
WorkLogs/
├── README.md               ← accueil, démarrage 2 commandes
├── AGENTS.md               ← consignes pour agents (conventions, pièges)
├── package.json            ← scripts racine (concurrently)
├── docs/                   ← CE DOSSIER : toute la doc de relève
│   ├── 00-HANDOVER.md      ← ce fichier
│   ├── 01-ARCHITECTURE.md
│   ├── 02-API.md
│   ├── 03-GUIDE-DEV.md
│   ├── 04-GUIDE-UTILISATEUR.md
│   └── 05-ROADMAP-V2.md
├── scripts/                ← dev.sh, check.sh, backup.sh, stop.sh
├── api/                    ← backend Node+Express+SQLite
│   ├── src/db.js           ← schéma + seed
│   └── src/server.js       ← routes REST + uploads
└── web/                    ← frontend React+Vite+TS
    └── src/{App.tsx,lib.ts,pages/,components/}
```

## 3. État des services (au moment de la relève)
| Service | Port | Lancement | Vérif |
|---|---|---|---|
| API | 8410 | `screen -S wl-api` → `PORT=8410 node src/server.js` | `curl -s localhost:8410/api/health` → `{"ok":true,...}` |
| Web | 8411 | `screen -S wl-web` → `npm run dev` | `curl -s -o /dev/null -w %{http_code} localhost:8411/` → `200` |

> ⚠️ Les `screen` ne survivent pas au reboot. Relance via `npm run dev` (voir §5).

## 4. Données
- SQLite : `api/data/worklogs.db` (+ `-wal`, `-shm` en mode WAL) — **non versionné** (voir `.gitignore`).
- Uploads : `api/data/uploads/` — **non versionné** (sauf `.gitkeep`).
- Seed initial : 2 projets (`PERSO`, `PRO`), 5 tâches, 1 event, 1 doc — inséré une seule fois si table `projects` vide.

## 5. Reprise en 3 commandes (pour le prochain agent)
```bash
cd /home/timo/WorkLogs
npm run install:all        # racine + api + web (une seule fois)
npm run dev                # API :8410 + Web :8411 (concurrently)
# puis :
./scripts/check.sh         # health + stats + build web → tout doit être vert
```

Ouvrir http://localhost:8411, tester : ajout rapide dashboard → drag & drop kanban → check todo.

## 6. Ce qui a été validé le 2026-09-11
- [x] `tsc -b` web : 0 erreur · `vite build` : 25 modules, OK
- [x] CRUD tâche : POST → PATCH `/move` → PUT done → DELETE : OK
- [x] POST event / doc / upload + DELETE de nettoyage : OK
- [x] Stats finales : `total:5, overdue:1, urgent:3, upcomingEvents:1`
- [x] Bug trouvé+corrigé : INSERT tasks avec 12 `?` pour 13 colonnes (voir `03-GUIDE-DEV.md § Pièges`)

## 7. Check-list de prise en main (15 min)
1. Lire `AGENTS.md` (conventions + interdits).
2. Lire `01-ARCHITECTURE.md` (schéma DB + flux).
3. Lancer `./scripts/check.sh`, ouvrir l'UI.
4. Lire `05-ROADMAP-V2.md` et choisir le lot à implémenter.
5. Travailler par petits diffs, valider `tsc` + `curl` à chaque étape.

## 8. Contact / contexte machine
- OS : Linux Mint 22.3 (base Ubuntu Noble) · Node v24.13.0 · npm 11.6.2
- Ports réservés au projet : **8410 (API), 8411 (web)** — ne pas changer sans mettre à jour `web/vite.config.ts` + `README` + ce dossier.
- Pas de Docker pour WorkLogs (choix volontaire : zéro infra). Stacks Docker voisines (`murgat_management`) ignorées.
