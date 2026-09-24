# Review guides for the built-in document types

`<kind>/checklist.md` and `<kind>/rules.md` are the SDLC kit's semantic review
criteria for the five built-in types (`prd`, `adr`, `design`, `decomposition`,
`feature`), vendored **verbatim**. Do not edit them here: refresh them from the
source and let the tests in `review_guide.rs` tell you what moved.

## Source

- Repository: `constructorfabric/studio-kit-sdlc`, `artifacts/<KIND>/checklist.md`
  and `artifacts/<KIND>/rules.md`, at commit `9011530` ("update cfs version to
  v1.5.9"). Byte-identical to it apart from line endings.
- The same files were already vendored into this repository at
  `studio-frontend/.cf-studio/config/kits/sdlc/artifacts/<KIND>/` (commit
  `f58c670`); these copies were taken from there, unchanged.

The templates in `../templates/` come from gears-rust
`docs/spec-templates/gears-sdlc/<KIND>/template.md`, which carries only the
template — the checklist and rules exist only in the kit.

## How they are used

`review_guide::parse_checklist` turns a checklist into criteria: every heading
of the form `### <ID>: <title>` (an upper-case, dash-separated id such as
`BIZ-PRD-001` or `QUALITY-002`) is one criterion, with the enclosing `#`
heading as its group, the enclosing `##` heading as its section, a
`**Severity**:` line as its severity, and its `- [ ]` lines as its checks. The
parser knows markdown, not these files. `GET /studio-documents/v1/review-criteria`
serves the result; `rules.md` is served as-is.
