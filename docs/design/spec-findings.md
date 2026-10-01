# Spec findings

What Studio reports about a specification document, where in the text it is,
and what a person can do with it.

Status: proposal, 2026-10-01. This iteration covers only what the Spec Quality
service already answers. Everything else is under [Later](#later).

## Why this exists

The Spec Quality detectors answer with far more than Studio keeps. Their raw
results carry line ranges, the passage itself, a reason and the model's evidence
(`gate.violations[]`, `sections[]`, `clusters[].occurrences[]`), and
`spec_quality/verdict.rs` throws all of that away, keeping one pass/fail and a
share. So the Specs list can say "2 findings", but nobody can see where they
are, a person cannot say "this is intended", and a re-run cannot tell a fixed
finding from a new one.

This iteration turns each detector answer into a list of **findings**, each one
placed in the text, and gives them a lifecycle.

## The catalogue

Every finding has a `rule`, which says what was caught and decides the default
severity.

| Rule | From | Catches | Severity | Anchor |
|---|---|---|---|---|
| `purpose.foreign_section` | `purpose` `gate.violations[]` | A section that reads as another document kind ("PRD section reads as DECISION") | high if `confidence` ≥ 0.9, otherwise medium | `line_start`–`line_end`, section |
| `purpose.not_a_spec` | `purpose` `mixture.other` | The document is mostly not specification content (spec share < 0.5, the prototype's `MIN_SPEC_SHARE`) | medium | the document |
| `leak.foreign_content` | `leak` `leaks[]` | A passage that reads as another kind (`reads_as`) than the declared type | high if `confidence` ≥ 0.9, otherwise medium | `line_start`–`line_end`, section |
| `bloat.cross_document` | `bloat` `clusters[]` | The same passage in two or more documents | medium | `line_start`–`line_end` and the passage per occurrence; the other occurrences as `related` |
| `bloat.self_repeat` | `bloat` `clusters[]` | A passage repeated inside one document | low | as above |

`message` is the detector's own `reason` where it gives one, and `evidence[]`
is its `evidence`. `leak` is always sent with `verify: false`
(`studio-backend/docs/spec-quality-issues.md` §1).

`traceability` produces no findings. In `extract` mode it finds zero pairs in
every set tried (`spec-quality-issues.md` §2), so there is nothing to place.

What the shapes are based on: the service's OpenAPI types `result` as a bare
`object`. The fields above come from real answers: the 24 stored
`spec_quality.analyze` runs on dev (23 `purpose`, 1 `bloat`), and live calls of
all three detectors through a local backend on 2026-10-01.

Checked against the files that run analysed:

- **Line numbers are right**, every time. For a `purpose` or `leak` section,
  `line_start` is the first line of its body, two lines below the heading.
- **`bloat`'s character offsets are not.** One occurrence in six matched its
  own passage, and one was two characters long for a 569-character passage. They
  are not read. A finding is placed by its lines, and `bloat`'s quote is found
  inside them with whitespace collapsed, because the service quotes a passage
  reflowed onto one line.
- **`bloat` reports a paragraph and a sentence inside it as duplicates of each
  other.** Occurrences in one file whose lines overlap are read as one passage.
- **The detectors are not deterministic.** The same PRD gave 16, 14 and 17
  findings in three runs. That matters for the lifecycle below.

That run on this repository's own documents, as a sample of what comes back:

| Case | Findings |
|---|---|
| `purpose`, `docs/prd/constructor-studio.md` as `prd` | 14–17 sections that read as design (the count differs run to run), each with lines, a reason and evidence |
| `purpose`, ADR-0019 as `adr` | 1: "8. The config read gets a cache" reads as design |
| `leak`, ADR-0019 declared as `prd` | 11–12 sections, confidence 0.98–0.99 |
| `bloat`, ADR-0016, 0018, 0019 | 2 passages shared by 0018 and 0019, 2 repeats inside 0018 |

## The finding

```jsonc
{
  "id": "3c9e…",               // the fingerprint, stable across re-runs
  "rule": "purpose.foreign_section",
  "detector": "purpose",
  "severity": "high",           // high | medium | low
  "message": "PRD section reads as DECISION (belongs in a decision doc, not a prd)",
  "anchor": {
    "section": "Requested change",
    "line_start": 59, "line_end": 69,
    "quote": null                // bloat gives the passage
  },
  "related": [ { "path": "docs/PRD.md", "anchor": { … } } ],
  "evidence": ["llm: Requests options and trade-offs for enabling/disabling TOC validation."],
  "confidence": 0.96
}
```

**The fingerprint** is a hash of the rule, the document path, the section and
the quote. Line numbers are deliberately left out: lines shift whenever someone
edits above the passage, and a dismissal must survive that.

## Lifecycle, storage, API

This is the second half of the iteration, after the verdict carries findings.

- **States.** A finding is `open`, `dismissed` ("As intended", with an optional
  reason) or `resolved`. A dismissal is kept for as long as the fingerprint
  keeps appearing.
- **Resolved needs the text to have changed.** The detectors are not
  deterministic, so a finding missing from one run of an unchanged document has
  not been fixed, it was just not reported that time. A finding is `resolved`
  only when a run on a different `content_sha` does not report it; a run on the
  same text only adds.
- **Staleness.** A finding remembers the `content_sha` of the text it was
  computed on. When the document has changed since, the client looks for the
  passage in the current text and shows the finding as stale if it cannot find
  it.
- **Storage.** One table in `studio-documents`, `studio_document_findings`,
  keyed by subject (binding or Studio document, exactly one, as in
  `studio_document_analyses`) and fingerprint. The graph's `spec_finding` nodes
  stay as the per-detector summary the activity feed and rollups read.
- **API**, in `studio-documents`:
  - `GET …/document-bindings/{id}/findings?state=` returns `{ items, total }`
    and defaults to `open`. The same route exists for `…/documents/{id}`.
  - `PATCH …/findings/{finding_id}` with `{ state: "dismissed" | "open", reason? }`.
  - `…/document-bindings?expand=findings` adds `findings_open` and
    `findings_high` per row, for the Specs list.
- **On source sync.** A sync already reads every file and records each
  binding's `content_sha`. It ends by enqueueing `purpose` and `leak` for the
  bindings whose text changed since their last analysis, and `bloat` over the
  set if any changed. The number of documents per sync is capped. Nothing is
  enqueued when the gear has no key, and the whole step can be switched off per
  deployment (`analyze_on_sync`). A re-sync of an unchanged repository costs
  nothing.

## Order of work

1. **The verdict carries findings.** `verdict.rs` reads them out of the raw
   result, and `GET /studio-spec-quality/v1/verdicts` returns them in
   `findings[]`. Both portals and Theia read verdicts there today, so they get
   positions without a new call.
2. **Lifecycle.** The findings table, the routes, As intended.
3. **On sync.** Enqueue analysis for changed documents.
4. **Portal and Theia.** The findings panel, Show in text, the underline.

## Later

To discuss after this iteration:

- **Structure findings from our own template check.** Today `validate.rs`
  answers with strings and no positions: placeholders, missing, empty or short
  sections, front-matter, the title.
- **IDs and references across a project.** Duplicate IDs, dangling references,
  broken links. This is what `traceability` should have given.
- **A review against the kit's checklists.** The criteria in
  `documents/review/*/checklist.md` (#394), with proposed changes.
- **Asks of the Spec Quality service:**
  - result schemas in its OpenAPI;
  - character offsets that match the text, for `purpose` and `bloat`;
  - an overlapping passage not reported as its own duplicate;
  - the two defects in `spec-quality-issues.md`.
