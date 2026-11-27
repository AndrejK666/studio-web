# syntax=docker/dockerfile:1
# Session base (ADR-0080 §3): what every IDE image of a Studio session needs
# whatever the IDE is — node, git, the gate, the splash, the checkout and the
# git credential helper. An IDE image builds FROM this and adds one script,
# /usr/local/bin/studio-ide-start, that starts its IDE on 127.0.0.1:3004.
#
# Build context: the repository root. The scripts are the Theia image's own
# (theia/docker), copied or cut out of its entrypoint, so there is one copy:
#   docker build -f docker/session-base/Dockerfile -t cf-studio-session-base:dev .
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl procps openssh-client less \
 && rm -rf /var/lib/apt/lists/*

COPY docker/session-base/extract.mjs /usr/local/lib/studio-session-extract.mjs
COPY theia/docker/entrypoint.sh /tmp/theia-entrypoint.sh
RUN node /usr/local/lib/studio-session-extract.mjs /tmp/theia-entrypoint.sh /usr/local/lib/studio-session \
 && rm /tmp/theia-entrypoint.sh
COPY theia/docker/materialize-workspace.mjs /usr/local/lib/studio-materialize-workspace.mjs
COPY theia/docker/git-credentials.mjs /usr/local/lib/studio-git-credentials.mjs
COPY --chmod=755 docker/session-base/session-entrypoint.sh /usr/local/bin/studio-session-entrypoint

RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV STUDIO_GIT_MODE=disabled \
    STUDIO_DATA_DIR=/home/node/.studio-data
EXPOSE 3003
ENTRYPOINT ["/usr/local/bin/studio-session-entrypoint"]
