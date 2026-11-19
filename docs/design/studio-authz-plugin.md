---
type: design
status: accepted
owner: studio-team
---

# Technical Design — studio-authz-plugin

- [x] `p3` - **ID**: `cpt-studio-design-authz-plugin`

The gear-level design of `cpt-studio-component-authz-plugin`, the Studio PDP.
The product-level view, and how this gear sits among the others, is in
[Constructor Studio's design](constructor-studio.md). The code is one file,
[`studio-backend/src/studio_authz_plugin/mod.rs`](../../studio-backend/src/studio_authz_plugin/mod.rs).

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Principles & Constraints](#2-principles--constraints)
- [3. Technical Architecture](#3-technical-architecture)
- [4. Additional context](#4-additional-context)
- [5. Traceability](#5-traceability)
- [6. Roles and privileges in practice](#6-roles-and-privileges-in-practice)

## 1. Architecture Overview

### 1.1 Architectural Vision

An AuthZ resolver plugin: every authorization request through the platform's
`authz_resolver` ends here, and the answer is a decision plus the constraints a
PEP applies to the rows it reads.

The answer is the **tenant clamp** — the caller may reach rows owned by the
tenants they may reach, and those tenants' subtrees. An organization's access
config (`cf.studio.access.config.v1`, tenant metadata) chooses a model:
`tenant`, where the clamp is the whole answer, or `roles`, where a grant can
only narrow the clamp further. Roles sit on top of the tenant model and never
replace it, so a mis-entered grant can deny and can never reach across tenants.

Two things are not the clamp. The tenants a caller may reach are the token's
tenant *plus* every organization the caller's person is an active member of, so
a person reaches an organization they belong to whichever login they used. And a
write to the access config itself — the document that names an organization's
owners — is answered by ownership, because the clamp would answer it with "you
are a member", which is how a member would appoint themselves owner.

### 1.2 Architecture Drivers

#### Functional Drivers

| Requirement | Design Response |
|-------------|------------------|
| `cpt-studio-fr-authz-tenant-clamp` | Every request that is not denied outright is answered with the clamp over the caller's reachable tenants; the role path only narrows it. |
| `cpt-studio-fr-authz-row-roles` | The role path is built and tested; `privilege_for` maps no resource type yet, so nothing reaches it. |

#### NFR Allocation

| NFR ID | NFR Summary | Allocated To | Design Response | Verification Approach |
|--------|-------------|--------------|-----------------|----------------------|
| `cpt-studio-nfr-tenant-isolation` | Every allow stays in the caller's tenant subtree | `cpt-studio-component-authz-plugin` | Every allow carries the clamp's constraints; a project-scoped grant AND-s its scope ids into the clamp of the grant's own tenant, so a scope outside the subtree drops out at evaluation | Unit tests in `studio_authz_plugin/mod.rs` |

#### Key ADRs

| ADR ID | Decision Summary |
|--------|------------------|
| `cpt-studio-adr-roles-over-tenant` | Roles are AND-ed with the tenant clamp, never a replacement for it. |
| `cpt-studio-adr-a-role-narrows-what-a-member-may-do` | The PDP answers row access; administrative authority is answered in the gear. An unreadable config denies; an owner's authority is definitional. |
| `cpt-studio-adr-authentication-does-not-grant-organization-membership` | Reach follows recorded membership, not the token alone. |
| `cpt-studio-adr-an-identity-proves-it-is-you-and-decides-nothing-else` | A platform administrator is a member of the platform root; the token's tenant stays in the clamp until what depends on it is gone. |
| `cpt-studio-adr-the-person-is-the-key-not-the-login` | A grant is matched against every sign-in subject of the caller's person. |
| `cpt-studio-adr-one-owner-for-people-and-membership` | A grant names the person; the match set leads with the person id, and the logins stay in it for grants written before the rekey. |

### 1.3 Architecture Layers

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| Plugin | Register with the types-registry and the ClientHub | `AuthZResolverPluginClient`, `PluginV1` registration |
| Plan | Decide from the request alone what kind of answer it needs | `Plan::for_request`, no I/O |
| Decision | The role path and the access-config-write gate | `decide`, `decide_access_config_write` |
| Reach | Token tenant plus member organizations, cached | `reachable_tenants` over `OrganizationReader` |
| Shape | Turn tenants and scopes into constraints | `tenant_constraints` |

## 2. Principles & Constraints

### 2.1 Design Principles

#### Decide the shape before reading anything

- [x] `p2` - **ID**: `cpt-studio-principle-authz-plugin-plan-first`

`Plan::for_request` classifies a request with no I/O. No tenant, or the nil
tenant: deny. An explicitly typed service principal with `*` uses the tenant
clamp. User tokens with `*` still go through privilege and protected metadata
checks. A write or delete of the access config uses the ownership gate, which
also checks active membership when the organization already has an owner.
An organization-wide grant applies to the tenant subtree under evaluation.
A request on an account-management tenant, tenant
metadata or tenant type: the clamp — authorizing a read of the access config
must not read the access config, which would recurse. A resource type
`privilege_for` maps: the role path. Anything else: the clamp. Only the role
path and the ownership gate read the config, so a request that cannot reach
them never pays for an account-management call. The recursion guard compares
the GTS family (everything before the first `~`), not a substring, so another
vendor's type that merely contains the words is not exempted.

**ADRs**: `cpt-studio-adr-roles-over-tenant`

#### Not knowing is not "tenant"

- [x] `p2` - **ID**: `cpt-studio-principle-authz-plugin-unreadable-denies`

A config read has three outcomes. Absent: the organization never opted into
roles, and tenant behaviour is correct. Found: decide from it. Unreadable — the
read failed or the document did not parse: deny, because answering an outage
with tenant behaviour would hand every privilege to anybody who reaches the
organization for as long as account-management is unwell.

**ADRs**: `cpt-studio-adr-a-role-narrows-what-a-member-may-do`

#### The owner's authority is definitional

- [x] `p2` - **ID**: `cpt-studio-principle-authz-plugin-owner-definitional`

A grant with role `owner` carries every privilege whatever the document's role
ladder says. A document written before the ladder was seeded defines no `owner`
role, and resolving authority through it would strip its owner of
`access.manage` and leave nobody able to repair it.

#### Reach may widen; it never narrows on failure

- [x] `p2` - **ID**: `cpt-studio-principle-authz-plugin-reach`

The reachable tenants always include the token's tenant, which is what the clamp
always was — service accounts have a tenant and no memberships. Member
organizations are added from `OrganizationReader`, which counts active
memberships only. A failed membership read keeps the token's tenant alone rather
than denying: a database hiccup must not look like a revoked membership.

### 2.2 Constraints

#### Membership is cached for ten seconds

- [x] `p2` - **ID**: `cpt-studio-constraint-authz-plugin-membership-cache`

The plugin runs on every request, and a membership read per request would put a
query in front of every call through the gateway. A subject's organizations are
cached for 10 seconds and dropped as soon as `studio-user`'s membership
generation moves, which every membership write bumps. The age is only a
backstop; the generation is what makes a write visible at once.

#### Only domain objects are role-gated

- [x] `p2` - **ID**: `cpt-studio-constraint-authz-plugin-no-mapping`

`privilege_for` maps one resource type: domain objects (`read` →
`domain.view`, `write` → `domain.edit`, ADR-0035). Every other request is
answered by the clamp or the ownership gate. Team grants are matched against an
empty team list until teams are resolved.

## 3. Technical Architecture

### 3.1 Domain Model

- [x] `p2` - **ID**: `cpt-studio-entity-authz-plugin-grant`

The plugin reads the access config's `model`, its `roles` (a key and its
privileges) and its `grants` (`subjectType` `member` or `team`, `subjectId`,
`roleKey`, `scopeType` `org` or `project`, `scopeId`). The shape and its writer
are `cpt-studio-component-access-config`'s. A role decision is one of: the
clamp; deny; or narrow to a set of project scopes.

### 3.2 Component Model

The plugin is one component; the access-config write gate is part of it.

`decide_access_config_write` answers a write or delete of
`gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~`. The
organization is the tenant that *owns the document*, read from the resource's
`OWNER_TENANT_ID` property — not the token's tenant, which on this request is
the person's home tenant and would read the platform root's config, find none,
and allow. Without that property the write is denied. A platform administrator
is allowed. Otherwise the organization's config decides: no document allows (an
organization being created has no owner yet); an unreadable one denies; a found
one allows its owner, anybody when it has no owner (so an ownerless organization
can be repaired), and on the `roles` model whoever holds `access.manage`
organization-wide. An allow is the clamp.

### 3.3 API Contracts

- [x] `p2` - **ID**: `cpt-studio-interface-authz-plugin`

- **Technology**: `authz_resolver_sdk::AuthZResolverPluginClient`, in process
- **Location**: [`studio-backend/src/studio_authz_plugin/mod.rs`](../../studio-backend/src/studio_authz_plugin/mod.rs)

Published as instance `cf.studio.authz_resolver.plugin.v1` (vendor
`constructorfabric`, priority 40) through the gear's GTS publication
(`gts_publication(entities = ...)`): the runtime admits it before any
application `init`, and `init` binds the client on the ClientHub under that
instance id. The resolver picks, among the instances the persisted registry
lists and that are bound by then, the lowest priority of its vendor, and keeps
that pick for the life of the process.

So the shipped profiles give `static-authz-plugin` another vendor
(`constructorfabric-static`): with it in the running, a PDP call made before
this gear's `init` would choose the static tenant clamp for good. A call that
early now fails and is asked again. Until 2026-11-19 the instance was written
with `TypesRegistryClient::register` from `init`, which types-registry 0.6 no
longer lists to the resolver, and every decision went to the static clamp:
none of the rules below ran, and a person reached only their token's tenant.

The response is a decision and constraints. Constraints are OR-ed and the
predicates inside one are AND-ed: `OWNER_TENANT_ID IN` the reachable tenants,
plus, when the PEP declares the tenant-hierarchy capability, one
`InTenantSubtree` constraint per tenant for each of `OWNER_TENANT_ID` and
`RESOURCE_ID` the PEP supports. A project-scoped narrowing starts from the
clamp of the request's own tenant and adds `OWNER_TENANT_ID IN` the scope ids to
every constraint.

### 3.4 Internal Dependencies

| Dependency Gear | Interface Used | Purpose |
|-------------------|----------------|----------|
| `types_registry` | GTS publication | Admit the plugin instance |
| `cpt-studio-component-account-management` | SDK client, `resolve_metadata` as the caller | Read an organization's access config |
| `cpt-studio-component-user` | `OrganizationReader`, looked up on first use | Member organizations, the person's subjects, the platform-admin test, the membership generation |

`studio-user` is not a declared dependency, so init order guarantees nothing;
the reader is resolved once, on first use. Without it the clamp stays on the
token's tenant and grants match the bare subject.

### 3.5 External Dependencies

None.

### 3.6 Interactions & Sequences

#### Evaluate a request

**ID**: `cpt-studio-seq-authz-plugin-evaluate`

**Actors**: `cpt-studio-actor-member`

```mermaid
sequenceDiagram
    participant PEP as Gear (PEP)
    participant R as authz_resolver
    participant P as studio-authz-plugin
    participant U as studio-user
    participant AM as account-management
    PEP->>R: evaluate(subject, action, resource)
    R->>P: evaluate
    P->>P: Plan::for_request
    alt clamp
        P->>U: organizations_of(subject), unless cached
        P-->>R: allow, OWNER_TENANT_ID in reach (+ subtrees)
    else role path or access-config write
        P->>AM: read the access config
        P->>U: grant_keys_of(subject) — the person id and every login
        P-->>R: allow with constraints, or deny
    end
    R-->>PEP: decision + constraints
```

The role branch handles domain-object reads and writes. The access-config
write branch checks administrative authority. Other requests use the tenant
clamp unless their resource has an explicit policy.

### 3.7 Database schemas & tables

None. The plugin stores nothing; the membership cache is in memory.

### 3.8 Deployment Topology

In-process in the one `studio-backend` binary: gear `studio-authz-plugin`, deps
`types_registry`, `account_management`, config section
`gears.studio-authz-plugin` (`vendor`, `priority`; unknown fields are refused).
No shipped profile sets the section, so the defaults apply.

## 4. Additional context

Administrative authority — who may change memberships, invite, delete an
organization — is not asked of this plugin. `cpt-studio-component-user` reads
the access config itself and answers every other gear through `OrgAuthority`
(ADR-0040), because for a `tenant`-model organization the clamp admits every
member.
`cpt-studio-principle-tenant-clamp-first` is the product-level statement of the
same rule.

## 5. Traceability

- **PRD**: [Constructor Studio](../prd/constructor-studio.md)
- **Design**: [Constructor Studio](constructor-studio.md)
- **ADRs**: [ADR index](../adr/README.md)
- **Code**: [`studio-backend/src/studio_authz_plugin/mod.rs`](../../studio-backend/src/studio_authz_plugin/mod.rs)

## 6. Roles and privileges in practice

### Identity, membership and grants

Signing in identifies a person. Active organization memberships add the
organizations the person can reach. The tenant in the token also contributes
to that reach for compatibility. A grant binds a person to a role across an
organization or within one project. A role is a set of named privileges.
Grants use the canonical person ID. Legacy grants keyed by a sign-in subject
still work across the person's linked logins.

| Standard role | Privileges in the default configuration |
| --- | --- |
| Owner | All privileges. Studio maintains the organization-wide owner grant from membership. |
| Admin | All catalogue privileges except `access.manage`. |
| Editor | Reads people, connectors and secret metadata, edits documents and model objects, and holds `session.open`. |
| Viewer | The catalogue's read privileges. |

Organization and project grants can coexist. A Viewer grant in one project
and an Editor grant in another can allow domain-object reads in both and
writes in the second. A project grant carries no authority to administer an
organization. Team grant records can exist from older configurations. Team
membership does not currently contribute to the decision.

### How an operation is authorized

1. Resolve the caller and establish tenant reach.
2. For mapped resources in **Tenant** mode, apply the tenant constraints.
   **Roles** mode also requires a grant carrying the requested privilege
   within the evaluated tenant or project scope. A missing document means
   Tenant mode. An unreadable document causes a role-gated operation to fail.
3. Apply the operation's own checks. The PDP maps domain-object reads and
   writes to `domain.view` and `domain.edit`. Gears such as People, Costs,
   Environments and Kits use `OrgAuthority` for administrative decisions.
   Organization administration requires active membership unless a platform
   administrator is authorized. Ownership transfer and organization deletion
   have their own checks.

### Coverage and open work

| Area | Status |
| --- | --- |
| Identity and membership | Regression coverage includes linked logins, owner-grant projection, and rejection of administrative access after suspension. |
| Scope and policy decisions | Regression coverage includes organization and project grants, older documents, missing privileges, and the service-principal exception. |
| Admin and Team | Test coverage includes project selection, existing-owner requirements, preservation of Owner grants and assignable project roles. |
| Catalogue coverage | Map each of the 19 entries in [the catalogue](../../studio-backend/src/access_config.rs) to its actual server decisions. Verify allow and deny for each operation, including connectors, secrets, documents and IDE sessions. |
| Concurrent access edits | Individual grant changes and owner-grant synchronization check the document version and retry a conflicting write. Grant rekeying refuses a stale write. Admin → Access sends the version it loaded and shows a conflict without replacing the editor's draft. Reloading the current configuration requires an explicit action. |
| Stand verification | Exercise changes and revocation in an already signed-in session, including switching between organizations and observing suspended membership. |

The code inventory below records where named checks have been located.
Each check still needs operation-level allow and deny tests where coverage
is absent. An entry in the catalogue alone provides no coverage evidence.

| Catalogue entries | Observed check or gap |
| --- | --- |
| `people.view`, `people.invite`, `people.manage` | People handlers check the privilege for member and invitation operations. |
| `access.manage` | The organization grant service and protected access-config policy check authority. Logo updates also use this privilege. |
| `domain.view`, `domain.edit`, `domain.model` | The PDP checks object reads and writes. The model service checks administrative operations. |
| `component.registry`, `environment.manage`, `kit.manage` | Explicit checks exist for registry decisions, environment administration and kit management. |
| `cost.view`, `cost.manage` | The usage service checks organization cost reads and management operations. |
| `connector.view`, `connector.manage` | Notification sending checks `connector.manage`. Verify connection listing, creation, updates and removal against the catalogue. |
| `secret.view`, `secret.manage` | Match the credential-metadata and mutation operations to the intended privileges and scope. |
| `document.view`, `document.edit`, `session.open` | Match the document and IDE operations to the intended privileges and scope. |
