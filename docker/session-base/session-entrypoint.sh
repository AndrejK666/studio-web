#!/bin/bash
# The session's IDE-neutral start (ADR-0080 §1, §3): splash, git, checkout,
# gate; then the IDE the image brings, `studio-ide-start`.
#
# Every step is a fragment of theia/docker/entrypoint.sh, copied out at build
# time (extract.mjs) — the same code the Theia image runs, in the same order.
set -euo pipefail

WORKSPACE=/workspace
LIB=/usr/local/lib/studio-session
export STUDIO_DATA_DIR="${STUDIO_DATA_DIR:-$HOME/.studio-data}"
mkdir -p "$STUDIO_DATA_DIR" "$WORKSPACE"
export GIT_TERMINAL_PROMPT=0

node "$LIB/splash.js" &
SPLASH_PID=$!

# shellcheck source=/dev/null
source "$LIB/git-config.sh"
# shellcheck source=/dev/null
source "$LIB/clone-sources.sh"
# shellcheck source=/dev/null
source "$LIB/root-adoption.sh"
node /usr/local/lib/studio-materialize-workspace.mjs "$WORKSPACE"
# shellcheck source=/dev/null
source "$LIB/workspace-root.sh"

kill "$SPLASH_PID" 2>/dev/null || true
wait "$SPLASH_PID" 2>/dev/null || true

node "$LIB/gate.js" &
clone_workspace_sources &

exec /usr/local/bin/studio-ide-start
