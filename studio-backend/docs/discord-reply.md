# Discord reply draft (to Diffora's answer)

Thanks, that's exactly what we needed! 🙏

- **api.json**: got it — verified locally, 79 paths and the AM routes match the live
  server exactly. We'll switch our TS client generation to `docs/api/api.json`. Small
  suggestion: the stale per-gear `docs/account-management-v1.yaml` (with the `/api/...`
  prefix) is a trap for newcomers — maybe delete it or replace with a pointer to
  api.json? Happy to send that PR.
- **member-handle / rg prefix**: understood, we're already on the rg-prefixed type.
  We'll file a small docs issue for PRD §5.6 so the next adopter doesn't hit the 400.
- **typed tenant-metadata**: filing it as a bug then, with both repro paths (draft-07
  → OP#12 narrowing rejection; `gts://` chain `$schema` → "Unknown meta-schema" in
  trait validation) and a one-line config repro. Ping us if you want a failing test —
  we can contribute one against `types-registry.config.entities`.
- One item from the original list still open: the static-entity registration loop
  logging only "Request validation failed" while the real cause sits in
  FieldViolations — is there a log level/flag we missed, or should we file that too?

Context if useful: the assembly is now 20 gears (added mini-chat + oagw + credstore +
model-policy, simple-user-settings, file-storage) — the whole tenancy + AI-chat stack
still with zero custom Rust. Happy to demo.
