# PR #2 — fix for the typed tenant-metadata bug (ready after local test run)

**Branch:** `fix/typed-tenant-metadata-envelope` (fork, commit `91ade214`, based on upstream main — independent of PR #1)
**Title:** `fix(account-management): open the tenant-metadata envelope payload so typed derived schemas can register`

## ⚠️ Перед открытием PR — прогнать тесты локально (WSL)

```bash
cd /mnt/c/Repos/CFS/gears-rust\(forked\)
git checkout fix/typed-tenant-metadata-envelope
git restore gears/system/account-management/docs/account-management-v1.yaml \
            gears/system/resource-group/docs/openapi.yaml   # снять worktree-шум от PR#1

# 1. Новый integration-тест (ключевая проверка гипотезы фикса):
cargo test -p cf-gears-types-registry --test abstract_envelope_tests

# 2. Sync-тесты AM SDK (schema generated == docs artifact, payload open):
cargo test -p cf-gears-account-management-sdk

# 3. Остальные тесты затронутых крейтов:
cargo test -p cf-gears-account-management
```

**Возможный исход и его значение:**
- Всё зелёное → фикс верный, открываем PR (тело ниже).
- Тест №1 падает с тем же "adds new property but base has additionalProperties:
  false" → OP#12 игнорирует явный `additionalProperties: true`; значит, баг в
  крейте `gts` (GlobalTypeSystem/gts-rust), а не в gears — тогда PR не открываем,
  а этот результат дословно дописываем в issue (тест уже готов как репро).

## Body (их шаблон)

### Description

The `gts.cf.core.am.tenant_metadata.v1~` envelope declared no payload properties and
no `additionalProperties`; the OP#12 chain-narrowing check treats such a base as a
**closed empty object**, so any derived metadata schema declaring a typed payload
property was rejected at registration (`switch_to_ready` fails, gear init aborts).
That made the PRD §5.7 promise — "extensible tenant metadata with GTS-validated
payloads (branding, contacts)" — unrealisable: only free-form `type: object` derived
schemas could register. Found while building the Constructor Studio backend;
confirmed as a bug on Discord (2026-07-29). Fixes #<issue>.

The fix opens the envelope payload explicitly:

- `#[schemars(extend("additionalProperties" = true))]` on `TenantMetadataEnvelopeV1`
  (the documented schemars-extend mechanism already used elsewhere in the repo);
- `docs/schemas/tenant_metadata.v1.schema.json` synced accordingly.

Semantically the envelope payload was always meant to be open: derived schemas own
the payload shape, and `MetadataService` validates entries against the **derived**
schema at PUT time (`metadata_schema_registry`) — the base is an envelope, not a
payload contract. Traits stay strict (`x-gts-traits-schema` unchanged,
`additionalProperties: false` inside it).

### Type of Change

- [x] Bug fix (non-breaking change which fixes an issue)

### Testing

- [x] New tests added:
  - `types-registry/tests/abstract_envelope_tests.rs` — a typed derived schema under
    an open abstract envelope registers and survives `switch_to_ready` (fails
    without the envelope change);
  - `account-management-sdk` sync test `tenant_metadata_envelope_payload_is_open` —
    guards `additionalProperties: true` in both the generated schema and the docs
    artifact.
- [x] Unit tests pass (`cargo test -p cf-gears-types-registry -p cf-gears-account-management-sdk -p cf-gears-account-management`)
- [x] Manual testing completed — original repro (one typed entry in
  `types-registry.config.entities`) now boots a 20-gear assembly instead of failing
  post-init.

### Documentation

- [x] API documentation updated (`docs/schemas/tenant_metadata.v1.schema.json`)

### Checklist

- [x] Code follows project style guidelines (conventional commit, DCO signed)
- [x] Self-review completed
- [x] No linting errors (`cargo clippy`)
- [x] Code is properly formatted (`cargo fmt`)
- [x] Tests pass (`cargo test`)

### Related Issues

Fixes #<номер issue про typed tenant-metadata>

## Version bump note (their CONTRIBUTING requires justification)

`cf-gears-account-management-sdk` — PATCH (pre-1.0: 0.x.y+1): the generated schema
gains `additionalProperties: true`, which only *widens* what derived schemas may
declare; no Rust API change. If maintainers consider schema output a public contract
change, MINOR is the conservative pick — happy to адjust.

## После открытия

1. В issue дописать "Fix proposed in #<PR>"; в PR — номер issue.
2. Обновить Discord-тред ссылкой.
3. После мержа: вернуть typed-схему в наш studio-backend
   (`config/*.yaml` — properties обратно) и убрать client-side-валидацию
   workaround (пометки "until gears issue #4" в конфиге и ADR-0002).
