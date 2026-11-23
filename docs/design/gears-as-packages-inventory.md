---
type: design
status: proposed
owner: studio-team
---

# Gears as packages — the inventory

What each gear is today as a package: the evidence behind
[gears as packages](gears-as-packages.md) and
[ADR-0076](../adr/0076-gears-are-published-packages-and-a-platform-release-is-a-bom-version.md).
The same rows, with more columns, are in
[`gears-as-packages-inventory.csv`](gears-as-packages-inventory.csv).

## How it was taken (2026-11-23)

- **The corpus**: a fresh `git clone --filter=blob:none` of
  `AndrejK666/gears-rust` at `75f5d9eaffe1a78552e004dfed0aab14cbb266d7`, the
  `[gears_rust]` commit of `platform-release.toml`. Every `gear.gdl` and
  `gear.toml` in it is a row: 65 passports, 55 of gears with code, 9 design-only
  passports (`implementation = "design"`, no `package`) and one `gear.toml`
  (`bss-orders`). The gear id is the `name` of the crate's
  `#[toolkit::gear(...)]` (the attribute `attr` names, else the first one in
  `src/`), and the `id` of a design passport.
- **Studio's product**: the root `product.gdl` of `fork-main` (`772140ec`): 16
  gears and 9 plugins from `gears-rust`, closed over the passports' and the
  attributes' `deps` (the closure adds none), and 48 gears from
  `studio-backend`. "Studio lock" is the version `studio-backend/Cargo.lock`
  links.
- **crates.io**: the sparse index (`https://index.crates.io/`) for every gear
  crate, SDK and internal dependency, one request at a time; the versions API
  for publish dates; and one `.crate` per gear crate (the latest stable),
  listed with `tar tzf`. "First version with `gear.gdl`" is a binary search over
  the crate's versions in publish order; the versions Studio's lock names were
  downloaded and listed too.
- **Dependencies**: a gear's internal dependencies are the gears-rust crates it
  reaches through its own and its SDKs' `[dependencies]` and
  `[build-dependencies]` (with `workspace = true` resolved against the root
  manifest), transitively. "All on crates.io" means every one of them is
  published there; third-party crates always are.

## What it says

1. **The passport is already in the package.** gears-rust#4793 ("Introduce
   GDL") was merged upstream on 2026-10-24, and since the release of
   2026-10-28 every gear crate release-plz publishes carries its `gear.gdl`:
   cargo packages every file in the crate's directory, and no gear crate sets
   `include` or `exclude`. Of the 47 corpus gears on crates.io, 46 have a
   passport in their latest `.crate` (`cf-gears-mini-chat` carries three: its
   own and its two plugins'). Every gears-rust gear of Studio's product has its
   passport inside the very version Studio's lock links.
2. **One published gear has no passport**: `event-broker`. Its `gear.gdl`
   sits in `gears/system/event-broker/`, one level above the crate
   (`package.path = "./event-broker"`), and cargo cannot package a file
   outside the crate.
3. **Nine gears with code are not on crates.io.** Two are toolkit examples
   (`api-contracts`, `api-contracts-consumer`). The other seven are
   `admission-control` and `policy-engine` (`publish = false`) and the five BSS
   gears (`bss-approvals`, `bss-ledger`, `bss-orders`, `bss-pricing`,
   `bss-products`), whose crates have no `version` and so cannot be published at
   all. Publishing those seven takes 17 crates, their SDKs and libraries
   included (`cf-gears-bss-coord`, `-rest`, `-approval`,
   `cf-gears-toolkit-policy-evaluation`, …).
4. **Nine passports describe gears with no code** (`approval-service`,
   `bss-contracts`, `bss-rating`, `bss-subscriptions`,
   `infrastructure-resource-manager`, `llm-gateway`, `model-registry`,
   `serverless-runtime`, `simple-resource-registry`). They are not packages
   today.
5. **The corpus is older than what Studio links.** For every gears-rust gear
   of the product, the corpus version is below the lock's: `oagw` 0.6.2 against
   0.8.1, `account-management` 0.11.2 against 0.13.1, `types-registry` 0.5.2
   against 0.6.2, and crates.io is ahead of both (toolkit 0.15.0 was published
   today; Studio links 0.13.1). The corpus is two commits on top of the
   upstream release commit `009fdc7c` (toolkit 0.12.0), and the fix of its tip
   (`quota-enforcement-storage-plugin` names `types-registry`) is in the
   published 0.4.4.
6. **Names.** Most gears follow `cf-gears-<id>`. The exceptions:
   - `graph-storage` is on crates.io twice: `cf-gears-graph-storage` (0.4.1,
     from `constructorfabric/gears-rust`) and `weftgraph` (from
     `vasylcf/gears-rust`), both with lib `graph_storage`. Studio links
     `weftgraph` `=0.4.0-rc.3`;
   - `chat-engine` is `cf-chat-engine`, and the cluster providers its passport
     lists are `cf-postgres-cluster-plugin`, `cf-redis-cluster-plugin`,
     `cf-k8s-cluster-plugin`;
   - `static-mini-chat-audit-plugin` and `static-mini-chat-model-policy-plugin`
     live inside `cf-gears-mini-chat`;
   - Studio's 47 own gears are modules of one crate, `cf-studio-backend`.
7. **Docs and charts are not in the packages.** A gear family keeps `docs/`
   beside its crates (`gears/system/oagw/docs/`), not inside one, so no `.crate`
   has them; the engine then falls back to the passport's `source = git(...)`
   URL. `cluster`'s passport names a `helm_chart(path = "deploy/helm/cluster")`
   that is in neither the corpus directory nor the package.

| | Gears | Notes |
|---|---|---|
| Passports in the corpus | 65 | 55 with code, 9 design-only, 1 `gear.toml` |
| On crates.io | 47 | in 45 crates |
| … with `gear.gdl` in the latest `.crate` | 46 | all since 2026-10-28 |
| … without a passport | 1 | `event-broker` |
| Not on crates.io, would go to our registry | 7 | 17 crates with their SDKs and libraries |
| Examples, not shipped | 2 | `api-contracts`, `api-contracts-consumer` |
| Design-only, no package | 9 | a passport-only package later, if wanted |
| Studio product, from gears-rust | 25 | all on crates.io with a passport at the locked version |
| Studio product, its own | 48 | the product's code, a path source |

## The gears

Sorted by their place in Studio's product (product, plugin), then by directory.
"Our registry": `no` means the gear is consumed from crates.io as published;
`yes` that it is published to the `gears` registry with the changes listed;
`passport` that the code is on crates.io and only its passport is missing;
`later` a design-only passport.

| Gear id | Directory | Crate in the corpus (version) | In Studio | crates.io: versions (first..latest) | Studio lock | Passport in latest `.crate` | First version with `gear.gdl` | Deps all on crates.io | Our registry | Changes / notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `credstore` | `gears/credstore/credstore` | `cf-gears-credstore` 0.6.2 | product | 31 (0.1.22..0.8.1) | 0.7.2 | gear.gdl | 0.6.0 (2026-10-28) | yes | no | — |
| `file-storage` | `gears/file-storage/file-storage` | `cf-gears-file-storage` 0.4.1 | product | 21 (0.1.0..0.5.1) | 0.4.6 | gear.gdl | 0.3.0 (2026-10-28) | yes | no | — |
| `graph-storage` | `gears/graph-storage/graph-storage` | `cf-gears-graph-storage` 0.2.2 | product | 9 (0.1.4..0.4.1) | — | gear.gdl | 0.2.0 (2026-10-28) | yes | no | also published as `weftgraph` (vasylcf fork), which Studio links |
| `mini-chat` | `gears/mini-chat/mini-chat` | `cf-gears-mini-chat` 0.5.2 | product | 28 (0.1.31..0.6.1) | 0.5.5 | gear.gdl x3 | 0.5.0 (2026-10-28) | yes | no | — |
| `simple-user-settings` | `gears/simple-user-settings/simple-user-settings` | `cf-gears-simple-user-settings` 0.3.2 | product | 16 (0.1.0..0.4.1) | 0.3.5 | gear.gdl | 0.3.0 (2026-10-28) | yes | no | — |
| `account-management` | `gears/system/account-management/account-management` | `cf-gears-account-management` 0.11.2 | product | 34 (0.1.1..0.15.0) | 0.13.1 | gear.gdl | 0.11.0 (2026-10-28) | yes | no | — |
| `api-gateway` | `gears/system/api-gateway` | `cf-gears-api-gateway` 0.7.0 | product | 31 (0.2.7..0.7.6) | 0.7.4 | gear.gdl | 0.6.0 (2026-10-28) | yes | no | — |
| `authn-resolver` | `gears/system/authn-resolver/authn-resolver` | `cf-gears-authn-resolver` 0.2.40 | product | 30 (0.2.16..0.3.4) | 0.3.2 | gear.gdl | 0.2.38 (2026-10-28) | yes | no | — |
| `authz-resolver` | `gears/system/authz-resolver/authz-resolver` | `cf-gears-authz-resolver` 0.3.2 | product | 31 (0.1.23..0.5.1) | 0.4.2 | gear.gdl | 0.3.0 (2026-10-28) | yes | no | — |
| `grpc-hub` | `gears/system/grpc-hub` | `cf-gears-grpc-hub` 0.4.2 | product | 29 (0.2.6..0.5.4) | 0.5.2 | gear.gdl | 0.4.0 (2026-10-28) | yes | no | — |
| `nodes-registry` | `gears/system/nodes-registry/nodes-registry` | `cf-gears-nodes-registry` 0.1.46 | product | 27 (0.1.25..0.1.51) | 0.1.49 | gear.gdl | 0.1.44 (2026-10-28) | yes | no | — |
| `oagw` | `gears/system/oagw/oagw` | `cf-gears-oagw` 0.6.2 | product | 31 (0.2.25..0.10.0) | 0.8.1 | gear.gdl | 0.6.0 (2026-10-28) | yes | no | — |
| `resource-group` | `gears/system/resource-group/resource-group` | `cf-gears-resource-group` 0.4.8 | product | 29 (0.1.3..0.6.0) | 0.4.11 | gear.gdl | 0.4.6 (2026-10-28) | yes | no | — |
| `tenant-resolver` | `gears/system/tenant-resolver/tenant-resolver` | `cf-gears-tenant-resolver` 0.1.44 | product | 29 (0.1.21..0.2.4) | 0.2.2 | gear.gdl | 0.1.42 (2026-10-28) | yes | no | — |
| `types-registry` | `gears/system/types-registry/types-registry` | `cf-gears-types-registry` 0.5.2 | product | 30 (0.1.22..0.8.0) | 0.6.2 | gear.gdl | 0.5.0 (2026-10-28) | yes | no | — |
| `usage-collector` | `gears/system/usage-collector/usage-collector` | `cf-gears-usage-collector` 0.5.2 | product | 26 (0.1.0..0.7.0) | 0.5.5 | gear.gdl | 0.5.0 (2026-10-28) | yes | no | — |
| `static-credstore-plugin` | `gears/credstore/plugins/static-credstore-plugin` | `cf-gears-static-credstore-plugin` 0.2.18 | plugin | 28 (0.1.18..0.2.23) | 0.2.21 | gear.gdl | 0.2.16 (2026-10-28) | yes | no | — |
| `static-mini-chat-audit-plugin` | `gears/mini-chat/mini-chat/src/infra/plugins/static_audit` | `cf-gears-mini-chat` 0.5.2 | plugin | 28 (0.1.31..0.6.1) | 0.5.5 | gear.gdl x3 | 0.5.0 (2026-10-28) | yes | no | lives inside package cf-gears-mini-chat |
| `static-mini-chat-model-policy-plugin` | `gears/mini-chat/mini-chat/src/infra/plugins/static_model_policy` | `cf-gears-mini-chat` 0.5.2 | plugin | 28 (0.1.31..0.6.1) | 0.5.5 | gear.gdl x3 | 0.5.0 (2026-10-28) | yes | no | lives inside package cf-gears-mini-chat |
| `keycloak-idp-plugin` | `gears/system/account-management/plugins/keycloak-idp-plugin` | `cf-gears-keycloak-idp-plugin` 0.2.2 | plugin | 17 (0.1.0..0.2.8) | 0.2.6 | gear.gdl | 0.2.0 (2026-10-28) | yes | no | — |
| `static-idp-plugin` | `gears/system/account-management/plugins/static-idp-plugin` | `cf-gears-static-idp-plugin` 0.1.21 | plugin | 27 (0.1.0..0.1.26) | 0.1.24 | gear.gdl | 0.1.19 (2026-10-28) | yes | no | — |
| `oidc-authn-plugin` | `gears/system/authn-resolver/plugins/oidc-authn-plugin` | `cf-gears-oidc-authn-plugin` 0.3.2 | plugin | 25 (0.1.0..0.6.1) | 0.5.1 | gear.gdl | 0.3.0 (2026-10-28) | yes | no | — |
| `static-authn-plugin` | `gears/system/authn-resolver/plugins/static-authn-plugin` | `cf-gears-static-authn-plugin` 0.3.21 | plugin | 27 (0.3.0..0.4.3) | 0.4.1 | gear.gdl | 0.3.19 (2026-10-28) | yes | no | — |
| `static-authz-plugin` | `gears/system/authz-resolver/plugins/static-authz-plugin` | `cf-gears-static-authz-plugin` 0.1.41 | plugin | 27 (0.1.20..0.2.3) | 0.2.1 | gear.gdl | 0.1.39 (2026-10-28) | yes | no | — |
| `rg-tr-plugin` | `gears/system/tenant-resolver/plugins/rg-tr-plugin` | `cf-gears-rg-tr-plugin` 0.1.24 | plugin | 27 (0.1.3..0.3.0) | 0.2.2 | gear.gdl | 0.1.22 (2026-10-28) | yes | no | — |
| `api-contracts` | `examples/toolkit/api-contracts/api-contracts` | `cf-api-contracts` 0.1.2, publish=false | — | — | — | - | — | no: cf-api-contracts-sdk | no (example) | package cf-api-contracts != cf-gears-api-contracts. a toolkit example, not a shipped gear; drop `publish = false` (set `publish = ["gears"]`); path deps -> version deps: cf-gears-authn-resolver cf-gears-static-authn-plugin cf-gears-types-registry; publish its unpublished deps first: cf-api-contracts-sdk; `include` gear.gdl and docs/ |
| `api-contracts-consumer` | `examples/toolkit/api-contracts/api-contracts-consumer` | `cf-api-contracts-consumer` 0.1.2, publish=false | — | — | — | - | — | no: cf-api-contracts-sdk | no (example) | package cf-api-contracts-consumer != cf-gears-api-contracts-consumer. a toolkit example, not a shipped gear; drop `publish = false` (set `publish = ["gears"]`); path deps -> version deps: cf-gears-authn-resolver cf-gears-static-authn-plugin cf-gears-types-registry; publish its unpublished deps first: cf-api-contracts-sdk; `include` gear.gdl and docs/ |
| `approval-service` | `gears/approval-service` | — (design) | — | — | — | n/a | — | n/a | later | design-only passport: no crate; a passport-only package `cf-gears-approval-service` (empty lib + gear.gdl + docs) if the catalogue is to list it |
| `bss-approvals` | `gears/bss/approvals/approvals` | `cf-gears-bss-approvals` (none), publish=false | — | — | — | - | — | no: cf-gears-bss-approvals-sdk cf-gears-bss-rest | yes | add `version` (none today: cargo treats it as 0.0.0, unpublishable) and `publish = ["gears"]`; path deps -> version deps: cf-gears-bss-approvals-sdk cf-gears-bss-rest; publish its unpublished deps first: cf-gears-bss-approvals-sdk cf-gears-bss-rest; `include` gear.gdl and docs/ |
| `bss-contracts` | `gears/bss/contracts` | — (design) | — | — | — | n/a | — | n/a | later | design-only passport: no crate; a passport-only package `cf-gears-bss-contracts` (empty lib + gear.gdl + docs) if the catalogue is to list it |
| `bss-ledger` | `gears/bss/ledger/ledger` | `cf-gears-bss-ledger` (none), publish=false | — | — | — | - | — | no: cf-gears-bss-coord | yes | add `version` (none today: cargo treats it as 0.0.0, unpublishable) and `publish = ["gears"]`; path deps -> version deps: cf-gears-bss-coord; publish its unpublished deps first: cf-gears-bss-coord; `include` gear.gdl and docs/ |
| `bss-orders` | `gears/bss/orders` | `cf-gears-bss-orders` (none), publish=false | — | — | — | - | — | no: cf-gears-bss-orders-sdk cf-gears-bss-pricing-sdk | yes | add `version` (none today: cargo treats it as 0.0.0, unpublishable) and `publish = ["gears"]`; path deps -> version deps: cf-gears-bss-orders-sdk cf-gears-event-broker; publish its unpublished deps first: cf-gears-bss-orders-sdk cf-gears-bss-pricing-sdk; gear.toml -> gear.gdl (the engine reads gear.gdl only); move gear.gdl into the crate directory; `include` gear.gdl and docs/ |
| `bss-pricing` | `gears/bss/pricing/pricing` | `cf-gears-bss-pricing` (none), publish=false | — | — | — | - | — | no: cf-gears-bss-pricing-sdk cf-gears-bss-products-sdk cf-gears-bss-approval cf-gears-bss-rest cf-gears-bss-approvals-sdk cf-gears-bss-coord | yes | add `version` (none today: cargo treats it as 0.0.0, unpublishable) and `publish = ["gears"]`; path deps -> version deps: cf-gears-bss-pricing-sdk cf-gears-bss-products-sdk cf-gears-bss-approval cf-gears-bss-rest cf-gears-bss-approvals-sdk cf-gears-bss-coord; publish its unpublished deps first: cf-gears-bss-pricing-sdk cf-gears-bss-products-sdk cf-gears-bss-approval cf-gears-bss-rest cf-gears-bss-approvals-sdk cf-gears-bss-coord; `include` gear.gdl and docs/ |
| `bss-products` | `gears/bss/products/products` | `cf-gears-bss-products` (none), publish=false | — | — | — | - | — | no: cf-gears-bss-coord cf-gears-bss-products-sdk cf-gears-bss-approval cf-gears-bss-rest cf-gears-bss-approvals-sdk cf-gears-bss-pricing-sdk | yes | add `version` (none today: cargo treats it as 0.0.0, unpublishable) and `publish = ["gears"]`; path deps -> version deps: cf-gears-bss-coord cf-gears-bss-products-sdk cf-gears-bss-approval cf-gears-bss-rest cf-gears-bss-approvals-sdk cf-gears-bss-pricing-sdk; publish its unpublished deps first: cf-gears-bss-coord cf-gears-bss-products-sdk cf-gears-bss-approval cf-gears-bss-rest cf-gears-bss-approvals-sdk cf-gears-bss-pricing-sdk; `include` gear.gdl and docs/ |
| `bss-rate-provider-ecb-plugin` | `gears/bss/rate-provider/plugins/ecb-plugin` | `cf-gears-bss-rate-provider-ecb-plugin` 0.2.2 | — | 17 (0.1.2..0.2.7) | — | gear.gdl | 0.2.0 (2026-10-28) | yes | no | — |
| `bss-rate-provider-http-json-plugin` | `gears/bss/rate-provider/plugins/http-json-plugin` | `cf-gears-bss-rate-provider-http-json-plugin` 0.2.2 | — | 17 (0.1.2..0.2.7) | — | gear.gdl | 0.2.0 (2026-10-28) | yes | no | — |
| `bss-rate-provider` | `gears/bss/rate-provider/rate-provider` | `cf-gears-bss-rate-provider` 0.2.2 | — | 17 (0.1.2..0.2.7) | — | gear.gdl | 0.2.0 (2026-10-28) | yes | no | — |
| `bss-rating` | `gears/bss/rating` | — (design) | — | — | — | n/a | — | n/a | later | design-only passport: no crate; a passport-only package `cf-gears-bss-rating` (empty lib + gear.gdl + docs) if the catalogue is to list it |
| `bss-subscriptions` | `gears/bss/subscriptions` | — (design) | — | — | — | n/a | — | n/a | later | design-only passport: no crate; a passport-only package `cf-gears-bss-subscriptions` (empty lib + gear.gdl + docs) if the catalogue is to list it |
| `chat-engine` | `gears/chat-engine/chat-engine` | `cf-chat-engine` 0.3.11 | — | 26 (0.1.0..0.4.1) | — | gear.gdl | 0.3.9 (2026-10-28) | yes | no | package cf-chat-engine != cf-gears-chat-engine |
| `construct` | `gears/construct/construct` | `cf-gears-construct` 0.1.2 | — | 9 (0.1.0..0.2.1) | — | gear.gdl | 0.1.0 (2026-10-28) | yes | no | — |
| `file-parser` | `gears/file-parser/file-parser` | `cf-gears-file-parser` 0.2.2 | — | 29 (0.1.26..0.2.7) | — | gear.gdl | 0.2.0 (2026-10-28) | yes | no | — |
| `github-mirror` | `gears/github-mirror/github-mirror` | `cf-gears-github-mirror` 0.1.2 | — | 8 (0.1.0..0.3.1) | 0.2.1 | gear.gdl | 0.1.0 (2026-10-28) | yes | no | — |
| `infrastructure-resource-manager` | `gears/infrastructure-resource-manager` | — (design) | — | — | — | n/a | — | n/a | later | design-only passport: no crate; a passport-only package `cf-gears-infrastructure-resource-manager` (empty lib + gear.gdl + docs) if the catalogue is to list it |
| `llm-gateway` | `gears/llm-gateway` | — (design) | — | — | — | n/a | — | n/a | later | design-only passport: no crate; a passport-only package `cf-gears-llm-gateway` (empty lib + gear.gdl + docs) if the catalogue is to list it |
| `model-registry` | `gears/model-registry` | — (design) | — | — | — | n/a | — | n/a | later | design-only passport: no crate; a passport-only package `cf-gears-model-registry` (empty lib + gear.gdl + docs) if the catalogue is to list it |
| `serverless-runtime` | `gears/serverless-runtime` | — (design) | — | — | — | n/a | — | n/a | later | design-only passport: no crate; a passport-only package `cf-gears-serverless-runtime` (empty lib + gear.gdl + docs) if the catalogue is to list it |
| `settings-service` | `gears/settings-service/settings-service` | `cf-gears-settings-service` 0.1.10 | — | 12 (0.1.0..0.4.5) | — | gear.gdl | 0.1.7 (2026-10-28) | yes | no | — |
| `simple-resource-registry` | `gears/simple-resource-registry` | — (design) | — | — | — | n/a | — | n/a | later | design-only passport: no crate; a passport-only package `cf-gears-simple-resource-registry` (empty lib + gear.gdl + docs) if the catalogue is to list it |
| `admission-control` | `gears/system/admission-control/admission-control` | `cf-gears-admission-control` 0.1.0, publish=false | — | — | — | - | — | no: cf-gears-admission-control-sdk | yes | drop `publish = false` (set `publish = ["gears"]`); publish its unpublished deps first: cf-gears-admission-control-sdk; `include` gear.gdl and docs/ |
| `firebase-authn-plugin` | `gears/system/authn-resolver/plugins/firebase-authn-plugin` | `cf-gears-firebase-authn-plugin` 0.1.2 | — | 8 (0.1.0..0.2.4) | — | gear.gdl | 0.1.0 (2026-10-28) | yes | no | — |
| `tr-authz-plugin` | `gears/system/authz-resolver/plugins/tr-authz-plugin` | `cf-gears-tr-authz-plugin` 0.1.24 | — | 27 (0.1.3..0.1.29) | — | gear.gdl | 0.1.22 (2026-10-28) | yes | no | — |
| `cluster` | `gears/system/cluster/cluster` | `cf-gears-cluster` 0.3.2 | — | 26 (0.1.0..0.4.6) | — | gear.gdl | 0.3.0 (2026-10-28) | yes | no | its helm_chart (deploy/helm/cluster) is in neither the corpus directory nor the package |
| `event-broker` | `gears/system/event-broker` | `cf-gears-event-broker` 0.4.0 | — | 21 (0.1.0..0.7.1) | — | none | never | yes | passport | gear.gdl sits above the crate (package.path = "./event-broker"), so the package cannot carry it: move it into the crate (ask upstream); meanwhile a passport overlay, never a republish of the name |
| `license-resolver` | `gears/system/license-resolver/license-resolver` | `cf-gears-license-resolver` 0.1.8 | — | 14 (0.1.0..0.3.0) | — | gear.gdl | 0.1.6 (2026-10-28) | yes | no | — |
| `static-license-plugin` | `gears/system/license-resolver/plugins/static-license-plugin` | `cf-gears-static-license-plugin` 0.1.8 | — | 14 (0.1.0..0.2.0) | — | gear.gdl | 0.1.6 (2026-10-28) | yes | no | — |
| `policy-engine` | `gears/system/policy-engine/policy-engine` | `cf-gears-policy-engine` 0.1.0, publish=false | — | — | — | - | — | no: cf-gears-policy-engine-sdk cf-gears-admission-control-sdk cf-gears-toolkit-policy-evaluation | yes | drop `publish = false` (set `publish = ["gears"]`); publish its unpublished deps first: cf-gears-policy-engine-sdk cf-gears-admission-control-sdk cf-gears-toolkit-policy-evaluation; `include` gear.gdl and docs/ |
| `quota-enforcement-storage-plugin` | `gears/system/quota-enforcement/plugins/quota-enforcement-storage-plugin` | `cf-gears-quota-enforcement-storage-plugin` 0.3.0 | — | 8 (0.1.0..0.4.4) | — | gear.gdl | 0.1.0 (2026-10-28) | yes | no | — |
| `quota-enforcement` | `gears/system/quota-enforcement/quota-enforcement` | `cf-gears-quota-enforcement` 0.3.0 | — | 8 (0.1.0..0.6.1) | — | gear.gdl | 0.1.0 (2026-10-28) | yes | no | — |
| `service-discovery` | `gears/system/service-discovery` | `cf-gears-service-discovery` 0.3.2 | — | 9 (0.2.3..0.4.4) | 0.4.2 | gear.gdl | 0.3.0 (2026-10-28) | yes | no | — |
| `single-tenant-tr-plugin` | `gears/system/tenant-resolver/plugins/single-tenant-tr-plugin` | `cf-gears-single-tenant-tr-plugin` 0.1.43 | — | 27 (0.1.22..0.1.48) | — | gear.gdl | 0.1.41 (2026-10-28) | yes | no | — |
| `static-tr-plugin` | `gears/system/tenant-resolver/plugins/static-tr-plugin` | `cf-gears-static-tr-plugin` 0.1.42 | — | 27 (0.1.21..0.2.3) | — | gear.gdl | 0.1.40 (2026-10-28) | yes | no | — |
| `clickhouse-usage-collector-plugin` | `gears/system/usage-collector/plugins/clickhouse-usage-collector-plugin` | `cf-gears-clickhouse-usage-collector-plugin` 0.1.3 | — | 9 (0.1.0..0.2.1) | — | gear.gdl | 0.1.1 (2026-10-28) | yes | no | — |
| `noop-usage-collector-plugin` | `gears/system/usage-collector/plugins/noop-usage-collector-plugin` | `cf-gears-noop-usage-collector-plugin` 0.2.2 | — | 24 (0.1.0..0.2.7) | — | gear.gdl | 0.2.0 (2026-10-28) | yes | no | — |
| `timescaledb-usage-collector-plugin` | `gears/system/usage-collector/plugins/timescaledb-usage-collector-plugin` | `cf-gears-timescaledb-usage-collector-plugin` 0.3.3 | — | 23 (0.1.0..0.4.1) | — | gear.gdl | 0.3.1 (2026-10-28) | yes | no | — |

**`graph-storage` under its other name.** `weftgraph` on crates.io (7 (0.1.0..0.4.0-rc.3); published from `vasylcf/gears-rust`), lib `graph_storage`. Studio links `0.4.0-rc.3` (passport: 0.4.0-rc.3:gdl); the latest stable `0.1.1` has no passport; the first with one is 0.3.0-rc.1 (2026-10-30).

**Studio's own gears (48).** 47 gears are modules of the one crate `cf-studio-backend`, and `postgres-usage-collector-plugin` is its path crate `plugins/postgres-usage-collector-plugin`. None is on any registry and none needs to be: they are the product's own code. `postgres-usage-collector-plugin`, `studio-artifact-ingest`, `studio-assembly`, `studio-components-catalog`, `studio-connector`, `anthropic-connector-plugin`, `assembly-service-connector-plugin`, `bitbucket-connector-plugin`, `discord-connector-plugin`, `discord-webhook-connector-plugin`, `gear-repository-connector-plugin`, `github-connector-plugin`, `gitlab-connector-plugin`, `kubernetes-connector-plugin`, `openai-connector-plugin`, `registry-connector-plugin`, `research-connector-plugin`, `slack-connector-plugin`, `slack-webhook-connector-plugin`, `zulip-connector-plugin`, `zulip-webhook-connector-plugin`, `studio-credstore-pg`, `studio-documents`, `studio-domain-model`, `studio-environments`, `studio-git`, `studio-identity-directory`, `studio-insight`, `studio-kits`, `studio-llm-proxy`, `studio-mcp`, `studio-notify`, `studio-organizations`, `studio-presence`, `studio-product`, `studio-reports`, `studio-scheduler`, `studio-secrets-bootstrap`, `studio-spec-graph`, `studio-spec-mapping`, `studio-spec-quality`, `studio-authz-plugin`, `studio-events`, `studio-session`, `studio-theia`, `studio-tasks`, `studio-usage`, `studio-user`.

## Refreshing it

The scripts that produced it are not part of the repository: a scan of a
gears-rust checkout (passports, crates, path dependencies), a serial walk of
the crates.io sparse index and versions API, and a download and listing of one
`.crate` per gear crate. Phase 1 of the design turns them into
`scripts/gears-inventory.mjs`, run against the BOM instead of a corpus commit.
