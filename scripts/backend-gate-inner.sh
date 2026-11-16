#!/usr/bin/env bash
# The part of scripts/backend-gate.sh that runs inside the gate container.
# Not for running by hand: it expects the container's mounts and GATE_* env.
#
# stdin: the changed files (paths from the repository root), one per line.
# args:  extra `cargo test` arguments (test name filters, `-- --nocapture`).
# Each step is framed by `##gate-begin <step>` / `##gate-end <step> rc= secs=`
# lines, which backend-gate.sh reads for its summary.

set -u

# Defeat stale mtimes through the Windows bind mount (AGENTS.md, "Gates that
# pass when they should not"): touched from inside the container, the files
# are newer than anything cargo recorded, by the VM's own clock.
cd /w || exit 2
n=0
while IFS= read -r f; do
    [ -f "$f" ] && touch -c "$f" && n=$((n + 1))
done
echo "##gate touched $n changed file(s)"
cd /w/studio-backend || exit 2

fail=0
begin() { echo "##gate-begin $1"; }
end() {
    echo "##gate-end $1 rc=$2 secs=$3"
    [ "$2" -eq 0 ] || fail=1
}
run() {
    local name=$1 t0 rc
    shift
    begin "$name"
    t0=$(date +%s)
    "$@"
    rc=$?
    end "$name" "$rc" $(( $(date +%s) - t0 ))
}

# clippy has a target dir of its own, inside the same volume. Its artifacts
# (metadata-only checks) share nothing with the test build's anyway, and a
# separate dir lets the two run at the same time instead of queueing on
# cargo's build-directory lock.
clippy=(env CARGO_TARGET_DIR=target/clippy cargo clippy --locked --all-targets --features "$GATE_FEATURES" -- -D warnings)
test=(cargo test --locked --features "$GATE_FEATURES" "$@")
build=(cargo test --locked --features "$GATE_FEATURES" --no-run "$@")

if [ -n "${GATE_RAW:-}" ]; then
    run raw bash -c "$GATE_RAW"
else
    want() { case ",$GATE_STEPS," in *",$1,"*) return 0 ;; esac; return 1; }
    for s in ${GATE_STEPS//,/ }; do
        case "$s" in fmt|clippy|test) ;; *) echo "##gate unknown step $s"; fail=1 ;; esac
    done

    want fmt && run fmt cargo fmt --check

    # Our crate's front end is one rustc thread for minutes, so clippy and the
    # test build side by side cost little more than either alone (measured:
    # 119 s against 161 + 142). Only on a warm target, though: two cold
    # builds of this crate peak at ~11 + ~13 GB, more than the VM has.
    warm() { compgen -G "$1/debug/.fingerprint/cf-studio-backend-*" >/dev/null; }
    if want clippy && want test && [ "${GATE_PARALLEL:-auto}" != 0 ] \
        && { [ "${GATE_PARALLEL:-auto}" = 1 ] || { warm target/clippy && warm target; }; }; then
        echo "##gate mode parallel (clippy beside the test build)"
        t0=$(date +%s)
        ( "${clippy[@]}" >/tmp/clippy.log 2>&1; echo "$? $(date +%s)" >/tmp/clippy.done ) &
        "${build[@]}" >/tmp/build.log 2>&1
        brc=$?
        wait
        read -r crc cend </tmp/clippy.done
        begin clippy; cat /tmp/clippy.log; end clippy "$crc" $(( cend - t0 ))
        begin test
        cat /tmp/build.log
        if [ "$brc" -eq 0 ]; then
            "${test[@]}"
            brc=$?
        fi
        end test "$brc" $(( $(date +%s) - t0 ))
    else
        want clippy && run clippy "${clippy[@]}"
        want test && run test "${test[@]}"
    fi
fi

echo "##gate-sccache $(sccache --show-stats 2>/dev/null \
    | awk '/^Cache hits  /{h=$NF} /^Cache misses  /{m=$NF} END{print "hits=" h " misses=" m}')"
exit "$fail"
