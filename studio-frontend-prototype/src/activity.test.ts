import { describe, expect, it } from "vitest";

import { activityFeed, matchesQuery, type FeedNode } from "./activity";

const finding = (over: Record<string, unknown>, id = "f1"): FeedNode => ({
  instance_id: id,
  value: { detector: "leak", subject: "doc-1", path: "docs/adr/0001-identity.md", ...over },
});

const comment = (over: Record<string, unknown>, id = "c1"): FeedNode => ({
  instance_id: id,
  value: { author: "alice", target_number: 42, created_at: "2026-09-16T09:00:00Z", ...over },
});

const names: Record<string, string> = { "doc-1": "Architecture decision" };
const nameOf = (id: string) => names[id];

describe("activityFeed", () => {
  it("reads a finding as a check, naming the detector that made it", () => {
    const [row] = activityFeed([finding({ recorded_at: "2026-09-17T12:00:00Z" })], [], nameOf);
    expect(row).toMatchObject({
      kind: "check",
      event: "Document checked",
      subject: "Architecture decision",
      by: "leak",
      recorded: "2026-09-17T12:00:00Z",
    });
  });

  it("falls back to the file name, then to the id, rather than dropping a row", () => {
    // A check that really happened must appear even when nothing can name its
    // subject: an opaque id is still something a reader can chase.
    const [byPath] = activityFeed([finding({ subject: "unknown-doc" })], [], nameOf);
    expect(byPath.subject).toBe("0001-identity.md");

    const [byId] = activityFeed([finding({ subject: "unknown-doc", path: null })], [], nameOf);
    expect(byId.subject).toBe("unknown-doc");
  });

  it("reads a comment as what it is on, not as its own text", () => {
    const [row] = activityFeed([], [comment({})], nameOf);
    expect(row).toMatchObject({ kind: "comment", event: "Comment", subject: "#42", by: "alice" });
  });

  it("orders newest first", () => {
    const feed = activityFeed(
      [
        finding({ recorded_at: "2026-09-10T12:00:00Z" }, "old"),
        finding({ recorded_at: "2026-09-17T12:00:00Z" }, "new"),
      ],
      [comment({ created_at: "2026-09-16T09:00:00Z" })],
      nameOf,
    );
    expect(feed.map((e) => e.id)).toEqual(["new", "c1", "old"]);
  });

  it("puts an undated row last, not first", () => {
    // Findings written before `recorded_at` existed are exactly this case, and
    // sorting them to the top would fill the newest rows with the least
    // informative ones.
    const feed = activityFeed(
      [finding({ recorded_at: undefined }, "undated"), finding({ recorded_at: "2026-09-01T00:00:00Z" }, "dated")],
      [],
      nameOf,
    );
    expect(feed.map((e) => e.id)).toEqual(["dated", "undated"]);
  });

  it("keeps the detector's severity for the row to colour", () => {
    const [row] = activityFeed([finding({ severity: "high" })], [], nameOf);
    expect(row.severity).toBe("high");
  });
});

describe("matchesQuery", () => {
  const [row] = activityFeed([finding({ recorded_at: "2026-09-17T12:00:00Z", severity: "high" })], [], nameOf);

  it("searches every column, not the one the reader guessed", () => {
    expect(matchesQuery(row, "leak")).toBe(true);
    expect(matchesQuery(row, "Architecture")).toBe(true);
    expect(matchesQuery(row, "checked")).toBe(true);
    expect(matchesQuery(row, "high")).toBe(true);
  });

  it("ignores case and surrounding space, and an empty query matches all", () => {
    expect(matchesQuery(row, "  LEAK ")).toBe(true);
    expect(matchesQuery(row, "")).toBe(true);
    expect(matchesQuery(row, "   ")).toBe(true);
    expect(matchesQuery(row, "purpose")).toBe(false);
  });
});
