# gears-rust issue drafts (found while building the Studio backend, 2026-07-28)

Ready to paste into `constructorfabric/gears-rust`. All three were hit during a real
integration (see `studio-web/studio-backend`), reproduction is deterministic.

---

## 1. types-registry: static-entity registration failures hide the actual cause

**Title:** `types-registry: config.entities registration errors are logged as generic "Request validation failed"`

**Body:**

When a static GTS entity from `types-registry.config.entities` fails to register, the
gear logs only the canonical summary:

```
ERROR types_registry::gear: Failed to register static GTS entity
      gts_id="gts.cf.core.am.tenant_type.v1~cf.studio.organization.v1~"
      error=invalid_argument: Request validation failed
```

The real cause (here: a 4-part GTS segment — `cf.studio.organization.v1` is missing the
namespace part) lives in `InvalidArgument::FieldViolations`, which `Display` collapses
to the fixed string `"Request validation failed"`
(`toolkit-canonical-errors/src/error.rs:154`). The gear logs `error = %error`
(`types-registry/src/gear.rs` static-entity loop), so field violations never reach the
operator. Debugging this required reading `gts-id` sources.

**Proposal:** in the static-entity error loop, log the field violations (or
`Debug`-format the canonical error). Same applies to `ReadyCommitFailed` handling.

**Impact:** any operator seeding entities via config gets an unactionable error string.

---

## 2. account-management: OpenAPI artifact paths disagree with registered routes

**Title:** `account-management: docs/account-management-v1.yaml uses /api/... prefix, actual routes have none`

**Body:**

The OpenAPI artifact `gears/system/account-management/docs/account-management-v1.yaml`
declares paths like:

```
/api/account-management/v1/me
/api/account-management/v1/tenants/{tenant_id}/users
```

The code registers (via `OperationBuilder`):

```
/account-management/v1/me            (src/api/rest/routes/me.rs:17)
/account-management/v1/tenants       (src/api/rest/routes/tenants.rs:15)
```

Behind the api-gateway (`prefix_path: /cf`) the effective URLs are
`/cf/account-management/v1/...`. A client generated from the docs artifact 404s on
every call. The served OpenAPI at `/cf/docs` is correct — only the committed artifact
drifts.

**Proposal:** regenerate the committed artifact from the served OpenAPI (or add a CI
contract test diffing the two — `api_contracts` workflow looks like the natural home).

---

## 3. account-management: PRD §5.6 names the wrong membership resource type

**Title:** `account-management PRD §5.6: user-group membership resource type should be the RG member-handle, not the AM user schema`

**Body:**

PRD §5.6 ("User Group Resource Group Type Registration") says `allowed_memberships`
must include the platform user resource type `gts.cf.core.am.user.v1~`.

The implementation registers the RG **member-handle type**
`gts.cf.core.rg.type.v1~cf.core.am.user.v1~` (`account-management-sdk/src/gts.rs:99`,
`USER_RG_TYPE_CODE`) and RG's `add_membership` validates against that. Calling

```
POST /resource-group/v1/memberships/{group}/gts.cf.core.am.user.v1~/{user}
```

as the PRD suggests returns 400 `invalid_argument`; with
`gts.cf.core.rg.type.v1~cf.core.am.user.v1~` it succeeds (verified live).

**Proposal:** fix PRD §5.6 (and the user_group schema description in
`docs/schemas/user_group.v1.schema.json` if it repeats the bare id) to name the
member-handle type explicitly. The code behaviour is correct and should not change.
