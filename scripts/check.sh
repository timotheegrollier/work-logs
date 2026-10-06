#!/usr/bin/env bash
# Recette complète avant de dire « c'est fini ».
# Types → tests API → tests front → build → tests navigateur.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== types =="
npm --prefix web run typecheck
npm run typecheck:desktop

echo "== tests API (node:test) =="
npm run test:api

echo "== tests front (vitest) =="
npm run test:web

echo "== tests serveur desktop =="
npm run test:desktop:unit

echo "== tests scripts release =="
node --test scripts/*.test.mjs

echo "== tests relais Google de la PWA (Worker) =="
node --test oauth-proxy/*.test.mjs

echo "== build =="
npm run build

echo "== tests navigateur (playwright) =="
npx playwright test

echo "== tests application desktop =="
# Écran virtuel avec un gestionnaire de fenêtres quand c'est possible : sur l'écran réel,
# une touche frappée pendant la campagne arrive dans la fenêtre de test (« Timoe » au lieu
# de « Timo », constaté le 2026-10-06), et le focus suit l'utilisateur. Sans gestionnaire
# de fenêtres, Xvfb ne sait pas maximiser une fenêtre : on garde alors l'écran réel.
WM="$(command -v metacity || command -v muffin || true)"
if command -v xvfb-run >/dev/null && [[ -n "$WM" ]]; then
  env -u DISPLAY -u WAYLAND_DISPLAY xvfb-run -a -s "-screen 0 1920x1080x24" \
    bash -c '"$0" --display="$DISPLAY" >/dev/null 2>&1 & wm=$!; sleep 1.5; npm run test:desktop; code=$?; kill "$wm" 2>/dev/null; exit "$code"' "$WM"
elif [[ -n "${DISPLAY:-}" ]]; then
  npm run test:desktop
else
  xvfb-run -a npm run test:desktop
fi

echo
echo "CHECK OK — tout est vert."
