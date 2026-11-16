#!/usr/bin/env bash
# Run one of the backend's CI gates locally, by name. For the usual round --
# fmt, clippy and the tests -- use scripts/backend-gate.sh instead: it runs
# them in one container, prints a summary and exits non-zero on any failure.
#
#   scripts/backend-check.sh            # fmt, clippy, build, features, test
#   scripts/backend-check.sh clippy     # one gate
#   scripts/backend-check.sh test studio_session   # a gate plus cargo args
#
# Why a container rather than a local toolchain: the gates need a linker and
# `protobuf-compiler` + `cmake`, and on a Windows checkout that means Visual
# Studio Build Tools -- a machine-scope install that needs administrator
# rights. Docker needs neither, and it runs the *same* Rust version and the
# same system packages as the `backend` job, so a pass here means something.
#
# It is not a substitute for CI: the job also runs a gear-assembly smoke test,
# and CI is the authority.
#
# This is a thin front for backend-gate.sh --raw, so it shares everything that
# script does: the image (protoc, cmake, clippy, rustfmt, sccache, mold), the
# shared sccache volume, a target volume per worktree, the one-build-at-a-time
# slot, touching changed sources, the log file and the exit code. Output is
# streamed as well as logged. Extra environment (GATE_SLOTS, CARGO_BUILD_JOBS,
# ...) is described in backend-gate.sh.

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gate=${1:-all}
shift || true

case "$gate" in
    fmt)    cmd='cargo fmt --check' ;;
    clippy) cmd='cargo clippy --locked --all-targets -- -D warnings' ;;
    build)  cmd='cargo build --locked' ;;
    # The compose stack builds the backend with a feature set no other gate
    # compiles: `theia-bridge`. A change can pass every gate above and still
    # fail `docker compose up`.
    features) cmd='cargo check --locked --features theia-bridge' ;;
    test)   cmd='cargo test --locked' ;;
    all)    cmd='cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo build --locked && cargo check --locked --features theia-bridge && cargo test --locked' ;;
    *)
        echo "usage: $(basename "$0") [fmt|clippy|build|features|test|all] [extra cargo args]" >&2
        exit 2
        ;;
esac
if [ "$#" -gt 0 ]; then
    # Quoted one by one, so an argument with a space reaches cargo whole.
    cmd="$cmd$(printf ' %q' "$@")"
fi

echo "[backend-check] $gate"
exec "$root/scripts/backend-gate.sh" --raw "$cmd"
