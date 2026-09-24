# ADR-0001: Identity mapping for external systems — Studio domain gear, not an IdP plugin

Status: **proposed** · Date: 2026-07-28 · Deciders: Studio backend team

## Context

The Studio v2 model (STUDIO_REPRESENTATION_MODEL, vision) requires one tenant-wide
identity per person: records pulled by connectors from Jira, GitLab, HRIS etc. must be
attributed to the same platform user ("identity mapping" → Managed Objects). The
platform deliberately splits identity concerns:

- **account-management (AM)** coordinates user lifecycle but owns no identity data
  (PRD §3.4: "IdP is the single source of truth"; no profiles, no local projection).
- **The IdP contract** is a narrow outbound interface: provision/deprovision tenants
  and users, tenant-scoped query. It is a lifecycle hook to an external identity
  provider, not a data store.
- Verified empirically (see README "Verified end-to-end"): AM passes through
  IdP-issued UUIDs and stores nothing else about the person.

Nobody in the current platform owns the mapping `external identity (system, ref) →
platform user`. Someone must.

## Options considered

**A. Extend the IdP plugin.** Teach the (future, OIDC-backed) IdP plugin to also
answer "which platform user is jira:jsmith?".
- Wrong interface shape: the IdP contract has no mapping/query surface; every consumer
  would depend on a vendor plugin for domain data.
- Mapping needs its own storage, listing, and review workflow — a plugin has no
  database capability of its own and no REST surface.
- Couples Studio's domain to whichever IdP vendor is deployed.

**B. A Studio domain gear (`studio-identity`).** Own gear with its own schema,
REST/SDK surface, and SecureConn tenant isolation.
- Mapping is genuinely domain data: many-to-one links with per-link provenance
  (which connector, when), confidence (exact email match vs. heuristic), lifecycle
  (proposed → confirmed → retired), and audit. That is a gear-shaped problem.
- Gets the platform for free: tenant-WHERE via SecureConn, OData listing, canonical
  errors, outbox for async reconciliation, OpenAPI.
- Precedent: AM itself delegates group structure to resource-group rather than
  inflating a neighbour — same separation logic applies here.

**C. Fold into the future `studio-graph` gear.** Identity links as ordinary graph edges.
- Premature coupling: graph doesn't exist yet; identity mapping blocks connectors
  earlier. Also mapping has write/review semantics (confirm/reject) that plain graph
  edges don't.

## Decision

**Option B: a dedicated `studio-identity` gear.** First Studio domain gear.

Core model (v0.1):

```text
IdentityLink {
  id, tenant_id,                       -- SecureConn scope
  platform_user_id: Uuid,             -- IdP-issued UUID (as surfaced by AM)
  system: str,                         -- "jira" | "gitlab" | "hris" | ... (GTS instance)
  external_ref: str,                   -- account id / username / email in that system
  status: proposed | confirmed | retired,
  matched_by: connector | rule | human,
  confidence: 0..1, evidence: json,    -- how the match was made
  created_at / confirmed_by / audit
}
UNIQUE (tenant_id, system, external_ref)
```

REST (draft): `POST/GET /studio-identity/v1/links` (OData filter by user/system/status),
`PATCH …/links/{id}` (confirm/reject), `GET …/resolve?system=&external_ref=` (hot path
for connectors). SDK crate for gear-to-gear use by future connector/graph gears.

Boundaries: the gear stores **links, not people** — display names/emails stay in the
IdP; AM remains the door for user lifecycle; auto-matching rules run inside the gear
but ambiguous matches always land as `proposed` for human review (mirrors the
"research result ≠ decision" principle used elsewhere in Studio).

## Consequences

- (+) Connectors get a single resolve endpoint; graph attribution has one owner.
- (+) Tenant isolation and audit inherited from the platform, not reimplemented.
- (−) One more gear to build and operate; needs its own PRD/DESIGN per gears-rust rules
  (studio-kit-gears artifact chain applies).
- (−) Until an OIDC IdP plugin exists, `platform_user_id` values come from the echo
  IdP (deterministic UUIDs) — fine for dev, revisit before production.

## Follow-ups

1. Write PRD/DESIGN for `studio-identity` using the gears SDLC kit (UPSTREAM_REQS →
   PRD → ADR/DESIGN → DECOMPOSITION).
2. Decide the `system` catalog shape (GTS instances vs. plain enum) with the gears team.
3. Define the connector contract that feeds `proposed` links (bulk import + dedup).
