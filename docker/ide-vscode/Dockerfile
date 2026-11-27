# syntax=docker/dockerfile:1
# The VS Code session image (ADR-0080 §3): openvscode-server on the session
# base. The base brings the gate, the splash, the checkout and git; this adds
# the IDE and Studio's bridge.
#
# Build context: the repository root.
#   docker build -f docker/session-base/Dockerfile -t cf-studio-session-base:dev .
#   docker build -f docker/ide-vscode/Dockerfile -t cf-studio-vscode:dev .
# (docker/ide-vscode/build.sh does both.)
#
# openvscode-server (MIT) is the upstream VS Code server with open-vsx as its
# marketplace; no extension comes from Microsoft's marketplace. The release is
# pinned by version and checksum.
ARG SESSION_BASE=cf-studio-session-base:dev
FROM ${SESSION_BASE}

USER root
ARG OPENVSCODE_VERSION=1.109.5
ARG OPENVSCODE_SHA256=b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363
RUN curl -fsSL -o /tmp/openvscode-server.tar.gz \
      "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz" \
 && echo "${OPENVSCODE_SHA256}  /tmp/openvscode-server.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/openvscode-server \
 && tar -xzf /tmp/openvscode-server.tar.gz -C /opt/openvscode-server --strip-components=1 \
 && rm /tmp/openvscode-server.tar.gz

# Studio's bridge, as a built-in extension: the server scans its own
# extensions/ folder, so it is there for every window without an install.
# server.js in the same folder is the control API (started by studio-ide-start).
COPY docker/ide-vscode/studio-bridge /opt/openvscode-server/extensions/constructorfabric.studio-bridge
RUN rm -rf /opt/openvscode-server/extensions/constructorfabric.studio-bridge/test
COPY --chmod=755 docker/ide-vscode/studio-ide-start.sh /usr/local/bin/studio-ide-start

USER node
ENV STUDIO_IDE=vscode \
    STUDIO_IDE_CONTROL_PORT=3005 \
    STUDIO_IDE_VERSION=openvscode-server-${OPENVSCODE_VERSION}
