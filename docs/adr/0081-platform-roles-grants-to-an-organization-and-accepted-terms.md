---
type: adr
status: proposed
date: 2026-11-27
---

# ADR-0081: The platform has roles of its own, grants resources to an organization, and asks people to accept its terms

**ID**: `cpt-studio-adr-platform-roles-grants-and-terms`

Status: **proposed** · Date: 2026-11-27 · Builds on `cpt-studio-adr-a-role-narrows-what-a-member-may-do` (ADR-0019), `cpt-studio-adr-one-owner-for-people-and-membership` (ADR-0040), `cpt-studio-adr-component-tiers` (ADR-0042), `cpt-studio-adr-core-knows-no-kit` (ADR-0079)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Drivers](#decision-drivers)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. Platform roles](#1-platform-roles)
  - [2. A platform resource granted to an organization](#2-a-platform-resource-granted-to-an-organization)
  - [3. Terms a person accepts](#3-terms-a-person-accepts)
  - [4. Who keeps it, and how the rest of Studio asks](#4-who-keeps-it-and-how-the-rest-of-studio-asks)
- [Phases](#phases)
- [Consequences](#consequences)
- [Confirmation](#confirmation)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

Glasshouse (`docs/glasshouse-plan.md`) is a Studio installation in which a
vendor opens its code to partner companies. In Studio's terms the vendor is the
platform and each company is an organization. The user stories need three
things the core does not have:

- **The vendor's people work in roles of their own.** An operator runs the
  instance, a code owner publishes code, an account manager runs the
  relationship with companies (stories OP, CO, AM). Studio has one platform
  role: the administrator, who is a member of the platform root (ADR-0018 §3).
  Making the vendor's people members of the root would make every one of them
  an administrator.
- **The vendor opens a resource to one company.** The account manager enables
  repos for a company from those the code owners made available (AM-2). The
  platform tier is read by every organization or by none (ADR-0042); nothing
  says "this one, for that organization".
- **A person accepts terms before anything opens.** A company admin accepts the
  terms and conditions at first sign-in (CA-1), and each developer the terms of
  use (DV-1), with the version recorded. Studio has no such record.

## Decision Drivers

- Nothing that works today changes. A Studio deployment that uses none of this
  behaves exactly as before.
- A platform role never makes a platform administrator, and never widens what
  an organization's member may do inside it (ADR-0019 §1: roles narrow).
- People and what they hold have one owner, studio-user (ADR-0040).
- Kits read the answers through a port; the core names no kit (ADR-0079).
- Every change is audited (the audit port, `studio-backend/src/audit.rs`).

## Considered Options

1. **Platform roles as roles of a membership of the root.** Rejected: today
   any membership of the root is administration (`is_platform_admin`), and
   making it depend on the role would change what every existing
   administrator's membership means.
2. **Platform roles and grants as grants in the root's access config.**
   Rejected: that document is the PDP's for an organization's members
   (ADR-0019), and a grant there reads as a member's privilege inside the root.
3. **Three records of their own in studio-user** (chosen): platform roles,
   grants to an organization, terms and their acceptance.

## Decision Outcome

Chosen option: **3**.

### 1. Platform roles

- A **platform role** is held by a person (the canonical person id,
  ADR-0025): `operator`, `code_owner`, `account_manager`. The list is closed;
  a new role is a change to this record.
- It is **not a membership**: holding one does not make a person a member of
  the root, so it never makes a platform administrator.
- A **platform administrator holds every platform role** without being given
  one.
- **Only a platform administrator** gives or takes a platform role.
- A platform role decides what a person may do on the platform's own pages
  and records. It grants nothing inside an organization.

### 2. A platform resource granted to an organization

- A **grant** names a kind, a resource and an organization:
  `(kind, resource, organization)`, for example
  `("repository", "<repo id>", <company>)`. The kind is a kit's word; the
  core keeps the grant and does not interpret it.
- **Who grants:** a platform administrator or an `account_manager`. Taking a
  grant back removes it; the audit keeps that it existed.
- **Who reads:** the platform's people (an administrator or any platform role)
  read every grant; a member of an organization reads the grants to their own
  organization.
- A kit that guards a platform resource asks the port whether the resource is
  granted to the caller's organization, in its own access rule (ADR-0079 §4,
  `ServiceRule`). The core keeps the record; the kit decides what a grant
  opens.

### 3. Terms a person accepts

- **Terms** are a text the platform publishes for an **audience**:
  `organization_admin` (an organization's owners and administrators) or
  `member` (every member of an organization). Each publication is a new
  **version** of that audience's terms; nothing is edited in place.
- **Who publishes:** a platform administrator or an `operator`.
- A person **accepts** the latest version for an organization; studio-user
  records who, which organization, which audience, which version, and when.
- **Pending terms** are, for a person in an organization, the latest version of
  each audience that applies to them and that they have not accepted.
- **No terms published, nothing pending**: a Studio deployment that never
  publishes terms gates nothing.
- **Where it is enforced.** Phase 1: opening an IDE session (the way to code)
  is refused while terms are pending, and the portal reads the pending terms to
  show the onboarding page. Phase 2: every organization-scoped request
  (`org_scope`) answers only the onboarding routes while terms are pending.

### 4. Who keeps it, and how the rest of Studio asks

- studio-user keeps all three, in its own database, beside memberships
  (ADR-0040).
- It publishes a **port** in the ClientHub (`PlatformAccessPort`). P1 asks
  it one thing, the pending terms; a method is added when a gear needs one
  (the kits' grant reads in P3). Kits and core gears ask it; none reads the
  tables.
- Every change (a role given or taken, a grant made or removed, terms published
  or accepted) is an audit event.

## Phases

1. **P1 (this record):** the three records, the port, REST for the platform's
   pages and for a person's own terms, audit events. The session gate on
   pending terms.
2. **P2:** the `org_scope` gate on pending terms; the portal's vendor pages
   and onboarding page.
3. **P3:** kits' access rules on grants (`vendor-code`: a company reads only
   the repos granted to it).

## Consequences

- Good: a Studio deployment that uses none of it is unchanged.
- Good: Glasshouse's vendor roles, enabled repos and terms rest on one record
  each, kept where people are kept.
- Bad: a second kind of "role" beside an organization's roles; the names keep
  them apart (platform roles are never written in an access config).
- Bad: until P2, only the session gate enforces the terms.

## Confirmation

- studio-user's tests: a platform role does not make an administrator; an
  administrator holds every role; only an administrator assigns; a grant is
  made by an administrator or an account manager and refused to anybody else;
  a member reads only their organization's grants; publishing makes a new
  version; acceptance clears what is pending; nothing published, nothing
  pending.
- studio-session: the launch asks the port after `may_reach` and before reusing a session; refusal is `TERMS_NOT_ACCEPTED` (400, failed precondition). To be checked on a stand: the session unit tests run without account-management, so they cannot reach the gate.

## Traceability

- Records and port: `studio-backend/src/user_profile/platform_access.rs`.
- Routes: `studio-backend/src/user_profile/platform_rest.rs`.
- Migration: `studio-backend/src/user_profile/migrations.rs` (`m0009`).
- Plan: `docs/glasshouse-plan.md`, "Core adaptations to start", A2–A4.
