# PR description — ready to paste into GitHub

**Title:** `docs: fix path drift in per-gear OpenAPI artifacts (account-management, resource-group)`

**Body:**

## What

The committed per-gear OpenAPI artifacts declared paths with an `/api/...` prefix that
the code never registers — `OperationBuilder` registers gear-relative paths, and the
api-gateway prepends its configured `prefix_path` (e.g. `/cf`). A client generated
from these artifacts 404s on every call. We hit this in a real integration
(Constructor Studio backend, a 20-gear assembly), and Diffora confirmed on Discord
that `docs/api/api.json` is the CI-verified source of truth.

## Changes

Verified against `docs/api/api.json` and against live routes on a running assembly:

- **`gears/system/account-management/docs/account-management-v1.yaml`** — stripped the
  `/api` prefix from all 16 paths; every declared path now exists in
  `docs/api/api.json`.
- **`gears/system/resource-group/docs/openapi.yaml`** — stripped `/api` from the
  `resource-group` and `types-registry` paths; renamed `{schema_id}` → `{code}` to
  match the registered route `/types-registry/v1/types/{code}`.
- Both files: header note pointing to `docs/api/api.json` as the aggregated source of
  truth and explaining gateway prefixing, so the next adopter doesn't fall into the
  same trap.

DESIGN.md references to these artifacts are untouched — the files stay in place and
stay valid OpenAPI, so Cypilot artifact validation should be unaffected.

## Known residual (intentionally not fixed here)

`resource-group/docs/openapi.yaml` still declares
`/resource-group/v1/groups/{group_id}/hierarchy`, which has no matching route — the
implementation exposes `/ancestors` and `/descendants` instead. Mapping one documented
endpoint onto two real ones is a content decision for the gear owner, not a mechanical
fix; happy to follow up once you decide the intended shape.

## Not touched (out of scope)

`credstore/docs/api/openapi.yaml`, `event-broker/docs/openapi.yaml`,
`usage-collector-v1.yaml` — no `/api` prefix drift detected (event-broker and
usage-collector appear spec-stage / not in api.json, left as-is).

## Suggestion

A CI check diffing per-gear artifacts against `docs/api/api.json` (the
`api_contracts` workflow looks like a natural home) would prevent this class of drift
permanently.

---

**Как запушить и открыть PR (из WSL или PowerShell с git):**

```bash
cd "C:\Repos\CFS\gears-rust(forked)"      # в WSL: /mnt/c/Repos/CFS/gears-rust\(forked\)
git log --oneline -1                       # убедиться, что коммит fix/... создан
git push -u origin fix/per-gear-openapi-path-drift
# затем на GitHub: AndrejK666/gears-rust -> Compare & pull request -> base: constructorfabric/gears-rust main
# или через gh cli:
gh pr create --repo constructorfabric/gears-rust \
  --head AndrejK666:fix/per-gear-openapi-path-drift \
  --title "docs: fix path drift in per-gear OpenAPI artifacts (account-management, resource-group)" \
  --body-file <этот файл, секция Body>
```
