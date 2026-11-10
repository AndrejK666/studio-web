# studio-documents

Document management: the types a document can be, the templates and checklists
that shape it, and the documents themselves.

The design — why the gear exists, how workspaces own documents and projects
inherit them, how the catalogue overlays organization on workspace, how a
repository file is classified and analysed, the REST surface and the tables —
is [`docs/design/studio-documents.md`](../../../docs/design/studio-documents.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-documents`, capabilities `[db, rest]`, deps `account_management`,
  `types_registry`.
- Config section `gears.studio-documents`; no `database:` block means the gear
  stands down (no routes, no ports). Document types are also registered in the
  platform types-registry, so a profile that gives this gear no database also
  has no `doc.*` types — the `gts-audit` command names them rather than leaving
  you to notice an empty screen.
- `config.analyze_on_sync` (default `true`) has a source sync queue Spec
  Quality over the documents it found new or changed;
  `config.analyze_on_sync_max_documents` (default `50`) caps one sync. Neither
  does anything while [`../spec_quality`](../spec_quality) has no key.
- Storage has the same shape as [`../credstore_pg`](../credstore_pg); tenant
  access is authorized through account-management, as
  [`../kit_registry`](../kit_registry) does for its project routes.
- The built-in templates are in [`templates/`](templates/) and the vendored
  review criteria in [`review/`](review/README.md) — refresh those from their
  source, do not edit them here.
- The domain model's Issues queue and readiness
  (`GET /spec-model/issues`, `GET /spec-model/readiness`) are computed in
  [`spec_model/resolve.rs`](spec_model/resolve.rs), and every fact the model
  returns carries its review key from
  [`spec_model/fact_key.rs`](spec_model/fact_key.rs). Both moved from the
  portal; the fact key must stay bit-for-bit the browser's, because stored
  reviews carry it — its tests pin keys the old browser code computed.
- The MCP tools over those routes are in [`mcp.rs`](mcp.rs)
  (`spec_model_issues`, `spec_model_readiness`, `spec_model_facts`,
  `spec_model_fact_review`, `spec_model_finding_decide`; `docs/mcp.md`).
- `repo_tests.rs` runs against the shared test PostgreSQL (`test_pg.rs`);
  `sync_analysis_tests.rs` covers what a sync queues.
