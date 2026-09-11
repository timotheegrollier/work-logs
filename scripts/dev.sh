#!/usr/bin/env bash
# Lance API :8410 + Web :8411 (concurrently). À exécuter depuis la racine.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run dev
