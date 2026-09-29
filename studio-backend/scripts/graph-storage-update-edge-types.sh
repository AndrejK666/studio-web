#!/usr/bin/env bash
# Bring the edge types an environment already stored up to the schemas this
# build registers -- once, after upgrading to the weftgraph graph-storage gear.
#
# Why: the gear now refuses traits on edge types, and Studio's connector edges
# (`cf.studio.kg.{contains,contributed_to,includes}`) were stored on studio-dev
# WITH `full_text_search`. The fixed schemas differ from the stored ones, so the
# in-process registration answers 409 -- and the SDK cannot ask for
# `on_existing: update` -- so every repository sync fails until the stored
# types are updated over REST (#512, G-17).
#
#   STUDIO_TOKEN=... scripts/graph-storage-update-edge-types.sh [BASE_URL] [--apply]
#
# BASE_URL defaults to http://127.0.0.1:8090/cf. Without --apply it only asks
# POST /graph-storage/v1/types/compatibility and prints each edge type's verdict;
# with --apply it registers every type that is neither `unchanged` nor `new`
# with `options.on_existing: "update"`. Needs curl and jq. Safe to re-run: a
# type already current reports `unchanged` and is not sent.

set -euo pipefail

base="http://127.0.0.1:8090/cf"
apply=0
for arg in "$@"; do
    case "$arg" in
        --apply) apply=1 ;;
        http*) base="${arg%/}" ;;
        *) echo "usage: $0 [BASE_URL] [--apply]" >&2; exit 2 ;;
    esac
done
: "${STUDIO_TOKEN:?set STUDIO_TOKEN to the bearer token of a platform administrator}"

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
inventory="$here/docs/gts-types.json"

# Every edge type this build registers with graph-storage, as registrations.
types=$(jq '[.schemas[]
    | select(.registry == "graph-storage")
    | select(.type_id | startswith("gts.cf.core.graph.edge.v1~"))
    | {type_id, schema}]' "$inventory")
echo "edge types in the inventory: $(jq length <<<"$types")"

post() {
    curl -sS --fail-with-body -X POST "$base/graph-storage/v1/$1" \
        -H "Authorization: Bearer $STUDIO_TOKEN" \
        -H "Content-Type: application/json" \
        --data "$2"
}

# Each item carries `change.state` (new | unchanged | compatible | incompatible
# | undecidable) and `change.admissible` (whether `on_existing: update` takes it).
verdicts=$(post types/compatibility "$(jq -n --argjson t "$types" '{types: $t}')")
jq -r '.items[] | [.change.state, "admissible=\(.change.admissible)", .type_id] | @tsv' <<<"$verdicts" | sort

stale=$(jq -c --argjson v "$verdicts" '
    [ $v.items[] | select(.change.state != "unchanged" and .change.state != "new") | .type_id ] as $ids
    | [ .[] | select(.type_id as $id | $ids | index($id)) ]' <<<"$types")
count=$(jq length <<<"$stale")
if [ "$count" -eq 0 ]; then
    echo "nothing to update"
    exit 0
fi
if jq -e 'any(.items[]; .change.state != "unchanged" and .change.state != "new" and .change.admissible != true)' <<<"$verdicts" >/dev/null; then
    echo "some edge types cannot be updated as they are -- read the verdicts above" >&2
    exit 1
fi
if [ "$apply" -ne 1 ]; then
    echo "$count edge type(s) would be updated; re-run with --apply"
    exit 0
fi
post types "$(jq -n --argjson t "$stale" '{types: $t, options: {on_existing: "update"}}')" >/dev/null
echo "updated $count edge type(s)"
