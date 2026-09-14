#!/usr/bin/env bash
# Construit le dépôt apt (index Packages + Release) à partir des .deb présents.
# Usage : build-deb-repo.sh <dir-du-depot>
# Pendant du dépôt dnf (`build-rpm-repo.sh`) : même idée, index plat.
#
# Dépôt « flat » (pas de dists/pool) : le fichier .list porte alors un `/` final
# et apt lit `Packages` à la racine. C'est le format le plus simple à servir sur
# GitHub Pages, qui ne fait que du statique.
#
# Pas de signature GPG (`[trusted=yes]` côté client) : même choix que le dépôt
# dnf (`gpgcheck=0`), usage personnel. La signature reste une piste.
set -euo pipefail
repo="${1:?dossier du dépôt requis}"
count=$(ls "$repo"/*.deb 2>/dev/null | wc -l)
[[ "$count" -ge 1 ]] || { echo "aucun .deb dans $repo"; exit 2; }
command -v dpkg-scanpackages >/dev/null || { echo "dpkg-scanpackages manquant (paquet dpkg-dev)"; exit 2; }

cd "$repo"
dpkg-scanpackages --multiversion . > Packages
gzip -9cn Packages > Packages.gz

# `Release` n'est pas optionnel : sans lui apt refuse le dépôt
# (« does not have a Release file »), y compris en trusted=yes.
{
  echo "Origin: WorkLogs"
  echo "Label: WorkLogs"
  echo "Suite: stable"
  echo "Codename: stable"
  echo "Architectures: amd64"
  echo "Components: main"
  echo "Date: $(date -Ru)"
  echo "MD5Sum:"
  for f in Packages Packages.gz; do
    printf ' %s %16d %s\n' "$(md5sum "$f" | cut -d' ' -f1)" "$(stat -c%s "$f")" "$f"
  done
  echo "SHA256:"
  for f in Packages Packages.gz; do
    printf ' %s %16d %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c%s "$f")" "$f"
  done
} > Release

echo "Dépôt prêt : $count paquet(s) .deb dans $repo"
