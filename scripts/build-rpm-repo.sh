#!/usr/bin/env bash
# Construit le dépôt dnf (repodata) à partir des RPMs présents.
# Usage : build-rpm-repo.sh <dir-du-depot>
# Le dossier contient les *.rpm de toutes les versions gardées.
#
# Pas de delta RPMs : `makedeltarpm` ne sait pas lire les payloads produits par
# fpm (le backend qu'electron-builder utilise pour le .rpm) — « payload read
# failed » même entre deux builds identiques, alors que `rpm -K` les valide.
# Le dépôt apporte quand même l'essentiel : `dnf update worklogs`, sans
# navigateur ni réinstallation manuelle.
set -euo pipefail
repo="${1:?dossier du dépôt requis}"
count=$(ls "$repo"/*.rpm 2>/dev/null | wc -l)
[[ "$count" -ge 1 ]] || { echo "aucun RPM dans $repo"; exit 2; }
command -v createrepo_c >/dev/null || { echo "createrepo_c manquant"; exit 2; }
createrepo_c --update "$repo" >/dev/null
echo "Dépôt prêt : $count RPM(s) dans $repo"
