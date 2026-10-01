import { describe, expect, it } from "vitest";
import type { TaskSchedule } from "./api";
import {
  HOURLY,
  REFRESH_TASK,
  draftOf,
  inputOf,
  newSchedule,
  parseConsumers,
  scheduleOf,
  stateOf,
  stateText,
  type ReportSource,
} from "./reports-model";

const empty: ReportSource = {
  report: "roadmap",
  connection_id: null,
  plan_file: null,
  plan_uploaded: false,
  board: null,
  roots: [],
  consumers: {},
  snapshot: null,
  last_refresh: null,
};

describe("the source form", () => {
  it("round-trips what is saved", () => {
    const saved: ReportSource = {
      ...empty,
      connection_id: "c1",
      plan_file: "o/r:gears.yaml@main",
      board: "o/48",
      roots: ["3342", "o/r#4507"],
      consumers: { A: "Acronis", V: "Virtuozzo" },
    };
    const d = draftOf(saved);
    expect(d).toEqual({
      connectionId: "c1",
      planFile: "o/r:gears.yaml@main",
      planYaml: null,
      board: "o/48",
      roots: "3342 o/r#4507",
      consumers: "A=Acronis, V=Virtuozzo",
    });
    expect(inputOf(d)).toEqual({
      connection_id: "c1",
      plan_file: "o/r:gears.yaml@main",
      board: "o/48",
      roots: ["3342", "o/r#4507"],
      consumers: { A: "Acronis", V: "Virtuozzo" },
    });
  });

  it("sends an upload only when one was picked or cleared", () => {
    const d = draftOf(empty);
    expect("plan_yaml" in inputOf(d)).toBe(false);
    expect(inputOf({ ...d, planYaml: "board: o/48\n" }).plan_yaml).toBe("board: o/48\n");
    expect(inputOf({ ...d, planYaml: "" }).plan_yaml).toBe("");
    // An empty connection is the organization's first one.
    expect(inputOf(d).connection_id).toBeNull();
  });

  it("reads consumers however they are separated", () => {
    expect(parseConsumers("A=Acronis, C=Constructor;V=Virtuozzo\nX=a=b")).toEqual({
      A: "Acronis",
      C: "Constructor",
      V: "Virtuozzo",
      X: "a=b",
    });
    expect(parseConsumers(" , =x, y= ")).toEqual({});
  });
});

describe("the refresh schedule", () => {
  const schedule = (task_type: string, payload: Record<string, unknown>): TaskSchedule =>
    ({ id: `${task_type}:${JSON.stringify(payload)}`, task_type, payload }) as unknown as TaskSchedule;

  it("is the reports.refresh schedule for this report", () => {
    const all = [
      schedule("catalog.sync", { report: "roadmap" }),
      schedule(REFRESH_TASK, { report: "other" }),
      schedule(REFRESH_TASK, { report: "roadmap" }),
    ];
    expect(scheduleOf(all, "roadmap")?.id).toBe(`${REFRESH_TASK}:{"report":"roadmap"}`);
    expect(scheduleOf(all, "weekly")).toBeUndefined();
  });

  it("is created hourly, never overlapping itself", () => {
    const s = newSchedule("roadmap");
    expect(s).toMatchObject({ task_type: REFRESH_TASK, payload: { report: "roadmap" }, expression: HOURLY });
    expect(s.concurrency).toBe("forbid");
    expect(s.missed_policy).toBe("skip");
  });
});

describe("a source's state", () => {
  it("says what is missing, what failed, or where the plan came from", () => {
    expect(stateOf(empty).kind).toBe("empty");
    expect(stateOf({ ...empty, plan_file: "o/r:p.yaml" })).toEqual({ kind: "unread", what: "o/r:p.yaml" });
    expect(stateOf({ ...empty, board: "o/48" })).toEqual({ kind: "unread", what: "o/48" });
    const read = { ...empty, snapshot: { from: "o/r:p.yaml@main", sha: "abc", read_at: "2026-10-01T09:30:00Z", size: 10 } };
    expect(stateOf(read)).toEqual({ kind: "ready", from: "o/r:p.yaml@main", at: "2026-10-01T09:30:00Z" });
    expect(stateText(stateOf(read))).toBe("Plan from o/r:p.yaml@main, read 2026-10-01 09:30.");
    const up = { ...read, snapshot: { ...read.snapshot, from: "upload" } };
    expect(stateText(stateOf(up))).toContain("an uploaded file");
    // A failure is said first: the plan read before it is still what is drawn.
    const failed = { ...read, last_refresh: { at: "t", sync_run: null, error: "not visible" } };
    expect(stateOf(failed)).toEqual({ kind: "failed", error: "not visible" });
    expect(stateText(stateOf(failed))).toContain("not visible");
    expect(stateText(stateOf(empty))).toContain("Not configured");
  });
});
