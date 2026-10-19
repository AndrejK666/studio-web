# studio-usage

What Studio's model calls and IDE sessions use, and what that costs an
organization (constructorfabric/studio-web#781).

The design — quantities not money, how a report reads the collector, what is
not here yet — is [`docs/design/studio-usage.md`](../../../docs/design/studio-usage.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-usage`, capabilities `[rest]`, deps `account_management`. No
  database and no config section.
- Records go to the platform's `usage-collector` gear, stored by
  [`plugins/postgres-usage-collector-plugin`](../../plugins/postgres-usage-collector-plugin)
  (config sections `usage-collector` and `postgres-usage-collector-plugin`).
- Recorders hold a `sdk::Usage`: studio-llm-proxy per model call, studio-session
  per reaper pass. They record as the caller acting in the record's tenant —
  the Studio PDP admits a record only in the tenant it is asked in.
- The price list is account-management metadata on the organization,
  `cf.studio.usage.prices.v1~`, declared in every `config/*.yaml` and held by
  this gear (`studio_authz_plugin::GEAR_HELD_METADATA`). So are the budgets,
  `cf.studio.usage.budgets.v1~`.
- Privileges `cost.view` (the report, the budgets) and `cost.manage` (the
  price list, the budgets), in `access_config::PRIVILEGES`.

## Where things are

- `port.rs` — a use, in Studio's words.
- `types.rs` — the seven usage types and how a use becomes collector records.
- `sdk.rs` — the recording handle; catalogues the types on first use.
- `prices.rs` — the price list and what a quantity costs under it. No I/O.
- `costs.rs` — facts priced and grouped into a report. No I/O.
- `budgets.rs` — the budgets, the month, and a budget's standing. No I/O.
- `service.rs` — who may; the price list and budgets rows; the per-tenant
  collector sums; this month's standing.
- `rest.rs` — `/studio-usage/v1/{prices,costs,budgets,budget-status}`.
