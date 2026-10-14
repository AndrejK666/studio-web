import { describe, expect, it } from "vitest";

import type { ArtifactNode } from "./api";
import { buildDuration, buildStatus, buildsHeadline, buildsOf, latestFinished, mainBranch, workflowsOf } from "./builds";

const node = (id: string, v: Record<string, unknown>): ArtifactNode => ({
  type_id: "gts.cf.studio.artifact.workflow_run.v1~",
  instance_id: id,
  value: v,
});

const runs = buildsOf([
  node("a", { workflow: "Delivery", branch: "main", sha: "aaaaaaa1", status: "completed", conclusion: "failure", created_at: "2026-10-14T08:00:00Z" }),
  node("b", { workflow: "Delivery", branch: "main", sha: "bbbbbbb2", status: "in_progress", created_at: "2026-10-14T09:00:00Z" }),
  node("c", { workflow: "Delivery", branch: "feat/x", sha: "ccccccc3", status: "completed", conclusion: "success", created_at: "2026-10-14T07:00:00Z" }),
  node("d", { workflow: "Docs", branch: "main", sha: "ddddddd4", status: "completed", conclusion: "success", created_at: "2026-10-13T07:00:00Z" }),
]);

describe("builds", () => {
  it("reads a run's status from the provider's status and conclusion", () => {
    expect(buildStatus("in_progress", null)).toBe("running");
    expect(buildStatus("queued", null)).toBe("queued");
    expect(buildStatus("waiting", null)).toBe("queued");
    expect(buildStatus("completed", "success")).toBe("passed");
    expect(buildStatus("completed", "cancelled")).toBe("cancelled");
    expect(buildStatus("completed", "skipped")).toBe("skipped");
    expect(buildStatus("completed", "timed_out")).toBe("failed");
  });

  it("orders runs newest first and counts workflows, most runs first", () => {
    expect(runs.map((r) => r.id)).toEqual(["b", "a", "c", "d"]);
    expect(runs[0].shortSha).toBe("bbbbbbb");
    expect(workflowsOf(runs)).toEqual([
      { name: "Delivery", runs: 3 },
      { name: "Docs", runs: 1 },
    ]);
  });

  it("answers whether main builds from its newest finished run", () => {
    expect(mainBranch(runs)).toBe("main");
    expect(latestFinished(runs, "main")?.id).toBe("a");
    expect(buildsHeadline(runs, "Delivery")).toBe("main does not build: Delivery failed on aaaaaaa.");
    expect(buildsHeadline(runs, "Docs")).toBe("main builds: Docs passed on ddddddd.");
    expect(buildsHeadline([], null)).toBe("No CI runs yet.");
    expect(mainBranch(buildsOf([node("x", { branch: "dev" }), node("y", { branch: "dev" }), node("z", { branch: "x" })]))).toBe("dev");
  });

  it("says how long a run took, or has been running", () => {
    expect(
      buildDuration({ status: "passed", startedAt: "2026-10-14T08:00:00Z", createdAt: null, updatedAt: "2026-10-14T08:06:10Z" }),
    ).toBe("6 min");
    expect(
      buildDuration({ status: "failed", startedAt: "2026-10-14T08:00:00Z", createdAt: null, updatedAt: "2026-10-14T08:00:40Z" }),
    ).toBe("40 s");
    expect(
      buildDuration(
        { status: "running", startedAt: "2026-10-14T08:00:00Z", createdAt: null, updatedAt: null },
        Date.parse("2026-10-14T09:05:00Z"),
      ),
    ).toBe("1 h 5 min");
    expect(buildDuration({ status: "queued", startedAt: null, createdAt: null, updatedAt: null })).toBeNull();
  });
});
