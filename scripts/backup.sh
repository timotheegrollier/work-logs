#!/usr/bin/env bash
# Sauvegarde DB (VACUUM INTO, base en ligne) + uploads horodatés.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:-$HOME/WorkLogs-backups}/worklogs-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
python3 -c "import sqlite3;sqlite3.connect('api/data/worklogs.db').execute(\"VACUUM INTO '$DEST/worklogs.db'\")"
cp -r api/data/uploads "$DEST/uploads"
echo "Backup -> $DEST"
ls -la "$DEST"
