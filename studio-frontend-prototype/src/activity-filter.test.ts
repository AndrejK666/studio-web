import { describe, expect, it } from "vitest";

import { matchesQuery } from "./activity-filter";
import type { ActivityEvent } from "./api";

/* The fold that produces these rows moved to `artifact_ingest/activity.rs`.
 * This did not, and should not: it narrows what is already on screen as
 * somebody types, and a request per keystroke would be a worse answer to the
 * same question. */

const event = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: "e1",
  kind: "check",
  event: "Document checked",
  subject: "prd.md",
  by: "bloat",
  recorded: "2026-09-23T12:00:00Z",
  severity: "high",
  ...over,
});

describe("searching the feed", () => {
  it("searches every column, not the one the reader guessed", () => {
    // The box sits over the table; typing a detector name into it means
    // "find that", not "find that in the column I have not named".
    for (const q of ["checked", "prd", "bloat", "high", "2026-09"]) {
      expect(matchesQuery(event(), q), q).toBe(true);
    }
    expect(matchesQuery(event(), "telepathy")).toBe(false);
  });

  it("ignores case and surrounding space, and an empty query matches all", () => {
    expect(matchesQuery(event(), "  BLOAT ")).toBe(true);
    expect(matchesQuery(event(), "")).toBe(true);
    expect(matchesQuery(event(), "   ")).toBe(true);
  });

  it("does not trip over a row with no severity or no time", () => {
    const bare = event({ severity: null, recorded: null });
    expect(matchesQuery(bare, "prd")).toBe(true);
    expect(matchesQuery(bare, "high")).toBe(false);
  });
});
