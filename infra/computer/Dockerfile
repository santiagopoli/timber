FROM node:24.14.0-bookworm-slim

# Versions of the image and application are fixed in git; Debian security updates
# are intentionally taken at build time. Publish and deploy an immutable digest.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 chromium xvfb xdotool xclip scrot openbox fonts-liberation \
    ca-certificates curl git procps tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /state /opt/botspace

COPY server.py /opt/botspace/server.py
COPY start.sh /opt/botspace/start.sh
RUN chmod 755 /opt/botspace/start.sh
ENV DISPLAY=:99 PYTHONUNBUFFERED=1 BOTSPACE_WORKSPACE=/workspace BOTSPACE_STATE=/state
EXPOSE 8080
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/botspace/start.sh"]
