import { describe, expect, it } from "vitest";

import type { Doc, DocBinding } from "./api";
import { inFilter, specCounts, specRows, type SpecFilter } from "./spec-rows";

const binding = (over: Partial<DocBinding>): DocBinding =>
  ({
    id: "b1",
    tenant_id: "t",
    inherited: false,
    node_id: "n1",
    path: "docs/adr/0001-identity.md",
    state: "confirmed",
    candidates: [],
    content_sha: "sha",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-10T00:00:00Z",
    ...over,
  }) as DocBinding;

const doc = (over: Partial<Doc>): Doc =>
  ({
    id: "d1",
    type_key: "prd",
    title: "Studio PRD",
    content: "",
    status: "draft",
    conforms: false,
    inherited: false,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-12T00:00:00Z",
    ...over,
  }) as Doc;

describe("specRows", () => {
  it("puts both origins in one list, keeping which is which", () => {
    const rows = specRows([binding({})], [doc({})]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.origin)).toEqual(["authored", "repository"]);
  });

  it("names a repository row by its file and an authored one by its title", () => {
    const rows = specRows([binding({})], [doc({})]);
    expect(rows.find((r) => r.origin === "repository")!.name).toBe("0001-identity.md");
    expect(rows.find((r) => r.origin === "authored")!.name).toBe("Studio PRD");
  });

  it("leaves an authored row without a path", () => {
    // It has none until somebody commits it: until then the document exists in
    // Studio and nowhere else.
    const [authored] = specRows([], [doc({})]);
    expect(authored.path).toBe("");
    expect(authored.nodeId).toBeNull();
  });

  it("orders newest first", () => {
    const rows = specRows(
      [binding({ id: "old", updated_at: "2026-01-01T00:00:00Z" })],
      [doc({ id: "new", updated_at: "2026-09-17T00:00:00Z" })],
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("sorts an unreadable date last, not first", () => {
    const rows = specRows(
      [binding({ id: "undated", updated_at: "whenever" })],
      [doc({ id: "dated", updated_at: "2026-01-01T00:00:00Z" })],
    );
    expect(rows.map((r) => r.id)).toEqual(["dated", "undated"]);
  });

  it("keeps the record each row came from, for the actions that need it", () => {
    const rows = specRows([binding({})], [doc({})]);
    expect(rows.find((r) => r.origin === "repository")!.binding).not.toBeNull();
    expect(rows.find((r) => r.origin === "repository")!.doc).toBeNull();
    expect(rows.find((r) => r.origin === "authored")!.doc).not.toBeNull();
    expect(rows.find((r) => r.origin === "authored")!.binding).toBeNull();
  });
});

describe("inFilter", () => {
  const of = (rows: ReturnType<typeof specRows>, f: SpecFilter) => rows.filter((r) => inFilter(r, f));

  it("keeps an authored document out of the review queue", () => {
    // A queue that lists things nobody can act on stops being read. There is
    // nothing to review about an authored document's type: somebody chose it
    // before writing a word.
    const rows = specRows([], [doc({})]);
    expect(of(rows, "needs-review")).toHaveLength(0);
    expect(of(rows, "bound")).toHaveLength(1);
  });

  it("puts an undecided repository file in the review queue", () => {
    const rows = specRows(
      [binding({ id: "guess", state: "detected" }), binding({ id: "none", state: "unknown" })],
      [],
    );
    expect(of(rows, "needs-review")).toHaveLength(2);
    expect(of(rows, "bound")).toHaveLength(0);
  });

  it("counts a decided file as bound, whichever way it was decided", () => {
    const rows = specRows(
      [binding({ id: "c", state: "confirmed" }), binding({ id: "m", state: "manual" })],
      [],
    );
    expect(of(rows, "bound")).toHaveLength(2);
  });

  it("keeps a rejected file in its own queue and out of the others", () => {
    const rows = specRows([binding({ state: "not_a_document" })], []);
    expect(of(rows, "not-documents")).toHaveLength(1);
    expect(of(rows, "needs-review")).toHaveLength(0);
    expect(of(rows, "bound")).toHaveLength(0);
    expect(of(rows, "all")).toHaveLength(1);
  });
});

describe("specCounts", () => {
  it("agrees with the list it labels", () => {
    // The chips and the rows must not be able to disagree, so both go through
    // the same predicate.
    const rows = specRows(
      [
        binding({ id: "a", state: "detected" }),
        binding({ id: "b", state: "confirmed" }),
        binding({ id: "c", state: "not_a_document" }),
      ],
      [doc({})],
    );
    const counts = specCounts(rows);
    expect(counts).toEqual({
      "not-scanned": 0,
      "needs-review": 1,
      bound: 2,
      "not-documents": 1,
      all: 4,
    });
    for (const filter of ["not-scanned", "needs-review", "bound", "not-documents", "all"] as const) {
      expect(rows.filter((r) => inFilter(r, filter))).toHaveLength(counts[filter]);
    }
  });
});

describe("candidates", () => {
  it("lists an ingested text file nothing has classified yet", () => {
    const rows = specRows([], [], [{ nodeId: "n9", path: "docs/adr/0002-storage.md" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin: "repository",
      name: "0002-storage.md",
      path: "docs/adr/0002-storage.md",
      nodeId: "n9",
      state: null,
      binding: null,
    });
  });

  it("drops a candidate the moment its file has a binding", () => {
    // The binding IS that file, one step further along. Listing both would
    // count one file twice and make the chips disagree with the list.
    const rows = specRows(
      [binding({ node_id: "n1" })],
      [],
      [{ nodeId: "n1", path: "docs/adr/0001-identity.md" }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].binding).not.toBeNull();
  });

  it("belongs to `not scanned`, never to `needs review`", () => {
    // `needs-review` is a queue of decisions a detector proposed. A file
    // nothing has read yet has no decision to review, and putting it there
    // would bury the rows somebody can actually act on.
    const rows = specRows([], [], [{ nodeId: "n9", path: "README.md" }]);
    expect(inFilter(rows[0], "not-scanned")).toBe(true);
    expect(inFilter(rows[0], "needs-review")).toBe(false);
    expect(inFilter(rows[0], "bound")).toBe(false);
    expect(inFilter(rows[0], "all")).toBe(true);
  });

  it("counts candidates in their own chip and in All", () => {
    const rows = specRows(
      [binding({ id: "a", node_id: "n1", state: "confirmed" })],
      [],
      [
        { nodeId: "n2", path: "docs/one.md" },
        { nodeId: "n3", path: "docs/two.md" },
      ],
    );
    const counts = specCounts(rows);
    expect(counts["not-scanned"]).toBe(2);
    expect(counts.bound).toBe(1);
    expect(counts.all).toBe(3);
    for (const filter of ["not-scanned", "needs-review", "bound", "not-documents", "all"] as const) {
      expect(rows.filter((r) => inFilter(r, filter))).toHaveLength(counts[filter]);
    }
  });
});
