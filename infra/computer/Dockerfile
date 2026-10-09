# Same official Node image, pinned through Google's Docker Hub cache so shared
# CI runners do not depend on Docker Hub's anonymous pull allowance.
FROM mirror.gcr.io/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

# Versions of the image and application are fixed in git; Debian security updates
# are intentionally taken at build time. Publish and deploy an immutable digest.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 chromium xvfb xdotool xclip scrot openbox fonts-liberation \
    x11vnc python3-websockify xterm \
    ca-certificates curl git procps tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /state /opt/botspace

COPY server.py /opt/botspace/server.py
COPY start.sh /opt/botspace/start.sh
COPY desktop_bridge.py /opt/botspace/desktop_bridge.py
COPY workspace.py /opt/botspace/workspace.py
RUN chmod 755 /opt/botspace/start.sh
ENV DISPLAY=:99 PYTHONUNBUFFERED=1 BOTSPACE_WORKSPACE=/workspace BOTSPACE_STATE=/state
EXPOSE 8080 6080 6081
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/botspace/start.sh"]
