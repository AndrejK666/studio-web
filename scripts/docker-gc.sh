#!/usr/bin/env bash
# Report what Docker is holding, and — when asked — let go of the parts that
# are only caches.
#
# Written after Docker took 660 GB on a 953 GB disk and left 2 GB free, which
# did not present as "Docker is using a lot of space". It presented as the
# daemon answering HTTP 500 on every route, because its data disk could not be
# mounted on a full host. The machine was unusable before anything warned.
#
# Two things make that failure mode possible here, and neither is fixed by
# being careful:
#
#   * The WSL2 backend has NO disk size limit. `diskSizeMiB` is a Hyper-V
#     setting; with WSL2 the virtual disk grows until the host disk is gone.
#     There is no size at which Docker stops on its own.
#
#   * `~/.docker/daemon.json` sets `builder.gc.defaultKeepStorage: "20GB"` and
#     the build cache still reached 185 GB. `UseContainerdSnapshotter` is on,
#     so builds go through buildx and that section of daemon.json does not
#     apply to them. The configured limit is real, and silently governs
#     nothing.
#
# So the guard has to be external, and this is it.
#
#   scripts/docker-gc.sh              # report only, changes nothing
#   scripts/docker-gc.sh --prune      # drop the build cache and dangling images
#   scripts/docker-gc.sh --prune-all  # also drop UNUSED Rust cache volumes
#
# Reporting is the default on purpose: the one irreversible thing here is a
# volume, and a volume is where the stand's Postgres data lives.

set -euo pipefail

# Warn below this. Chosen with Andrej: 50 GB is several builds' headroom and
# still far enough from zero that Docker keeps working while you deal with it.
FREE_GB_WARN=${FREE_GB_WARN:-50}
# What the build cache is allowed to keep. The same 20 GB daemon.json asks for
# and does not get.
KEEP_CACHE=${KEEP_CACHE:-20GB}

mode=${1:-report}

case "$mode" in
    report|--report) prune=no;  volumes=no  ;;
    --prune)         prune=yes; volumes=no  ;;
    --prune-all)     prune=yes; volumes=yes ;;
    -h|--help)
        sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    *)
        echo "usage: $(basename "$0") [--prune|--prune-all]" >&2
        exit 2
        ;;
esac

if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    echo "docker-gc: the daemon is not answering." >&2
    echo "If it returns 500 on every route, check free space FIRST — that is what" >&2
    echo "a full host disk looks like from here, not a Docker fault." >&2
    exit 1
fi

echo "── what Docker is holding ─────────────────────────────────────────────"
docker system df

# Free space on the host, which is the number that actually matters: the VHDX
# grows into it without limit. Read from the Windows drive the WSL VM's disk
# lives on, via /proc/mounts if we are inside WSL, or df on the Git-Bash view.
free_gb=$(df -BG /c 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}')
if [ -z "${free_gb:-}" ]; then
    free_gb=$(df -BG / 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}')
fi

echo
echo "── host disk ──────────────────────────────────────────────────────────"
if [ -n "${free_gb:-}" ]; then
    echo "free: ${free_gb} GB (warn below ${FREE_GB_WARN} GB)"
    if [ "$free_gb" -lt "$FREE_GB_WARN" ]; then
        echo
        echo "!! Below the threshold. Docker will keep growing into what is left, and"
        echo "!! when it runs out the daemon stops answering rather than failing a build."
    fi
else
    echo "could not read free space"
fi

# The volumes that grow without bound: one Rust target/ per worktree, ~20-100 GB
# each, and nothing removes them when the worktree is abandoned. `dangling=true`
# means no container references it — for a target/ cache that means no stack is
# using it right now, which is the closest thing to "abandoned" Docker knows.
echo
echo "── unused Rust cache volumes (no container references them) ───────────"
unused=$(docker volume ls --filter dangling=true --format '{{.Name}}' \
    | grep -E 'target|cargo|rustup' || true)
if [ -z "$unused" ]; then
    echo "none"
else
    echo "$unused" | sed 's/^/  /'
    echo
    echo "These are build caches. Deleting one costs a full dependency rebuild in"
    echo "whatever worktree owns it — minutes, once — and nothing else."
fi

if [ "$prune" = no ]; then
    echo
    echo "Nothing was changed. --prune drops the build cache and dangling images;"
    echo "--prune-all also drops the volumes listed above."
    exit 0
fi

echo
echo "── pruning build cache to ${KEEP_CACHE} ───────────────────────────────"
docker builder prune --force --keep-storage "$KEEP_CACHE"

echo
echo "── pruning dangling images ────────────────────────────────────────────"
docker image prune --force

if [ "$volumes" = yes ] && [ -n "$unused" ]; then
    echo
    echo "── removing unused Rust cache volumes ─────────────────────────────"
    # Named one at a time rather than `volume prune`: that command takes every
    # dangling volume, and on this machine the dangling set includes Postgres
    # data directories for stands that merely happen to be stopped.
    echo "$unused" | while read -r v; do
        [ -n "$v" ] && docker volume rm "$v" >/dev/null && echo "  removed $v"
    done
fi

echo
echo "── after ──────────────────────────────────────────────────────────────"
docker system df

# Deleting inside the disk does not give the space back to the host: the VHDX
# is sparse but only releases trimmed blocks, and only on a clean shutdown with
# the disk detached. Say so, because the obvious next step — looking at the
# .vhdx and seeing it unchanged — reads as the prune having done nothing.
cat <<'NOTE'

The space is free INSIDE Docker's disk now. To give it back to the host, the
virtual disk has to be trimmed and released — it does not shrink on its own:

  1. quit Docker Desktop
  2. wsl --terminate docker-desktop
  3. wsl --mount --vhd "$env:LOCALAPPDATA\Docker\wsl\disk\docker_data.vhdx" --bare
  4. in a WSL distro, as root: mount it BY UUID, `fstrim -v` the mountpoint, umount
  5. wsl --unmount <that vhdx>        <- the disk must be DETACHED, not just unmounted
  6. wsl --shutdown                    <- the sparse file releases the blocks here

Step 5 is the one that gets skipped. An fstrim followed by a shutdown while the
disk is still attached frees nothing, which makes an elevated `diskpart compact`
look necessary. It is not: this sequence took a 660 GB file to 93 GB with no
administrator rights.
NOTE
