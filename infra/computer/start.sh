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
# These sockets are reachable only through the authenticated desktop bridges.
# The view-only server enforces observation even for a modified browser client.
# Bake the real X11 cursor into the framebuffer so observers see agent movement.
x11vnc -display :99 -listen 127.0.0.1 -rfbport 5900 -forever -shared \
  -nopw -viewonly -nocursorshape -nocursorpos -cursor arrow -noxdamage \
  > /state/desktop-view.log 2>&1 &
x11vnc -display :99 -listen 127.0.0.1 -rfbport 5901 -forever -shared \
  -nopw -nocursorshape -nocursorpos -cursor arrow -noxdamage \
  > /state/desktop-control.log 2>&1 &
python3 /opt/botspace/desktop_bridge.py view > /state/desktop-view-bridge.log 2>&1 &
python3 /opt/botspace/desktop_bridge.py control > /state/desktop-control-bridge.log 2>&1 &
exec python3 /opt/botspace/server.py
