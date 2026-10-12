#!/bin/sh
set -eu
test -n "${BOTSPACE_COMPUTER_TOKEN:-}" || { echo 'Computer authentication is not configured' >&2; exit 1; }
# Trusted Python controller and private desktop WebSocket bridges retain the
# per-computer management token. These fixed, root-owned programs are not
# workspace-controlled; model-controlled desktop/shell processes run unprivileged.
umask 002
mkdir -p /workspace /state
chown root:timber-shell /workspace
chmod 2770 /workspace
chown root:root /state
chmod 0700 /state
umask 077
# X server/window manager and all local desktop daemons run as the unprivileged
# workspace identity, with no inherited container credentials or capabilities.
setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-all --inh-caps=-all --no-new-privs -- env -i PATH=/usr/bin:/bin DISPLAY=:99 Xvfb :99 -screen 0 1280x800x24 -nolisten tcp > /state/xvfb.log 2>&1 &
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if DISPLAY=:99 xdotool getdisplaygeometry >/dev/null 2>&1; then break; fi
  sleep 0.2
done
setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-all --inh-caps=-all --no-new-privs -- env -i PATH=/usr/bin:/bin DISPLAY=:99 openbox > /state/openbox.log 2>&1 &
setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-all --inh-caps=-all --no-new-privs -- env -i PATH=/usr/bin:/bin DISPLAY=:99 x11vnc -display :99 -listen 127.0.0.1 -rfbport 5900 -forever -shared \
  -nopw -viewonly -nocursorshape -nocursorpos -cursor arrow -noxdamage \
  > /state/desktop-view.log 2>&1 &
setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-all --inh-caps=-all --no-new-privs -- env -i PATH=/usr/bin:/bin DISPLAY=:99 x11vnc -display :99 -listen 127.0.0.1 -rfbport 5901 -forever -shared \
  -nopw -nocursorshape -nocursorpos -cursor arrow -noxdamage \
  > /state/desktop-control.log 2>&1 &
# Bridge needs the management token to authenticate private WebSockets. It is a
# trusted root service with protected code, and never shares env/proc with UID10001.
python3 /opt/botspace/desktop_bridge.py view > /state/desktop-view-bridge.log 2>&1 &
python3 /opt/botspace/desktop_bridge.py control > /state/desktop-control-bridge.log 2>&1 &
# server.py embeds shell_bridge.py on private 6082 with one shared manager,
# so shell admission and checkpoint/restore exclusion are atomic. Its trusted
# root supervisor execs fixed setpriv ONLY in the native-forkpty child: bash runs
# UID/GID10001, no supplementary groups/capabilities, with no-new-privs.
exec python3 /opt/botspace/server.py
