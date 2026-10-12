import { describe, expect, it } from "vitest";

import type { RollupRow } from "./api";
import {
  attentionLine,
  needsAttention,
  orgTotals,
  recentlyActive,
  registrySummary,
  rowsOfOrg,
} from "./org-dashboard-model";

const ws = (id: string): RollupRow => ({ id, name: id, kind: "workspace", projects: 1 });
const project = (id: string, parent: string, extra: Partial<RollupRow> = {}): RollupRow => ({
  id,
  name: id,
  kind: "project",
  parent_id: parent,
  ...extra,
});

describe("the organization's dashboard", () => {
  const rows = [
    ws("w1"),
    ws("w-other"),
    project("quiet", "w1", { repos: 1, specs: 4, pulls_open: 0, last_at: "2026-10-01T00:00:00Z" }),
    project("busy", "w1", { repos: 2, specs: 10, specs_failing: 2, open_findings: 1, pulls_open: 3, last_at: "2026-10-11T00:00:00Z" }),
    project("unknown", "w1"),
    project("elsewhere", "w-other", { repos: 9, specs_failing: 9 }),
  ];

  it("keeps the organization's own workspaces and projects", () => {
    expect(rowsOfOrg(rows, new Set(["w1"])).map((r) => r.id)).toEqual(["w1", "quiet", "busy", "unknown"]);
  });

  it("sums what is known and says unknown rather than 0", () => {
    const own = rowsOfOrg(rows, new Set(["w1"]));
    expect(orgTotals(own)).toEqual({
      workspaces: 1,
      projects: 3,
      repos: 3,
      specs: 14,
      specsFailing: 2,
      openFindings: 1,
      pullsOpen: 3,
    });
    expect(orgTotals([ws("w1"), project("p", "w1")]).repos).toBeNull();
  });

  it("puts failing projects first and leaves quiet ones out", () => {
    const own = rowsOfOrg(rows, new Set(["w1"]));
    expect(needsAttention(own).map((r) => r.id)).toEqual(["busy"]);
    expect(attentionLine(own[2])).toBe("2 specs failing · 1 open finding · 3 open pull requests");
  });

  it("lists the newest activity first", () => {
    expect(recentlyActive(rows).map((r) => r.id)).toEqual(["busy", "quiet"]);
  });

  it("counts what the registry waits on", () => {
    expect(registrySummary(["candidate", "declared", "declared", "registered", "published", "rejected"])).toEqual({
      total: 6,
      candidates: 1,
      undecided: 3,
      registered: 1,
      published: 1,
    });
  });
});
