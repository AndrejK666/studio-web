#!/usr/bin/env bash
# What both portals' nginx configs must keep true, asserted without a cluster.
#
#   scripts/check-portal-nginx.sh
#
# Run by `studio-delivery.yml` in the contract job, and by hand.
#
# WHY THIS IS A STATIC CHECK AND NOT A LIVE ONE
#
# It used to be neither, then briefly a `kubectl exec ... nginx -T` in the
# deploy job — which was wrong twice over. The deployer ServiceAccount has no
# `create` on `pods/exec` and must not be given one, so the assertion could
# never pass; and it failed the deploy AFTER a successful rollout, turning a
# good deploy red over a check about a file in this repository.
#
# The file is the thing being asserted, so assert the file. This runs on every
# pull request, before anything is built, and needs no credentials at all.

set -euo pipefail

templates=(
    studio-frontend/nginx.conf.template
    studio-frontend-prototype/nginx.conf.template
)

failures=0
note() { printf '  %-5s %s\n' "$1" "$2"; }

for template in "${templates[@]}"; do
    if [ ! -f "$template" ]; then
        note FAIL "$template: not found" >&2
        failures=$((failures + 1))
        continue
    fi

    # `envsubst` is the image's job; a literal is enough to read the structure.
    conf=$(sed 's/${BACKEND_HOST}/studio-backend:8090/g' "$template")

    # 1. Compression is on at all. Without this the bundle goes out at full
    #    size on every load, which is what this check exists to keep fixed.
    if grep -qE '^[[:space:]]*gzip[[:space:]]+on;' <<<"$conf"; then
        note ok "$template: compression is on"
    else
        note FAIL "$template: gzip is not enabled" >&2
        failures=$((failures + 1))
    fi

    # 2. And it does not reach the event stream. nginx's gzip filter buffers
    #    until it has enough bytes to be worth compressing, which for SSE means
    #    holding events back for as long as the client will wait — the portal
    #    goes quiet with nothing in any log to say why. This is the regression
    #    that would be invisible in review and invisible in production.
    if ! grep -q 'location /cf/studio-events/v1/stream' <<<"$conf"; then
        note FAIL "$template: no location block for the event stream" >&2
        failures=$((failures + 1))
        continue
    fi
    if awk '/location .cf.studio-events.v1.stream/,/}/' <<<"$conf" | grep -q 'gzip off'; then
        note ok "$template: the event stream is not compressed"
    else
        note FAIL "$template: the event stream location does not disable gzip" >&2
        failures=$((failures + 1))
    fi
done

echo
if [ "$failures" -gt 0 ]; then
    echo "portal nginx: $failures check(s) failed" >&2
    exit 1
fi
echo "portal nginx: all checks passed"
