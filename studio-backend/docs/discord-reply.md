# Discord follow-up (after Diffora's answer) — ready to paste

Thanks Diffora, super helpful! Two follow-ups:

1. **Stale per-gear OpenAPI files.** Since `docs/api/api.json` is the CI-verified
source of truth, the per-gear artifacts like
`gears/system/account-management/docs/account-management-v1.yaml` (with the `/api/...`
prefix that doesn't match the real routes) are a trap for adopters — that's exactly
how we generated a 404-ing client. Proposal: delete them, or replace each with a
one-line pointer to `docs/api/api.json`. We're happy to send that PR — any preference
between "delete" vs "pointer"?

2. **The typed tenant-metadata bug.** Should we file a proper bug report, and if so —
where? GitHub issues on `constructorfabric/gears-rust`, or do you track bugs
elsewhere? We have it fully written up: both repro paths (draft-07 → OP#12 narrowing
rejects any added property against the closed base envelope;
`$schema: "gts://gts.cf.core.am.tenant_metadata.v1~"` → "Unknown meta-schema" in trait
validation), a one-line repro via `types-registry.config.entities`, and we can
contribute a failing test alongside it.

And one leftover from the original list: the static-entity registration loop logs only
"Request validation failed" while the actual cause sits in `FieldViolations` — is
there a log level/flag we missed, or file that one too?
