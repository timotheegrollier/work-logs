#!/usr/bin/env bash
# Stoppe les sessions screen wl-api / wl-web si présentes.
for s in wl-api wl-web; do
  if screen -ls 2>/dev/null | grep -q "\.$s"; then
    echo "stop $s"; screen -X -S "$s" quit
  else
    echo "$s : absent"
  fi
done
