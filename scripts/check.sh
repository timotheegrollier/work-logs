#!/usr/bin/env bash
# Recette complète avant de dire « c'est fini ».
# Types → tests API → tests front → build → tests navigateur.
# Sans argument : tout. `unit`, `browser` ou `desktop` : une seule partie, pour les jobs
# parallèles de la CI (§99). En local, c'est toujours la recette entière qui fait foi.
set -euo pipefail
cd "$(dirname "$0")/.."

PART="${1:-all}"
case "$PART" in
  all | unit | browser | desktop) ;;
  *) echo "Usage : $0 [unit|browser|desktop]" >&2; exit 2 ;;
esac
part() { [[ "$PART" == all || "$PART" == "$1" ]]; }

if part unit; then
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

echo "== tests mise à jour du relais de la VM =="
node --test relay/*.test.mjs

fi

# Les parcours navigateur et Electron servent tous deux `web/dist`.
if part browser || part desktop; then
echo "== build =="
npm run build
fi

if part browser; then
echo "== tests navigateur (playwright) =="
npx playwright test
fi

if part desktop; then
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

fi

echo
if [[ "$PART" == all ]]; then
  echo "CHECK OK — tout est vert."
else
  echo "CHECK OK — partie $PART verte."
fi
