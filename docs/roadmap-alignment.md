# Q3 roadmap ↔ studio-web prototype — what is already de-risked

Reference: `studio-internal` branch `work/continue/product`,
`product/roadmap/` (Q3 MVP, 33 epics / 5 milestones, plan 2026-07-29 →
2026-11-27). This maps the roadmap's epics onto what the studio-web
exploration has already built or proven, plus the places where our prototype
**diverges from decisions recorded in the plan/PRD**.

Headline: the plan's **critical path is the identity/access spine
(E-01 → E-02 → E-03 → E-04 → E-05)** — exactly the territory this prototype
has spent its time in. Most of E-01/E-02 mechanics are demonstrated end-to-end
on real gears; E-03 (roles) is the known gap on both sides.

## Identity & access spine (critical path)

| Epic | Plan | Prototype state |
|---|---|---|
| **E-01** Identity foundation (email/password, Google & GitHub OAuth, sessions) | identity, 13 epics on the same owner | **Substantially de-risked**: OIDC Authorization Code + PKCE in the portal, `oidc-authn-plugin` validation (discovery/JWKS/claim-mapping), Keycloak in compose with realm import. Google/GitHub arrive as Keycloak identity brokering — config, not code. Email/password = Keycloak local users (shipped: `admin`/`demo`). |
| **E-02** Org / Workspace / Project provisioning with tenant scoping | identity | **Working E2E** on account-management: tenant tree (root → org → workspace), GTS tenant types with parent barriers, workspaces with GTS-validated settings metadata; Projects RG-backed (ADR-0002). Tenant scoping enforced by SecureConn — demonstrated by the self-managed visibility barrier. |
| **E-03** Access roles & permission enforcement | access | **Gap (both sides)**: prototype runs static allow-all authz. The parked "Studio PDP" session is this epic. Plan's E-03/E-05 distinction (access level ≠ company role/party) matches our domain-alignment note. |
| **E-04** Invitations, membership, seats | access | **Partially**: invite flow via the pluggable IdP contract works (echo plugin). Seats/licensing → license-resolver gear is the natural home, unexplored. |
| **E-06** Access scope separation across projects | access | Mechanism demonstrated at tenant level (AM barriers); per-project scope needs E-03's grants. |
| **E-07** Account & access admin surfaces | access | Early versions exist: portal Members / Organizations views (invite, dual-consent conversions). The plan flags E-07 as 3 days late for the preview — the portal slice (member list + invite) is exactly the carve-out the plan suggests. |
| **E-05** Party registry (people **and agents** linked to artifacts) | parties | Untouched; note AM users + S2S identities already distinguish humans/services, which the party model can build on. |

## Sources & viewer

| Epic | Prototype state |
|---|---|
| **E-08** Bitbucket connector / **E-09** GitHub connector | Workspace sources (git/GitHub/GitLab adapters, branch, clone-on-launch) prototype the repo-registration UX and plumbing. **⚠ Divergence**: our PATs are stored permanently in credstore, while the PRD (assumption 5) and E-08 decided *"read access obtained and refreshed **without Studio permanently holding host credentials**"* — the product path is OAuth-app / installation tokens. Our credstore flow remains valid for dev and for the s2s/oagw side, but E-08 must not inherit it as-is. |
| **E-10** Issue ingest (read-only shadow) | Untouched (new scope per the plan itself). |
| **E-11** Repository browser + Markdown viewer | The Theia session (studio-session gear) gives a *richer* answer than the epic asks (full IDE with Markdown editor, nested repo discovery, `.cf-workspace.toml` sources). A lightweight read-only viewer in the portal is still unbuilt — decide whether E-11 is "portal viewer" or "session deep-link". |
| **E-24** On-demand validation from the user's editor | The session infrastructure (per-workspace Theia containers + Studio extension) is the delivery vehicle candidate. |

## Documents, metrics, contracts

| Epic | Prototype state |
|---|---|
| **E-13** Document type declaration — six-part **versioned contract** | Direct beneficiary of the GTS work: types-registry + derivation/OP#12 + traits + our `x-gts-closed-derivations` (spec PR #91 / gts-rust PR #111) are the machinery for versioned, validated type contracts. |
| **E-12** Assessment contract & run orchestration | Gear substrate exists (serverless-runtime, event-broker — see the gear-coverage overlay in domain-model-ui); orchestration itself is a gap. |
| **E-14–E-20, E-25** metrics/benchmark | Untouched (ml/docs teams' territory). |
| **E-21–E-23** dashboards | Portal shell, filter panel, per-workspace dashboard = ready chassis for these surfaces. |

## PM Kit track (PM-01…PM-08)

**PM-01 (competitor register, J1) is `ready` and starts 2026-08-03 — today.**
Head start available: `studio-kit-competitive` (built earlier in this
exploration) already packages the five competitive KINDs
(COMPETITOR-REGISTER, COMPANY-PROFILE/DOSSIER, COMPARISON-MATRIX,
PRICING-BENCHMARK) and the cf-competitive-* workflows covering J1→J3 — i.e.
PM-01–PM-03's subject matter as kit artifacts. What PM-01 requires per
`rules.md` is the `kind: product-scenario` layer on top; the kit gives the
scenario author working material instead of a blank page.
`competitive-research-human-scenarios.md` on this branch is the narrative
source to retrofit.

## Flags worth raising in planning

1. **Assumption-5 conflict** (above, E-08): our PAT-in-credstore dev flow ≠
   the PRD's no-persistent-credentials decision. Cheap to resolve now, costly
   after E-08 starts.
2. **Owner load**: the plan itself says 7 parallel epics for the backend
   owner is a capacity claim, not a schedule. The prototype evidence can
   argue E-01/E-02 down from "build" to "productize a working spike" —
   the honest way to reduce that peak.
3. **Gears-aware Studio** (scenario doc on the branch): the gear-coverage
   overlay we added to domain-model-ui (126 entities → gear + full/partial/gap)
   is a first concrete artifact for exactly that discovery problem — "nobody
   can find the gears from where an application gets built".
