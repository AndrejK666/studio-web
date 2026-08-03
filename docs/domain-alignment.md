# Portal ↔ Studio Product Domain Model — alignment

Reference: `studio-internal/domain-model-ui/model.md` (draft-v0.9.25).
Purpose: name what the portal already is in the model's terms, adapt light
surfaces now, and mark honest gaps for later. The portal is the **control
plane** of the model — it manages citizens (§3, layer 1); graph surfaces
(views, findings, graph) belong to the workspace context (Theia + future).

| Model entity (facing) | Portal today | Verdict / action |
|---|---|---|
| **Tenant** (1:1 Organization, admin-facing) | Child tenants under the platform root; nav "Organizations" | ✔ matches. Root tenant + children = the model's **tenant admin hierarchy** (`Tenant → administers → Tenant`, control-plane only, MSP topology §3.1.1). Subtitle now says so. |
| **Workspace** (user-facing) | AM tenant of type workspace; dashboard, sessions | ✔ matches ("working context, one purpose"). Owns-one-graph — future. |
| **Project** (managed object of type Project!) | RG group with `workspace_id` metadata (ADR-0002) | ⚠ interim. Model wants Project as a **graph object**; RG-backed stays until the graph exists. Subtitle notes it. |
| **Member** (control-plane citizen) | AM users per tenant, invite flow | ✔ control-plane part matches. Missing: Person stand-in per workspace (kit-created), Role Grants (below). |
| **Team** (citizen, grantee of roles) | — | Gap (control-plane). Candidate: RG user-group container already in the stack. |
| **Role / Role Grant / Permission** (RBAC, §5) | static-authz allow-all | Gap — parked as "Studio PDP" session. Members view hints at Role Grants. |
| **Connector / Source System** (§4) | Workspace sources: local folders + git repos → `.cf-workspace.toml`; PATs in credstore | ≈ the ingress path for repositories. Card renamed **Workspace sources** (same term the Theia extension uses). Full Connector (sync runs, identity mapping) — future gears. |
| **Knowledge Graph / Managed Object / Relation** (§3.2) | — (Theia Workspace Graph view exists in the IDE) | Gap at portal level; "coming soon" card renamed to **Knowledge Graph** to reserve the surface. |
| **Workflow / Action / Finding** (trust ramp §6) | `automation_level` in workspace settings: manual / recommendations / autonomous | ⚠ naming aligned: our three levels ARE the trust ramp (read-only insight → recommendations → approved automation). Dashboard card explains the mapping; Findings surface reserved. |
| **Kit** (§7) | studio-kit-competitive / -pm exist as repos; no portal surface | Gap; "coming soon" card reserved (Kits & ontology). |
| **View** (§3.3) | Portal pages are hand-built | Portal pages ≈ built-in views; saved views — future. |
| **Approval / Validator / Evidence** (§6.1) | Dual-consent tenant conversions (AM) is the only approval flow shipped | Conversions stay; the general approval machinery arrives with workflows. |
| **Audit Entry** | AM/RG audit exists server-side | Portal surface gap (System view could expose it later). |
| **AI Run / Cost** (§6.3) | mini-chat SSE, no metering surface | Gap — future oagw/usage-collector integration. |

## Adaptations applied now (frontend only)

1. Organizations view: subtitle names the **tenant admin hierarchy** (control
   plane, administers-not-data) instead of generic wording.
2. Workspace dashboard:
   - "Automation settings" → **"Automation — trust ramp"** with the level ↔
     ramp mapping spelled out (manual = read-only insight, recommendations =
     prepared actions, autonomous = approved automation).
   - "Repositories" card header → **"Workspace sources"** (model §4 ingress +
     Theia's Workspace Sources; same `.cf-workspace.toml`).
   - Coming-soon cards renamed to reserve model surfaces: **Knowledge Graph**,
     **Findings & recommendations**, **Workflow runs**, **Kits & ontology**.
3. Projects view: subtitle marks RG-backing as interim vs "managed object of
   type Project" (ADR-0002 note).
4. Members view: subtitle mentions Role Grants as the coming access model.

## Deliberately NOT adapted

- No renaming of backend gears/APIs — the model is a product-domain layer;
  the platform (AM/RG/GTS) is the kernel side it leans on.
- No fake graph/finding stubs with mock data — surfaces are reserved by name
  only ("coming soon"), per the model's own trust-ramp discipline.
