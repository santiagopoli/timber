# Same official Node image, pinned through Google's Docker Hub cache so shared
# CI runners do not depend on Docker Hub's anonymous pull allowance.
FROM mirror.gcr.io/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

COPY patch_wrangler_cli.py /opt/botspace/patch_wrangler_cli.py

# Versions of the image and application are fixed in git; Debian security updates
# are intentionally taken at build time. Publish and deploy an immutable digest.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 chromium xvfb xdotool xclip scrot openbox fonts-liberation \
    x11vnc python3-websockify xterm \
    ca-certificates curl git procps tini util-linux ripgrep jq patch python3-pip python3-venv \
    && npm install --global --no-audit --no-fund wrangler@4.147.0 \
    && chmod 0755 /opt/botspace/patch_wrangler_cli.py \
    && python3 /opt/botspace/patch_wrangler_cli.py --patch /usr/local/bin/wrangler \
    && groupadd --gid 10001 timber-shell \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin timber-shell \
    && groupadd --gid 10002 timber-deploy \
    && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin timber-deploy \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /state /opt/botspace \
    && chown root:timber-shell /workspace \
    && chmod 2770 /workspace \
    && chmod 0700 /state

COPY server.py /opt/botspace/server.py
COPY secure_deploy.py /opt/botspace/secure_deploy.py
COPY secure_deploy_runner.py /opt/botspace/secure_deploy_runner.py
COPY workspace_archive.py /opt/botspace/workspace_archive.py
COPY start.sh /opt/botspace/start.sh
COPY desktop_bridge.py /opt/botspace/desktop_bridge.py
# Includes the fresh-exec per-session Linux subreaper helper (--supervisor).
COPY shell_bridge.py /opt/botspace/shell_bridge.py
COPY smoke_shell.py /opt/botspace/smoke_shell.py
COPY workspace.py /opt/botspace/workspace.py
RUN chmod 755 /opt/botspace/start.sh /opt/botspace/server.py /opt/botspace/secure_deploy.py \
    && chmod 644 /opt/botspace/shell_bridge.py \
    && chmod 755 /opt/botspace/patch_wrangler_cli.py \
    && chmod 755 /opt/botspace/secure_deploy_runner.py /opt/botspace/workspace_archive.py \
    && chown -R root:root /opt/botspace \
    && chmod 0755 /opt/botspace
RUN mkdir -p /opt/timber-secure \
    && chown root:root /opt/timber-secure \
    && chmod 0755 /opt/timber-secure \
    && ln -s /dev/null /opt/timber-secure/wrangler.log
ENV DISPLAY=:99 PYTHONUNBUFFERED=1 BOTSPACE_WORKSPACE=/workspace BOTSPACE_STATE=/state
# Control (8080) and shell (6082) remain private container ports.
# EXPOSE is metadata, not an instruction to publish them.
EXPOSE 8080 6080 6081 6082
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/botspace/start.sh"]
