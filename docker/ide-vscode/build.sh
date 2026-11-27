#!/usr/bin/env bash
# Build the session base and the VS Code session image (ADR-0080), from the
# repository root:  bash docker/ide-vscode/build.sh [tag]
set -euo pipefail
cd "$(dirname "$0")/../.."
TAG="${1:-dev}"
docker build -f docker/session-base/Dockerfile -t "cf-studio-session-base:${TAG}" .
docker build -f docker/ide-vscode/Dockerfile --build-arg "SESSION_BASE=cf-studio-session-base:${TAG}" \
  -t "cf-studio-vscode:${TAG}" .
