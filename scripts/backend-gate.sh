#!/usr/bin/env bash
# The backend's local gates in one command: fmt -> clippy -> test, in ONE
# container, with a log file, a short summary and an honest exit code.
#
#   scripts/backend-gate.sh                         # fmt, clippy, every test
#   scripts/backend-gate.sh studio_session          # ... tests filtered by name
#   scripts/backend-gate.sh -- --test-threads 4     # ... extra libtest args
#   scripts/backend-gate.sh --only clippy           # one step (fmt,clippy,test)
#   scripts/backend-gate.sh --target my-volume      # another target volume
#
# Exit status: 0 only when every step passed. The full cargo output goes to a
# log file (printed at the start and in the summary); the terminal gets one
# line per step, the test counts and whether the crate was really compiled.
#
# What makes it fast (measured, see studio-backend/AGENTS.md "Gates"):
#
# - sccache on one shared volume, `cf-studio-sccache`. Every worktree and every
#   agent keeps its own target volume (two cargo processes on one target dir
#   block each other, and a shared one can run another worktree's binary), but
#   the 800-odd dependencies compile once per machine instead of once per
#   worktree. Paths inside the container are the same for everybody (/w,
#   /usr/local/cargo), so the cache keys match across worktrees.
# - line-tables-only debuginfo for our crate and none for dependencies, as
#   CI does for its tests: file:line in a backtrace is all a gate reads, and
#   full debuginfo was most of the target volume, the link and the memory.
# - mold as the linker (only in this image; CI is untouched).
# - incremental compilation for our own crate only: sccache cannot cache an
#   incremental unit, and dependencies are never incremental anyway, so the
#   two do not compete. Measured, incremental wins the edit loop clearly
#   (clippy 161 s vs 218 s, test build 142 s vs 368 s non-incremental).
#   GATE_INCREMENTAL=0 turns it off.
# - On a warm target, clippy runs beside the test build (clippy has its own
#   target dir, target/clippy, so neither waits on cargo's lock). Our crate's
#   front end is one thread for minutes, so the pair takes ~115 s instead of
#   ~300 s. A cold target runs them one after the other: two cold compiles of
#   this crate do not fit in the VM's memory. GATE_PARALLEL=0|1 forces it.
#
# The steps themselves are in backend-gate-inner.sh, which runs in the
# container; this script builds the image, takes the slot and summarises.
#
# Safety rails, each from a gate that once lied:
#
# - Changed sources are `touch`ed inside the container first. Through the
#   Windows bind mount an edited file can keep an mtime cargo considers old,
#   and the gate then passes on the previous binary. The summary says whether
#   cargo actually compiled cf-studio-backend.
# - Only one Rust build runs at a time (the WSL VM has 20 GB; two cold builds
#   used to OOM it). The slot is a container name, `cf-studio-gate-slot-N`:
#   Docker refuses a second container with the same name, so taking the slot
#   is atomic across worktrees and frees itself when the container exits. A
#   waiting gate blocks in `docker wait` on the holder instead of polling.
#   Rust builds started by hand from the check image or a `rust:` image also
#   count as busy. GATE_SLOTS=2 allows two at once (see AGENTS.md for when).
#
# Options:
#   --target VOLUME   target volume (default: one per worktree, from its path)
#   --log FILE        log file (default: $TMPDIR/backend-gate-<worktree>.log)
#   --only STEPS      comma list out of fmt,clippy,test (default: all three)
#   --features LIST   cargo features (default: CI's, theia-bridge,github-mirror)
#   --stats           sample `docker stats` and report the peak memory
#   --raw CMD         run CMD (a shell command) instead of the steps, output
#                     streamed as well as logged; backend-check.sh uses this
# Environment: GATE_SLOTS (1), GATE_INCREMENTAL (1), GATE_PARALLEL (auto),
#   CARGO_BUILD_JOBS, GATE_NO_WAIT=1 (fail instead of waiting for a slot),
#   GATE_IMAGE (run another image; for measurements).

set -uo pipefail
export MSYS_NO_PATHCONV=1

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
slug=$(basename "$root" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_.\n-' '-' | cut -c1-40)
pathhash=$(printf '%s' "$root" | sha1sum | cut -c1-6)

target_vol="cf-studio-target-${slug}-${pathhash}"
log="${TMPDIR:-/tmp}/backend-gate-${slug}-${pathhash}.log"
steps="fmt,clippy,test"
features="theia-bridge,github-mirror"
stats=0
raw=""
while [ $# -gt 0 ]; do
    case "$1" in
        --target)   target_vol=$2; shift 2 ;;
        --log)      log=$2; shift 2 ;;
        --only)     steps=$2; shift 2 ;;
        --features) features=$2; shift 2 ;;
        --stats)    stats=1; shift ;;
        --raw)      raw=$2; shift 2 ;;
        -h|--help)  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        --)         break ;;
        *)          break ;;
    esac
done
filters=("$@")

toolchain=$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' "$root/rust-toolchain.toml")
[ -n "$toolchain" ] || { echo "[gate] cannot read the channel from rust-toolchain.toml" >&2; exit 2; }

# ---------------------------------------------------------------- the image
# The stock check image (protoc, cmake, clippy, rustfmt; see backend-check.sh
# for why each is baked) plus sccache and mold, both pinned release binaries
# checked against the sha256 their release publishes. The tag carries a hash
# of this text, so editing it builds a new image instead of reusing the old.
dockerfile=$(cat <<DOCKERFILE
FROM rust:${toolchain}-bookworm
RUN apt-get update -qq \
 && apt-get install -y -qq protobuf-compiler cmake \
 && rm -rf /var/lib/apt/lists/*
RUN rustup component add clippy rustfmt
RUN curl -fsSL -o /tmp/sccache.tgz https://github.com/mozilla/sccache/releases/download/v0.18.0/sccache-v0.18.0-x86_64-unknown-linux-musl.tar.gz \
 && echo "45f1447fbe231e3037bde351ef70677dd212216c8d62ae7ca409fecc4d6acc89  /tmp/sccache.tgz" | sha256sum -c - \
 && tar -xzf /tmp/sccache.tgz -C /usr/local/bin --strip-components=1 sccache-v0.18.0-x86_64-unknown-linux-musl/sccache \
 && rm /tmp/sccache.tgz
RUN curl -fsSL -o /tmp/mold.tgz https://github.com/rui314/mold/releases/download/v2.42.1/mold-2.42.1-x86_64-linux.tar.gz \
 && echo "6ff270c9bf07d2bec5c98aa324eb7c4daf6a1a4d815c05ff1708049616047855  /tmp/mold.tgz" | sha256sum -c - \
 && tar -xzf /tmp/mold.tgz -C /usr/local --strip-components=1 \
 && rm /tmp/mold.tgz
# Cargo settings for this image only; CI never sees them. The registry volume
# mounts at /usr/local/cargo/registry, so this file next to it survives.
RUN printf '%s\n' \
    '[target.x86_64-unknown-linux-gnu]' \
    'rustflags = ["-C", "link-arg=-fuse-ld=mold"]' \
    '[profile.dev]' \
    'debug = "line-tables-only"' \
    '[profile.dev.package."*"]' \
    'debug = false' \
    > /usr/local/cargo/config.toml
DOCKERFILE
)
image="cf-studio-backend-check:${toolchain}-gate-$(printf '%s' "$dockerfile" | sha1sum | cut -c1-8)"
# GATE_IMAGE runs another image (measurements against the old check image).
image=${GATE_IMAGE:-$image}
if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "[gate] building $image (once; later runs reuse it)"
    printf '%s\n' "$dockerfile" | docker build -q -t "$image" - >/dev/null || { echo "[gate] image build failed" >&2; exit 2; }
fi

# Test PostgreSQL containers abandoned by a killed run (see backend-check.sh).
stale=$(docker ps -a --filter "name=^/cf-studio-test-pg-" --format '{{.ID}} {{.Status}}' 2>/dev/null \
    | awk '$0 ~ /hours|days|weeks|months/ { print $1 }')
# shellcheck disable=SC2086
[ -z "$stale" ] || docker rm -f $stale >/dev/null 2>&1 || true

# ----------------------------------------------------- what changed: touch it
# Computed on the host: inside the container the worktree's .git file points
# at a Windows path. Everything this branch changed since main, plus what is
# uncommitted or untracked. Touching a few hundred files costs nothing.
changed=$(
    cd "$root" || exit 0
    base=""
    for ref in upstream/main origin/main main; do
        base=$(git merge-base HEAD "$ref" 2>/dev/null) && break
    done
    { [ -z "$base" ] || git diff --name-only "$base" -- studio-backend
      git diff --name-only HEAD -- studio-backend
      git ls-files --others --exclude-standard -- studio-backend
    } 2>/dev/null | sort -u
)

# ------------------------------------------------------------ the build slot
# sccache refuses to start when CARGO_INCREMENTAL is set to 1 at all, so
# "incremental for our crate only" means leaving it unset: the dev profile then
# makes the workspace crate incremental (sccache passes it through uncached)
# and dependencies, never incremental, are cached.
incremental=()
[ "${GATE_INCREMENTAL:-1}" = 1 ] || incremental=(-e CARGO_INCREMENTAL=0)
slots=${GATE_SLOTS:-1}
slot=""
waited=0
while [ -z "$slot" ]; do
    # A slot container left in "created" by a killed gate would hold the slot
    # forever; a minute is far longer than create -> start ever takes.
    for c in $(docker ps -a --filter "name=^/cf-studio-gate-slot-" --filter status=created --format '{{.Names}}'); do
        created=$(docker inspect -f '{{.Created}}' "$c" 2>/dev/null) || continue
        if [ $(( $(date +%s) - $(date -d "$created" +%s 2>/dev/null || date +%s) )) -gt 60 ]; then
            docker rm -f "$c" >/dev/null 2>&1 || true
        fi
    done
    busy=$(docker ps --format '{{.Names}} {{.Image}}' \
        | awk '$1 ~ /^cf-studio-gate-slot-/ || $2 ~ /^(cf-studio-backend-check|rust)(:|$)/ { print $1 }')
    nbusy=$(printf '%s' "$busy" | grep -c . || true)
    if [ "$nbusy" -lt "$slots" ]; then
        for n in $(seq 1 "$slots"); do
            name="cf-studio-gate-slot-$n"
            if docker create --rm -i --name "$name" \
                --label "cf-studio-gate.worktree=$root" \
                -v "${root}:/w" \
                -v cf-studio-cargo-registry:/usr/local/cargo/registry \
                -v "${target_vol}:/w/studio-backend/target" \
                -v cf-studio-sccache:/sccache \
                -v /var/run/docker.sock:/var/run/docker.sock \
                -e RUSTC_WRAPPER=sccache \
                -e SCCACHE_DIR=/sccache \
                -e SCCACHE_CACHE_SIZE="${SCCACHE_CACHE_SIZE:-40G}" \
                -e SCCACHE_IDLE_TIMEOUT=0 \
                "${incremental[@]}" \
                -e CARGO_TERM_COLOR=never \
                -e CARGO_TERM_PROGRESS_WHEN=never \
                ${CARGO_BUILD_JOBS:+-e CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS} \
                -e GATE_STEPS="$steps" \
                -e GATE_FEATURES="$features" \
                -e GATE_RAW="$raw" \
                -e GATE_PARALLEL="${GATE_PARALLEL:-auto}" \
                -w /w/studio-backend \
                "$image" bash /w/scripts/backend-gate-inner.sh "${filters[@]}" \
                >/dev/null 2>"${log}.create"; then
                slot=$name
                break
            elif ! grep -q 'Conflict' "${log}.create"; then
                echo "[gate] docker create failed:" >&2
                cat "${log}.create" >&2
                exit 2
            fi
        done
    fi
    if [ -z "$slot" ]; then
        if [ "${GATE_NO_WAIT:-0}" = 1 ]; then
            echo "[gate] no free Rust build slot (busy: $(echo $busy)); GATE_NO_WAIT=1, giving up" >&2
            exit 3
        fi
        [ "$waited" = 1 ] || echo "[gate] waiting for a Rust build slot (busy: $(echo $busy))"
        waited=1
        holder=$(printf '%s\n' "$busy" | head -1)
        if [ -n "$holder" ]; then
            docker wait "$holder" >/dev/null 2>&1 || sleep 5
        else
            sleep 5
        fi
    fi
done
rm -f "${log}.create"

# ------------------------------------------------------------------- the run
echo "[gate] $slot, target volume $target_vol, log $log"
statsfile="${log}.stats"
: > "$statsfile"
if [ "$stats" = 1 ]; then
    (
        sleep 3
        while docker stats --no-stream --format '{{.MemUsage}}' "$slot" >>"$statsfile" 2>/dev/null; do
            sleep 2
        done
    ) &
    stats_pid=$!
fi
t0=$(date +%s)
if [ -n "$raw" ]; then
    printf '%s\n' "$changed" | docker start -ai "$slot" 2>&1 | tee "$log"
    rc=${PIPESTATUS[1]}
else
    printf '%s\n' "$changed" | docker start -ai "$slot" >"$log" 2>&1
    rc=$?
fi
elapsed=$(( $(date +%s) - t0 ))
[ "$stats" = 1 ] && { kill "$stats_pid" 2>/dev/null; wait "$stats_pid" 2>/dev/null; }

# --------------------------------------------------------------- the summary
section() { awk -v s="$1" '$0 == "##gate-begin " s {on=1; next} $0 ~ "^##gate-end " s " " {on=0} on' "$log"; }
for s in $(grep -o '^##gate-end [a-z]*' "$log" | awk '{print $2}'); do
    end=$(grep "^##gate-end $s " "$log" | tail -1)
    src=$(echo "$end" | sed 's/.*rc=\([0-9]*\).*/\1/')
    secs=$(echo "$end" | sed 's/.*secs=\([0-9]*\).*/\1/')
    verdict=PASS; [ "$src" = 0 ] || verdict=FAIL
    body=$(section "$s")
    extra=""
    # A raw command that built nothing (fmt, say) has no compile to report.
    if [ "$s" = raw ] && ! grep -qE '^ *(Finished|Compiling|Checking) ' <<<"$body"; then
        s_kind=none
    else
        s_kind=$s
    fi
    case "$s_kind" in
        clippy|test|raw)
            # A here-string, not `echo | grep -q`: grep -q stops reading at
            # the first match, echo then dies of SIGPIPE, and pipefail turns a
            # match into a failure on any long log.
            if grep -qE '^ *(Compiling|Checking) cf-studio-backend ' <<<"$body"; then
                extra="compiled cf-studio-backend: yes"
            else
                extra="compiled cf-studio-backend: NO (nothing rebuilt; stale mtimes?)"
            fi
            ;;
    esac
    if [ "$s" = test ] || [ "$s" = raw ]; then
        counts=$(echo "$body" | awk '/^test result:/ {
                    for (i = 1; i <= NF; i++) {
                        if ($(i+1) ~ /^passed/)  p += $i
                        if ($(i+1) ~ /^failed/)  f += $i
                        if ($(i+1) ~ /^ignored/) g += $i
                    } n++ }
                 END { if (n) printf "%d passed, %d failed, %d ignored", p, f, g }')
        [ -z "$counts" ] || extra="$counts; $extra"
    fi
    if [ "$verdict" = FAIL ] && [ "$s" = clippy ]; then
        extra="$(echo "$body" | grep -cE '^error') error(s); $extra"
    fi
    printf '[gate] %-6s %s %5ss  %s\n' "$s" "$verdict" "$secs" "$extra"
    if [ "$verdict" = FAIL ]; then
        echo "$body" | grep -E '^(error|warning: unused|test .* FAILED$|Diff in )' | sort -u | head -12 | sed 's/^/[gate]     /'
    fi
done
grep -q '^##gate-end' "$log" || echo "[gate] no step finished; see the log"
sc=$(grep '^##gate-sccache' "$log" | cut -d' ' -f2-)
[ -z "$sc" ] || echo "[gate] sccache: $sc"
if [ "$stats" = 1 ] && [ -s "$statsfile" ]; then
    peak=$(awk '{ v = $1; u = v; gsub(/[0-9.]/, "", u); gsub(/[A-Za-z]/, "", v); v = v + 0
                  m = (u == "GiB") ? v * 1024 : (u == "MiB") ? v : (u == "KiB") ? v / 1024 : v / 1048576
                  if (m > max) max = m } END { printf "%.1f GiB", max / 1024 }' "$statsfile")
    echo "[gate] peak memory: $peak"
fi
case "$rc" in
    0)   echo "[gate] PASS in ${elapsed}s; log $log" ;;
    137) echo "[gate] FAIL: the container was killed (137: out of memory?) after ${elapsed}s; log $log" ;;
    *)   echo "[gate] FAIL (exit $rc) in ${elapsed}s; log $log" ;;
esac
exit "$rc"
