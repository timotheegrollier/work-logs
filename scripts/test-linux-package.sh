#!/usr/bin/env bash
# Installation dans une distribution jetable, puis mêmes tests que le desktop source.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${1:?image Docker requise}"
format="${2:?format deb ou rpm requis}"
[[ "$format" == deb || "$format" == rpm ]] || exit 2
node_root="$(dirname "$(dirname "$(command -v node)")")"
mkdir -p test-results/packages
docker run --rm --init -i \
  -v "$PWD:/source:ro" -v "$PWD/release:/packages:ro" \
  -v "$node_root:/node:ro" -v "$PWD/test-results/packages:/results" \
  -e FORMAT="$format" "$image" bash -s <<'CONTAINER'
set -euo pipefail
export PATH="/node/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive
if [[ "$FORMAT" == deb ]]; then
  apt-get update
  apt-get install -y ca-certificates xvfb xauth /packages/*.deb
else
  dnf install -y ca-certificates xorg-x11-server-Xvfb /packages/*.rpm
fi
mkdir -p /work/desktop
cp /source/package.json /source/package-lock.json /source/playwright.desktop.config.ts /work/
cp -r /source/desktop/e2e /work/desktop/
cd /work
npm ci --ignore-scripts --no-audit --no-fund
Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp &
export DISPLAY=:99 WORKLOGS_TEST_NO_SANDBOX=1
for i in {1..50}; do [[ -S /tmp/.X11-unix/X99 ]] && break; sleep 0.1; done
trap 'cp -r test-results playwright-report /results/ 2>/dev/null || true' EXIT
WORKLOGS_EXECUTABLE=/opt/WorkLogs/worklogs npm run test:desktop
cp /packages/*.AppImage /work/WorkLogs.AppImage
chmod +x /work/WorkLogs.AppImage
./WorkLogs.AppImage --appimage-extract > /dev/null
WORKLOGS_EXECUTABLE=/work/squashfs-root/AppRun npm run test:desktop
CONTAINER
