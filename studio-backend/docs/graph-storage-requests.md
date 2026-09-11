# What Studio needs from graph-storage

*From the Studio backend team, 2026-09-10. Against `cf-gears-graph-storage-v0.1.1`
(rev `719ab47`), which is what we run.*

We built the Studio domain model on graph-storage: 140 entity types, their
relations, and the objects people create against them, all in the graph. It
works. Along the way we hit four things that the gear cannot express, and
worked around each one — this is what those workarounds cost and what would
remove them.

Nothing here is a bug report. Each item is a capability that is *almost* there:
the mechanism exists, and something small keeps us from using it.

Ordered by how much it would help us, most first.

---

## 1. Let one bad type in a batch fail on its own

**Today.** `register_types` takes a batch and commits it whole. If one type in
it is refused, the whole call fails and nothing is registered.

**Why that hurt.** Our model registers 145 types at once. A single type whose
schema had drifted made that call fail — and because we register before every
first write, *every* write in the model stopped. One type nobody was using took
down the other 144.

**What we did instead.** When the batch fails we now retry type by type, 145
separate calls, and collect the ones that were refused. It works and it is
slow, and every other producer that registers more than one type at a time will
write the same fallback.

**What we need.** Per-item outcomes on registration, the way ingest already
does it: the batch reports which types were admitted and which were refused,
with the reason, instead of failing as one. `IngestOptions.report_per_item`
is exactly the shape we mean.

**How we would know it works.** Register two types in one call where one is a
conflict: the other one is registered, and the response names the conflict.

---

## 2. Tell us a node's version when we read it

**Today.** `NodeSpec.expected_version` is a real compare-and-set — ingest
refuses the write when the version disagrees with what is stored. But no read
returns that number. `NodeView` and `NodeRow` carry an `ElementEnvelope` with
`created_at/by`, `updated_at/by` and the graph revision the *read* observed —
not the element's own version.

**Why that matters.** The ordinary safe-update flow cannot be written:

```
read node → change the payload → write with expected_version = <the version I read>
                                                                ^ we have no way to get this
```

So every update in our gear is last-writer-wins. Two people editing the same
object silently overwrite each other.

**What we did instead.** We use the one thing that *is* expressible:
`expected_version: 0` means "this node must not exist", because a live node's
version is 1 or more. That gives us create-if-absent, and we built our model's
version numbering on it — claiming version N is an insert at a key derived from
N, which exactly one writer can win. It works well and it only guards
*creation*.

Faking the missing piece is possible and we decided against it: carry a
revision counter in the payload and, before each write, insert a claim node
keyed on `(node_key, next_rev)`. That costs one extra node **per revision,
forever** — a tombstoned key cannot be re-ingested, so the claims can never be
cleaned up — and doubles the cost of every write. Not a fair price for one
integer on the read path.

**What we need.** The element's own version on the read path — a field on
`ElementEnvelope`, or on `NodeView` / `NodeRow` directly. The value is already
selected; only the mapping to the SDK type drops it.

Edges have no `expected_version` at all, so the same question applies there,
one step further back.

**How we would know it works.** Read a node, change its payload, write it back
with the version that came out of the read: it succeeds. Do the same from two
readers on one version: exactly one succeeds.

---

## 3. Let a published schema change

**Today.** graph-storage stores one schema per type, as a column on `gts_type`,
and re-registering the same type with any different schema is a conflict. There
is no update path at all: not through registration, which refuses, and not from
the platform types-registry, because graph-storage does not read it.

That last part is worth being precise about, because the code says otherwise.
`gts_type`'s own doc comment reads:

> Per-tenant projection of the platform types-registry … The registry stays
> authoritative — this is a cache with a foreign identity, never a second
> source of truth.

But the gear does not depend on `types-registry` — not in `Cargo.toml`, not one
reference in `src/`. DESIGN states the boundary deliberately: the Ontology
Registry *"does not publish the gear's own base types to the platform
types-registry (the gear lifecycle does, once, at startup)"*. Publication is
one-way and one-time. So the row is not a projection of anything; it is filled
by whatever a producer posted and is authoritative in practice while documented
as a cache. Either the comment or the behaviour should change.

Meanwhile the platform registry has all of this: `type_schema` with a
current-revision pointer, immutable `type_schema_revision` snapshots,
`version_family`, cross-minor compatibility and a deliberate `force` waiver.
graph-storage flattens it away.

**Why that matters.** A type's schema is not a constant. Ours carried the
payload paths each type is searched and embedded on, derived from the modelled
entity's fields — so adding a field to a type made its schema unregistrable.
Combined with item 1, one added field stopped every write in the model.

**What we did instead.** We removed everything model-derived from our schemas:
the search paths are now the same fixed set for all 140 types. That was the
right call on its own — a schema that cannot change should not be a function of
data that can — but it also means the indexing a type gets can no longer follow
what the type actually holds. That capability is given up purely to work around
this.

**What we need**, smallest first:

- item 1 above, so a refusal is survivable;
- the revision on `TypeRecord` — whatever `type_schema` holds is *some*
  revision, and a reader cannot name it;
- graph-storage reading the registry's `type_schema.revision_no` and refreshing
  `gts_type` when it moves. Compatibility, forcing and history stay upstream
  where they are already implemented; this gear follows the pointer.

**Timing.** `constructorfabric/gears-rust#4619` (Types Registry P0) is building
the durable registry, immutable revisions, version families, compatibility
verdicts and a **new SDK trait that deletes `TypesRegistryClient` outright**,
with ~50 call sites across 20+ gears migrating inside P0. graph-storage is not
mentioned in that epic — not in scope, not out of scope. It fits: the gear is
not a consumer today. But it means P0 will build exactly the machinery this
item asks for and graph-storage will still not read it. Adding a consumer to a
contract being designed now is cheaper than adding one to a shipped one.

**How we would know it works.** Register a type, change its schema in the
registry, read it back through `get_type`: graph-storage serves the new one.

---

## 4. Make removing something possible

Three smaller limits that add up to the same thing: our model can grow but not
shrink.

**A tombstoned node key cannot be reused.** `delete_node` soft-deletes the node
and its incident edges in one transaction, which is good. But the key is then
unusable until a purge, and the SDK exposes no purge. For a model that is meant
to be reconfigured this inverts the cost: deleting an entity is easy and
*re-adding* it later is impossible.

We therefore never delete. When a model shrinks — an import that drops an
entity — we leave the old `object_type` nodes in place and keep an authoritative
list of entity ids on the model node, so the dropped ones are simply not read
back. An entity that returns is adopted again for free. This works, and it
means the graph accumulates rows nothing will ever collect.

*Need:* either a purge on the SDK, or a documented way to reuse a tombstoned
key. Even "tombstones are purged after N days" would let us plan.

**Declarative scope replacement does not remove anything.** `replace_scope` is
in the request shape and takes the fence and the generation, but
`fence_and_clear_scope` removes no rows — the code says so, and DEVIATIONS
records it as a scope cut. So the one API that would let a producer say "this
batch is the complete contents of this scope" cannot yet do it. We would use it
for exactly the case above.

*Need:* the removal half of scope replacement, or its removal from the request
shape until it exists — right now it reads as available.

**Adjacency cannot be paged.** A node read returns each incident edge's key
(good — that is what makes `delete_edge` usable at all), but bounded by
`node_read_max_adjacency` (100 by default, 1000 maximum) with a truncation flag
and no cursor. A node with more edges than the ceiling can never have all of
them enumerated, so "remove every edge of this kind on this node" is not
expressible in general.

*Need:* a cursor on adjacency, or an edge listing by endpoint.

---

## What we are not asking for

**GTS major versions of a type** (`requirement.v2~` alongside `v1~`). We looked
at it and stopped, because two things make it unworkable before the API even
matters: without item 3 the two identifiers are unrelated types rather than a
family, and a node's concrete type is immutable under upsert, so the existing
objects cannot move from v1 to v2 in place. Creating them anew under new keys
and tombstoning the old ones runs straight into item 4. This is the right
answer eventually; it is not a small ask, and items 1–3 are worth more to us
sooner.

---

## Summary

| | Ask | Have now | Costing us |
|---|---|---|---|
| 1 | Per-item outcomes on `register_types` | all-or-nothing batch | 145 fallback calls; one bad type stops every write |
| 2 | Node version on the read path | write-only `expected_version` | every update is last-writer-wins |
| 3 | A published schema can change | one immutable column, registry not read | indexing cannot follow the model |
| 4 | Removing is possible and reversible | tombstones are permanent, scope replacement is inert, adjacency unpaged | the graph only grows |

Items 1 and 2 are small and independent — a per-item report and one integer.
Item 3 is the structural one and is best decided alongside `#4619`. Item 4 is
three separate small ones that happen to share a consequence.

Happy to open these as individual issues, provide reproductions against a
stand, or test a branch. The Studio domain-model gear
(`studio-web/studio-backend/src/domain_model`) exercises all four paths and can
serve as the integration case.
