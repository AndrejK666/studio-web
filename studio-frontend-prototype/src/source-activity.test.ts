import { describe, expect, it } from "vitest";

import { olderThanWindow, repoActivity, type ActivityNode } from "./source-activity";

/** Noon, so nothing in these tests depends on which side of midnight it is. */
const NOW = Date.parse("2026-09-17T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
/** `days` ago, at noon — comfortably inside that day's bucket. */
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const pull = (over: Partial<ActivityNode["value"]>): ActivityNode => ({
  value: { repo: "r1", state: "open", ...over },
});
const commit = (created_at: string, repo = "r1"): ActivityNode => ({
  value: { repo, created_at },
});

describe("repoActivity", () => {
  it("counts an open pull request however old it is", () => {
    // The one most worth seeing is the one that has been open for three weeks.
    // Windowing "open" would hide exactly that.
    const got = repoActivity([pull({ state: "open", updated_at: ago(40) })], [], NOW);
    expect(got.r1.open).toBe(1);
    expect(got.r1.days.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("counts a merge only inside the window", () => {
    const got = repoActivity(
      [
        pull({ state: "merged", merged: true, updated_at: ago(2) }),
        pull({ state: "merged", merged: true, updated_at: ago(30) }),
      ],
      [],
      NOW,
    );
    expect(got.r1.merged).toBe(1);
    expect(got.r1.open).toBe(0);
  });

  it("does not count a closed-unmerged pull request as open", () => {
    const got = repoActivity([pull({ state: "closed", updated_at: ago(1) })], [], NOW);
    expect(got.r1.open).toBe(0);
    expect(got.r1.merged).toBe(0);
  });

  it("puts today in the last bucket, not a stub at the end", () => {
    const got = repoActivity([pull({ updated_at: ago(0) })], [], NOW);
    expect(got.r1.days).toHaveLength(7);
    expect(got.r1.days[6]).toBe(1);
  });

  it("buckets by day, oldest first", () => {
    const got = repoActivity(
      [pull({ updated_at: ago(6) }), pull({ updated_at: ago(3) }), pull({ updated_at: ago(3) })],
      [],
      NOW,
    );
    expect(got.r1.days).toEqual([1, 0, 0, 2, 0, 0, 0]);
  });

  it("always returns a full week of buckets, so a quiet repository draws a line", () => {
    const got = repoActivity([pull({ state: "open", updated_at: ago(90) })], [], NOW);
    expect(got.r1.days).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("keeps repositories apart", () => {
    const got = repoActivity(
      [pull({ repo: "r2", updated_at: ago(1) })],
      [commit(ago(1)), commit(ago(1), "r2")],
      NOW,
    );
    expect(got.r1.commits).toBe(1);
    expect(got.r1.open).toBe(0);
    expect(got.r2.commits).toBe(1);
    expect(got.r2.open).toBe(1);
  });

  it("ignores a node with no repository on it", () => {
    // Provenance, not identity: a node the sync could not attribute belongs to
    // no row, and putting it in an arbitrary one would be worse than dropping.
    expect(repoActivity([pull({ repo: undefined })], [], NOW)).toEqual({});
    expect(repoActivity([], [{ value: { created_at: ago(1) } }], NOW)).toEqual({});
  });

  it("survives dates it cannot read", () => {
    const got = repoActivity(
      [pull({ state: "open", updated_at: "not a date", created_at: null })],
      [{ value: { repo: "r1", created_at: 17 } }],
      NOW,
    );
    // Still open — that fact does not depend on a date. Nothing bucketed.
    expect(got.r1.open).toBe(1);
    expect(got.r1.commits).toBe(0);
    expect(got.r1.days).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("olderThanWindow", () => {
  it("stops a newest-first walk once it leaves the window", () => {
    expect(olderThanWindow(commit(ago(30)), NOW)).toBe(true);
    expect(olderThanWindow(commit(ago(2)), NOW)).toBe(false);
  });

  it("never lets an undated node truncate the walk", () => {
    // Paging is the walk's job; one row without a date must not cut off the
    // rest of a repository's history.
    expect(olderThanWindow({ value: { repo: "r1" } }, NOW)).toBe(false);
    expect(olderThanWindow({ value: { created_at: "" } }, NOW)).toBe(false);
  });
});
