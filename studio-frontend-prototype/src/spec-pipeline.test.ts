import { describe, expect, it } from "vitest";

import type { DocBinding } from "./api";
import { coverage, pipelineRows } from "./spec-pipeline";

const TYPES = [
  { key: "adr", name: "Architecture Decision Record" },
  { key: "prd", name: "Product Requirements", description: "What we are building and why." },
];

/** A binding with only the fields the fold reads; the rest of `DocBinding` is
 *  timestamps and provenance this has no opinion about. */
const binding = (over: Partial<DocBinding>): DocBinding =>
  ({
    id: "b",
    tenant_id: "t",
    inherited: false,
    node_id: "n",
    path: "docs/x.md",
    state: "confirmed",
    candidates: [],
    content_sha: "sha",
    created_at: "",
    updated_at: "",
    ...over,
  }) as DocBinding;

describe("pipelineRows", () => {
  it("counts a repository file bound to a type as a document of that type", () => {
    // The bug this exists to prevent: fourteen bound ADRs in the Specs table
    // while the pipeline reported the type as not started.
    const rows = pipelineRows(
      TYPES,
      [],
      [binding({ type_key: "adr", state: "confirmed", path: "docs/adr/0001-identity.md" })],
    );
    const adr = rows.find((r) => r.type.key === "adr")!;

    expect(adr.untouched).toBe(false);
    expect(adr.bound).toHaveLength(1);
    expect(adr.authored).toEqual([]);
  });

  it("keeps a scanner's guess out of the bound set", () => {
    const rows = pipelineRows(TYPES, [], [binding({ type_key: "adr", state: "detected" })]);
    const adr = rows.find((r) => r.type.key === "adr")!;

    // Visible, so somebody can go and confirm it — but not counted, because
    // the project has not agreed the file is an ADR.
    expect(adr.proposed).toHaveLength(1);
    expect(adr.bound).toEqual([]);
    expect(adr.untouched).toBe(false);
  });

  it("ignores a file somebody decided is not a document", () => {
    const rows = pipelineRows(
      TYPES,
      [],
      [
        binding({ type_key: "adr", state: "not_a_document" }),
        binding({ type_key: "adr", state: "unknown" }),
        binding({ type_key: null, state: "confirmed" }),
      ],
    );
    expect(rows.every((r) => r.untouched)).toBe(true);
  });

  it("returns one row per declared type, in the order they were declared", () => {
    const rows = pipelineRows(TYPES, [], []);
    expect(rows.map((r) => r.type.key)).toEqual(["adr", "prd"]);
  });

  it("drops a binding naming a type the workspace no longer declares", () => {
    // The type list is the authority on what types exist; a stale binding must
    // not conjure a row for a type nobody can open.
    const rows = pipelineRows(TYPES, [], [binding({ type_key: "gone", state: "confirmed" })]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.untouched)).toBe(true);
  });

  it("hands authored documents back whole, not narrowed", () => {
    const docs = [{ type_key: "prd", title: "Studio PRD", status: "draft" as const }];
    const rows = pipelineRows(TYPES, docs, []);
    const prd = rows.find((r) => r.type.key === "prd")!;
    // The status survives the fold — the view needs it for the badges.
    expect(prd.authored[0].status).toBe("draft");
    expect(prd.authored[0].title).toBe("Studio PRD");
  });
});

describe("coverage", () => {
  const conforms = (d: { type_key: string; conforms?: boolean }) => d.conforms;

  it("counts authored and bound documents in the same total", () => {
    const rows = pipelineRows(
      TYPES,
      [{ type_key: "adr", conforms: true }],
      [
        binding({ type_key: "adr", state: "confirmed", conforms: true }),
        binding({ type_key: "adr", state: "manual", conforms: false }),
      ],
    );
    expect(coverage(rows[0], conforms)).toEqual({ valid: 2, total: 3 });
  });

  it("leaves an unconfirmed guess out of the total", () => {
    const rows = pipelineRows(
      TYPES,
      [],
      [
        binding({ type_key: "adr", state: "confirmed", conforms: true }),
        binding({ type_key: "adr", state: "detected", conforms: true }),
      ],
    );
    // 1 of 1, not 2 of 2: the detected file is not part of the coverage the
    // project has agreed to, however valid it looks.
    expect(coverage(rows[0], conforms)).toEqual({ valid: 1, total: 1 });
  });

  it("treats an unchecked document as not valid, not as valid", () => {
    const rows = pipelineRows(
      TYPES,
      [{ type_key: "adr" }],
      [binding({ type_key: "adr", state: "confirmed", conforms: null })],
    );
    expect(coverage(rows[0], conforms)).toEqual({ valid: 0, total: 2 });
  });

  it("prefers a fresher verdict from the screen over the one on the record", () => {
    const docs = [{ type_key: "adr", id: "d1", conforms: false }];
    const rows = pipelineRows(TYPES, docs, []);
    // "Validate all" just re-checked d1 and it passed.
    const fresh = (d: { id: string }) => (d.id === "d1" ? true : undefined);
    expect(coverage(rows[0], fresh)).toEqual({ valid: 1, total: 1 });
  });
});
