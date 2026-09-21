#!/usr/bin/env bash
# What a browser gets from a deployed stand, asserted rather than assumed.
#
#   scripts/post-deploy-smoke.sh studio-dev.cfabric.org
#   scripts/post-deploy-smoke.sh studio-dev.cfabric.org studio-dev-poc.cfabric.org
#
# Run by `studio-delivery.yml` after every deploy, and by hand against any
# stand. It needs nothing but curl: no token, no kubeconfig, no cluster access.
#
# WHAT IT IS FOR, AND WHAT IT IS NOT
#
# The rollout check beside it already proves the pods came up with the right
# image, and `/cf/health` proves the process answers. Neither says anything
# about what the product actually serves — the delivery pipeline has never
# looked at a response body or a response header. These are the assertions that
# fail when something is wrong in a way a healthy pod cannot show:
#
#   * the portal is served compressed and cached correctly, which is the
#     difference between a fast first load and re-downloading the whole bundle;
#   * the backend mounted its routes, not just its health endpoint;
#   * the IdP discovery document names the host it is reached on.
#
# It is deliberately unauthenticated, so it covers no business behaviour. An
# authenticated smoke test needs a service account nobody has created yet.
#
# NOTE ON THE EDGE. TLS terminates at Cloudflare for these hosts, and
# Cloudflare compresses on its own. So a passing compression check here means
# "the browser got compressed bytes", which is what matters to a user, but it
# does NOT prove nginx did it. The assertion that proves that one runs inside
# the cluster — see the `nginx -T` step in studio-delivery.yml.
set -euo pipefail

host=${1:?usage: post-deploy-smoke.sh <host> [prototype-host]}
prototype_host=${2:-}

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }
failures=0

# `--retry-all-errors` because an Ingress can answer 502 for a second or two
# after a rollout while the endpoint list catches up.
fetch_headers() {
    curl --silent --show-error --location --retry 6 --retry-all-errors \
        --max-time 30 -o /dev/null -D - -H 'Accept-Encoding: gzip' "$1"
}

status_of() {
    curl --silent --show-error --location --retry 6 --retry-all-errors \
        --max-time 30 -o /dev/null -w '%{http_code}' "$1"
}

echo "post-deploy smoke: https://$host"

# ── The portal ────────────────────────────────────────────────────────────
index_headers=$(fetch_headers "https://$host/")

if grep -qi '^content-encoding:.*\(gzip\|br\)' <<<"$index_headers"; then
    pass "index.html is compressed"
else
    fail "index.html came back uncompressed"
fi

# index.html names the current bundle, so it must be revalidated after every
# deploy. A cached one points every returning browser at the previous release's
# asset names, which are gone.
if grep -qi '^cache-control:.*\(no-store\|no-cache\|max-age=0\)' <<<"$index_headers"; then
    pass "index.html is not cached"
else
    fail "index.html carries no revalidating Cache-Control"
fi

# A hashed asset, taken from the page rather than guessed: its name changes
# with its bytes, so it is the one thing that may be cached forever.
asset=$(curl --silent --show-error --location --max-time 30 "https://$host/" \
    | grep -o '/assets/[A-Za-z0-9._-]*\.js' | head -1 || true)
if [ -z "$asset" ]; then
    fail "no hashed asset referenced from index.html (did the build change?)"
else
    asset_headers=$(fetch_headers "https://$host$asset")
    if grep -qi '^cache-control:.*immutable' <<<"$asset_headers"; then
        pass "hashed assets are cached immutably ($asset)"
    else
        fail "hashed asset $asset is not cached immutably"
    fi
    if grep -qi '^content-encoding:.*\(gzip\|br\)' <<<"$asset_headers"; then
        pass "hashed assets are compressed"
    else
        fail "hashed asset $asset came back uncompressed"
    fi
fi

# ── The backend ───────────────────────────────────────────────────────────
code=$(status_of "https://$host/cf/health")
[ "$code" = 200 ] && pass "/cf/health answers 200" || fail "/cf/health answered $code"

# Health is a route the gateway serves whether or not a single gear mounted.
# The OpenAPI document is the cheapest proof that the assembly's own routes are
# there — a boot that lost a gear answers this with a smaller surface, and a
# boot that lost the assembly does not answer it at all.
code=$(status_of "https://$host/cf/docs")
[ "$code" = 200 ] && pass "/cf/docs answers 200" || fail "/cf/docs answered $code"

# ── The IdP ───────────────────────────────────────────────────────────────
issuer=$(curl --silent --show-error --location --max-time 30 \
    "https://$host/auth/realms/studio/.well-known/openid-configuration" \
    | sed -n 's/.*"issuer"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)
if [ "$issuer" = "https://$host/auth/realms/studio" ]; then
    pass "the realm issuer names this host"
else
    fail "realm issuer is '${issuer:-<none>}', expected https://$host/auth/realms/studio"
fi

# ── The prototype portal, when this deploy carried one ────────────────────
if [ -n "$prototype_host" ]; then
    echo "post-deploy smoke: https://$prototype_host"
    proto_headers=$(fetch_headers "https://$prototype_host/")
    if grep -qi '^content-encoding:.*\(gzip\|br\)' <<<"$proto_headers"; then
        pass "prototype index.html is compressed"
    else
        fail "prototype index.html came back uncompressed"
    fi
    code=$(status_of "https://$prototype_host/cf/health")
    [ "$code" = 200 ] && pass "prototype /cf/health answers 200" \
        || fail "prototype /cf/health answered $code"
fi

echo
if [ "$failures" -gt 0 ]; then
    echo "post-deploy smoke: $failures check(s) failed" >&2
    exit 1
fi
echo "post-deploy smoke: all checks passed"
