#!/usr/bin/env bash
# Recette : health API + stats + tsc + build web.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== API :8410 =="
curl -sf -m 5 http://localhost:8410/api/health; echo
echo "== stats =="
curl -sf -m 5 http://localhost:8410/api/stats; echo
echo "== web tsc =="
(cd web && npx tsc -b)
echo "== web build =="
npm --prefix web run build 2>&1 | tail -n 6
echo "== rappel =="
echo "UI : http://localhost:8411 — tester ajout rapide, drag kanban, check todo."
echo "CHECK OK"
