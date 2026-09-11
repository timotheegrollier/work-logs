#!/usr/bin/env bash
# Sauvegarde horodatée : base SQLite (copie à chaud) + fichiers joints.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:-$HOME/WorkLogs-backups}/worklogs-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
python3 -c "import sqlite3;sqlite3.connect('api/data/worklogs.db').execute(\"VACUUM INTO '$DEST/worklogs.db'\")"
cp -r api/data/uploads "$DEST/uploads"
echo "Sauvegarde -> $DEST"
