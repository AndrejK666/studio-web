---
type: adr
status: accepted
date: 2026-10-07
---

# ADR-0035: Domain objects are authorized through the PDP, and the model by its administrators

**ID**: `cpt-studio-adr-domain-objects-are-authorized-through-the-pdp`

Status: **accepted** · Date: 2026-10-07 · Applies ADR-0019 to the domain model (ADR-0024) · Step 3 of [the domain-query migration](../domain-query-migration.md), shipped with the query it protects

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

The domain-model gear authorizes nothing beyond the tenant. Its design says so
(*"Does not authorize; the gateway and the graph's tenant scope do"*), and that
was true and adequate while the model held only its own types and test objects.
It stops being adequate at the first screen that keeps real data in the model,
and the migration plan puts that screen (step 6) right after this one for that
reason.

Today, any authenticated member of an organization can do all of the following:

- **read and write every object** of every type, through `POST /objects`,
  `GET /objects`, `GET /objects/graph` and `POST /query`;
- **change the organization's model**: add, rename, retype or drop a field;
  import a whole new ontology over it; revert it to an earlier version.

The second is worse than the first. A model edit is not a write to one row. It
changes what every object of a type means, and a rename rewrites up to every
stored payload of the type. An import replaces the model wholesale, and its
revision records no inverse, so it cannot be reverted past. One member can do
that to the whole organization, and nothing records that they were allowed to.

ADR-0019 already says how Studio answers both kinds of question. It also
explains why mixing them up is dangerous. What is missing is applying it here,
and three facts specific to this gear:

1. **Graph-storage cannot do this for us.** Its node resource carries one PEP
   property, `owner_tenant_id`, so all it can ask our PDP is "is this caller in
   this tenant". It cannot ask about a type. Every domain object lives in the
   organization's tenant (graph-storage writes the caller's tenant), so the
   tenant clamp admits all of them to every member.
2. **An object's project is a payload field.** `POST /objects` takes a free-form
   `scope` and stores it as `_scope`. A project is an account-management tenant
   (ADR-0010), and a project-scoped grant is answered by the PDP as
   `owner_tenant_id IN (<project tenants>)`. The two only meet if `scope` *is* a
   project's tenant id. Today nothing says it must be.
3. **`include` crosses objects.** A query that may read projects and follows
   `delivers` reaches whatever the edge points at. Authorizing the root alone
   would let a relation carry a caller into rows they may not read.

## Considered Options

- **Leave it to the tenant.** This is what we have. It fails the first screen
  with an owner, and lets any member rewrite the model.
- **A privilege per entity** (`domain.project.view`, …, about 280 of them for
  140 entities, plus edit). It is precise. It is also unusable: the role editor
  becomes a wall of checkboxes, the catalogue in two languages (ADR-0019
  consequences) grows by an order of magnitude, and most entities will never
  hold data anyone guards separately. If per-entity narrowing is ever needed,
  it should be data the policy reads, not a catalogue entry per type (see §4).
- **Ask graph-storage for a type property on its node resource**, so the PDP
  could constrain types there. It would put the check where the rows are. But
  graph-storage's types are not Studio's entities: one domain type is a graph
  type plus a payload shape. The model's knowledge of inheritance and relations
  lives in this gear, and the ask would make another team's contract carry
  Studio's policy vocabulary. Graph-storage keeps fencing tenants, which it does
  well.
- **The gear asks the PDP per request, with a resource type of its own.** This
  is what ADR-0019 §3 prescribes for row questions and what account-management
  and ledger already do. Chosen.

## Decision Outcome

### 1. Two questions, answered in the two places ADR-0019 assigns them

**Changing the model is administration.** There is one answer per
organization and it filters no rows: adding a field, editing or dropping one,
importing, syncing, reverting. It is answered **in the gear, from the access
config**, by `may_administer(ctx, org, "domain.model")`, the same gate
`people.manage` goes through. It is never routed through the PDP, whose clamp
would answer "every member" (ADR-0019 §3).

**Reading and writing objects is a row question.** The answer is a filter, and
it is the PDP's. The gear becomes a policy enforcement point: it declares a
resource type and calls the enforcer the way account-management does.

### 2. Three privileges

| Privilege | Gates |
| --- | --- |
| `domain.view` | Reading domain objects and their relations: `POST /query`, `GET /objects`, `GET /objects/graph` |
| `domain.edit` | Creating, updating and relating objects: `POST /objects`, `POST /relations` |
| `domain.model` | Changing the model: `/types/{id}/fields`, `/model/import`, `/model/sync`, `/model/revert` |

The model itself, `GET /types` and `GET /types/{id}`, stays readable by every
member. It is the schema, it is what the prototype's types are generated from,
and it holds no one's data.

They join the seeded ladder like everything else:
- `owner` holds all three, by definition;
- `admin` holds all three;
- `editor` holds `domain.view` and `domain.edit`;
- `viewer` holds `domain.view`.

`domain.model` is not given to `editor` for the reason `access.manage` is not
given to `admin`: deciding what a type is decides what everybody else's data
means.

### 3. The resource, and where an object's project comes from

The gear declares one resource type, `gts.cf.studio.domain.object.v1~`, with
actions `read` and `write`. `privilege_for` maps them to `domain.view` and
`domain.edit`. That is the first entry in that table, and it is what ADR-0019
said would turn the role path on.

Each request carries two properties:

- **`owner_tenant_id`**: the object's project tenant when it has one, the
  organization otherwise. A project-scoped grant then narrows exactly the way
  it already does for every other Studio resource, and an organization-wide
  object is reachable only through an organization-wide grant.
- **`entity`**: the entity the request is about: a query's root type, or the
  entity of the object being written. No policy reads it today (§4). It is sent
  from the start so a later policy needs no change in the gear.

For the first property to mean anything, **an object's scope is a project id**.
The query and `POST /objects` take `project_id`, the API conventions'
spelling (rule C2), and refuse one that is not a tenant id. `POST /objects`
keeps `scope` as a deprecated alias that takes anything, as it always did. An
object whose scope is not a tenant id is organization-wide for authorization:
it loses nothing it has today and gains no project narrowing.

### 4. Per entity is data, not catalogue

When a type does need its own guard (salaries on a person, say, which is
exactly the kind of data that should stay relational), the policy grows a
per-role entity list in the access config: `{"privilege": "domain.view",
"except": ["compensation"]}`. The PDP reads `entity` from the request. Nothing
in this ADR builds that. It records that the gear sends what such a policy
would need, so adding it is a policy change and not a contract change.

### 5. Every object an answer contains is checked, not only the root

`POST /query` asks the enforcer once per request for `read`. The constraint it
gets back (tenant, or project tenants) is applied:

- at the root, as a filter on the objects read;
- **at every `include` level**, to the objects a relation reaches. An object
  the constraint excludes is not returned, and it is not counted in `total`
  either. A count that includes rows the caller cannot see would leak them.
  The query does not say that anything was left out: saying so would also leak.

`GET /objects/graph` does the same to its nodes and drops edges to excluded
ones. `POST /relations` asks for `write` on the source **and** `read` on the
target. Relating a person to a project you cannot see would otherwise be a way
to test whether it exists.

### 6. On the `tenant` model nothing changes for objects; the model gets an owner gate

As ADR-0019 §6 requires, an organization on the `tenant` model (every one that
exists) gets the clamp for `domain.view` and `domain.edit`. Every member reads
and writes objects as today.

Model edits are the exception, deliberately. On the `tenant` model ADR-0019
answers administration with the owner arm, so `domain.model` means **owner or
platform administrator**. Any member can edit the model today, so this
**narrows** behaviour. It is the one place this ADR does, and it is the point:
there is no organization whose members ought to be able to replace its model.
The prototype's import, sync and field-edit controls are shown only to those who
pass `may_administer`.

### 7. Fail closed, cached

Under the roles model, a PDP or access-config failure denies (ADR-0019 §4), and
the gear answers `503`, not an empty result. The decision is made once per
action per request and reused across its stages, as graph-storage already does,
not once per relation. The PDP caches the access-config read the role path now
makes (ADR-0019 §8). An entry lasts 10 seconds, the bound memberships already
have, and any access-config write the PDP allows moves a generation that drops
every entry at once.

### Consequences

- Real data can go into the model: step 6 of the migration is unblocked.
- **A behaviour change**: model edits require an owner or a platform
  administrator on the `tenant` model. Anyone else who edits the model today
  loses that. We know of no such use outside the prototype's model screen.
- **A contract change**: `scope` → `project_id`, with an alias, on
  `POST /objects` and `POST /query` (the latter is experimental, so its field is
  renamed outright). The generated client follows.
- Objects stored with a non-project `scope` are organization-wide for
  authorization. Nothing lists them yet; a report that does is a follow-up.
- Stored role ladders do not gain the three privileges by themselves. A new
  organization is seeded with them. An organization already on the roles model,
  which today means none, adds them in its access settings, and its owner holds
  them by definition meanwhile.
- The catalogue grows by three in both files (`access_config.rs`, `access.ts`),
  and `access.test.ts` keeps them equal.
- One more resource type through the PDP. It is the first, so it is also the
  first time the role path runs in production for row reads, on the organizations
  that opted in.

## More Information

### Implementation, in order (built 2026-10-07)

1. Catalogue and ladder: the three privileges in `access_config.rs` and
   `access.ts`, with the seeded roles.
2. The model gate: the four model-editing routes behind `may_administer(…,
   "domain.model")`, plus a `can_edit_model` field on `GET /types`, so the
   prototype hides what it cannot do.
3. The PEP: the resource type, `privilege_for`, and the enforcer call in the
   query, `GET /objects`, `GET /objects/graph`, `POST /objects` and
   `POST /relations`. The constraint is applied at every include level and in
   `total`.
4. `project_id` on `POST /objects` and `POST /query`, `scope` as the alias, and
   the report of objects whose scope is not a project.
5. Stand checks: 30 cases on a stand with real graph-storage and the Studio PDP,
   all as specified (`POST /types/{id}/fields` answers 200, as it did before).
   On a `roles`-model organization:
   - a viewer reads but cannot write;
   - an editor writes but cannot change the model;
   - a project-scoped editor sees only their project's objects, root and
     include alike, and `total` counts only those;
   - an outage denies.

   On a `tenant`-model organization: members read and write as before, and only
   the owner edits the model.

### What this does not decide

- Team grants (ADR-0019's open TODO) apply here as soon as the PDP resolves
  teams. Nothing domain-specific is needed.
- Per-entity narrowing (§4) waits for a type that needs it.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md), [studio-domain-model](../design/studio-domain-model.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-component-domain-model`
* `cpt-studio-component-domain-model-query`
* `cpt-studio-component-authz-plugin`
* `cpt-studio-component-access-config`
* `cpt-studio-fr-authz-row-roles`
