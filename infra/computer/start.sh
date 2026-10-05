#!/bin/sh
set -eu
test -n "${BOTSPACE_COMPUTER_TOKEN:-}" || { echo 'Computer authentication is not configured' >&2; exit 1; }
mkdir -p /workspace /state
# Chromium runs within the Cloudflare VM trust boundary. Do not reuse this image
# as a multi-tenant host: shell access and desktop access share the same computer.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp > /state/xvfb.log 2>&1 &
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if DISPLAY=:99 xdotool getdisplaygeometry >/dev/null 2>&1; then break; fi
  sleep 0.2
done
openbox > /state/openbox.log 2>&1 &
exec python3 /opt/botspace/server.py
