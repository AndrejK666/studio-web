import { describe, expect, it } from "vitest";

import type { TaskRun } from "./types";
import { duration, foldRecurring, headline, linkedRunOf, mergePages, runProgress, stateTone } from "./model";

function run(id: string, task_type: string, state: string, created_at: string): TaskRun {
  return { id, task_type, state, created_at, attempts: 1, payload: {} } as unknown as TaskRun;
}

describe("background work list", () => {
  it("folds a scheduled task's succeeded runs into one row", () => {
    const rows = foldRecurring(
      [
        run("1", "session.reap", "succeeded", "2026-11-04T10:05:00Z"),
        run("2", "catalog.sync", "failed", "2026-11-04T10:04:00Z"),
        run("3", "session.reap", "succeeded", "2026-11-04T10:00:00Z"),
        run("4", "session.reap", "failed", "2026-11-04T09:55:00Z"),
        run("5", "session.reap", "succeeded", "2026-11-04T09:50:00Z"),
      ],
      new Set(["session.reap"]),
    );
    expect(rows.map((r) => [r.id, r.folded])).toEqual([
      ["1", 2],
      ["2", undefined],
      ["4", undefined],
    ]);
  });

  it("leaves a task no schedule fires as it is", () => {
    const rows = foldRecurring([run("1", "import", "succeeded", "2026-11-04T10:00:00Z"), run("2", "import", "succeeded", "2026-11-04T09:00:00Z")], new Set());
    expect(rows).toHaveLength(2);
  });

  it("merges failed and running into one page, newest first", () => {
    const failed = [run("f1", "a", "failed", "2026-11-04T10:00:00Z"), run("f2", "a", "failed", "2026-11-04T08:00:00Z")];
    const running = [run("r1", "b", "running", "2026-11-04T09:00:00Z")];
    expect(mergePages([failed, running], 0, 2).map((r) => r.id)).toEqual(["f1", "r1"]);
    expect(mergePages([failed, running], 2, 2).map((r) => r.id)).toEqual(["f2"]);
  });

  it("gives every state a tone, so no chip is left without one", () => {
    expect(["queued", "running", "succeeded", "failed", "cancelled"].map(stateTone)).toEqual(["neutral", "running", "ok", "danger", "warn"]);
  });
});

describe('a run line', () => {
  const base = { id: 'r', task_type: 't', state: 'running', created_at: '', attempts: 1, payload: {} } as unknown as TaskRun;

  it('says how long it took, or has been going', () => {
    const at = Date.parse('2026-11-04T10:00:00Z');
    expect(duration({ ...base, started_at: '2026-11-04T10:00:00Z', finished_at: '2026-11-04T10:00:02.5Z' }, at)).toBe('2.5 s');
    expect(duration({ ...base, started_at: '2026-11-04T10:00:00Z' }, at + 125_000)).toBe('2m 5s');
    expect(duration(base, at)).toBe('—');
  });

  it('heads with what it did, else why it stopped, else where it got to', () => {
    expect(headline({ ...base, summary: 'did', last_error: 'x' })).toBe('did');
    expect(headline({ ...base, last_error: 'broke', progress: 'p' })).toBe('broke');
    expect(headline({ ...base, progress: 'reading' })).toBe('reading');
  });
});

describe("a running run that counts", () => {
  const steps = ["prepare", "desk", "upload", "images", "deploy", "ready"];
  const counting = (state: string, progress: unknown) => ({ ...run("r", "environments.research.build", state, "2026-11-23T10:00:00Z"), result: { progress } }) as TaskRun;

  it("goes the whole way by its steps, the current one by bytes, files or images", () => {
    const upload = counting("running", { step: "upload", steps, files: { done: 1, total: 4 }, bytes: { done: 60, total: 120 } });
    expect(runProgress(upload)).toEqual({ step: "upload", share: 2.5 / 6 });
    expect(runProgress(counting("running", { step: "images", steps, images: { done: 3, total: 3 } }))?.share).toBeCloseTo(4 / 6);
    expect(runProgress(counting("running", { step: "desk", steps }))?.share).toBeCloseTo(1 / 6);
  });

  it("is nothing for a run that does not count, or no longer runs", () => {
    expect(runProgress(run("r", "a", "running", "2026-11-23T10:00:00Z"))).toBeNull();
    expect(runProgress(counting("succeeded", { step: "upload", steps }))).toBeNull();
    expect(runProgress(counting("running", { step: "launch", steps }))).toBeNull();
  });
});

describe('linkedRunOf', () => {
  it('reads the run a screen view names, and nothing else', () => {
    expect(linkedRunOf('run-0d9c1f2a-1111-4222-8333-444455556666')).toBe('0d9c1f2a-1111-4222-8333-444455556666');
    expect(linkedRunOf('run-nope')).toBeNull();
    expect(linkedRunOf('needs-decision')).toBeNull();
    expect(linkedRunOf(undefined)).toBeNull();
  });
});
