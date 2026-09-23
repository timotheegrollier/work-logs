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
if [[ -n "${DISPLAY:-}" ]]; then
  npm run test:desktop
else
  xvfb-run -a npm run test:desktop
fi

echo
echo "CHECK OK — tout est vert."
