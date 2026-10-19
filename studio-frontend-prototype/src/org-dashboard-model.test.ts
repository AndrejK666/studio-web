import { describe, expect, it } from "vitest";

import type { RollupRow } from "./api";
import {
  brokenConnections,
  costShifts,
  daysSince,
  forecastMonth,
  growthText,
  median,
  needsYou,
  orgTotals,
  otherFailures,
  refusal,
  registrySummary,
  rowsOfOrg,
  spendWindows,
  stuckPulls,
  topGrower,
  waitingOnPeople,
  workspaceHealth,
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

describe("what the organization spends", () => {
  it("compares the last 30 days with the same days a month earlier", () => {
    const w = spendWindows(new Date("2026-10-19T15:00:00Z"));
    expect(w.current).toEqual({ from: "2026-09-20T00:00:00Z", to: "2026-10-20T00:00:00Z" });
    // 21 Aug – 19 Sep, both included: the same 30 days ending a month before today.
    expect(w.previous).toEqual({ from: "2026-08-21T00:00:00Z", to: "2026-09-20T00:00:00Z" });
    expect(w.month).toEqual({ from: "2026-10-01T00:00:00Z", to: "2026-10-20T00:00:00Z" });
    expect([w.elapsedDays, w.monthDays]).toEqual([19, 31]);
  });

  it("takes the last day of a shorter month a month back", () => {
    // 31 March: one month back is 28 February, not 3 March.
    expect(spendWindows(new Date("2026-03-31T10:00:00Z")).previous.to).toBe("2026-03-01T00:00:00Z");
  });

  it("says growth, and 'new' when nothing was spent before", () => {
    expect(growthText(123, 100)).toBe("+23%");
    expect(growthText(95, 100)).toBe("−5%");
    expect(growthText(100, 100)).toBe("±0%");
    expect(growthText(10, 0)).toBe("new");
    expect(growthText(0, 0)).toBe("—");
  });

  it("forecasts the month at its pace so far", () => {
    expect(forecastMonth(100, 10, 31)).toBe(310);
    expect(forecastMonth(0, 0, 30)).toBe(0);
  });

  it("puts both periods side by side and finds who grows most", () => {
    const shifts = costShifts(
      [
        { key: "a", cost: 50, unpriced: false },
        { key: "b", cost: 30, unpriced: true },
      ],
      [
        { key: "a", cost: 45 },
        { key: "b", cost: 5 },
        { key: "gone", cost: 20 },
      ],
    );
    expect(shifts.map((s) => [s.key, s.cost, s.previous, s.delta])).toEqual([
      ["a", 50, 45, 5],
      ["b", 30, 5, 25],
      ["gone", 0, 20, -20],
    ]);
    expect(topGrower(shifts)?.key).toBe("b");
    expect(topGrower([{ key: "x", cost: 1, previous: 2, delta: -1, unpriced: false }])).toBeNull();
  });
});

describe("a connection the provider refuses", () => {
  const run = (state: string, repo: string, error: string | null, at: string, project = "p1") => ({
    task_type: "artifact.ingest",
    state,
    payload: { provider: "github", secret_ref: "gh-org", repo_full_path: repo, project_id: project },
    last_error: error,
    created_at: at,
  });

  it("reads a refused credential, not a rate limit", () => {
    expect(refusal("GitHub 401 Unauthorized: Bad credentials")).toBe("401");
    expect(refusal("403 Forbidden: Resource not accessible by integration")).toBe("403");
    expect(refusal("GitHub 403 Forbidden: API rate limit exceeded for user ID 301748190.")).toBeNull();
    expect(refusal("connection reset by peer")).toBeNull();
  });

  it("counts only each repository's newest run", () => {
    const broken = brokenConnections([
      // Newest first. acme/api synced again since it was refused: fine.
      run("succeeded", "acme/api", null, "2026-10-19T10:00:00Z"),
      run("failed", "acme/web", "GitHub 401 Bad credentials", "2026-10-19T09:00:00Z", "p2"),
      run("failed", "acme/api", "GitHub 401 Bad credentials", "2026-10-18T09:00:00Z"),
      run("failed", "acme/web", "GitHub 401 Bad credentials", "2026-10-17T09:00:00Z", "p2"),
      run("failed", "acme/docs", "GitHub 401 Bad credentials", "2026-10-16T09:00:00Z", "p3"),
    ]);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({
      key: "gh-org",
      provider: "github",
      status: "401",
      repos: ["acme/web", "acme/docs"],
      projectIds: ["p2", "p3"],
      since: "2026-10-16T09:00:00Z",
    });
  });

  it("counts other failures without listing them", () => {
    expect(
      otherFailures([
        run("failed", "a/b", "GitHub 401 Bad credentials", "2026-10-19T00:00:00Z"),
        run("failed", "a/c", "timeout", "2026-10-19T00:00:00Z"),
        run("succeeded", "a/d", null, "2026-10-19T00:00:00Z"),
      ]),
    ).toBe(1);
  });
});

describe("work that does not move", () => {
  const pull = (extra: Partial<Parameters<typeof stuckPulls>[0][number]>) => ({
    project_id: "p1",
    waiting: "review",
    draft: false,
    waiting_on: [] as { login: string; display_name: string | null }[],
    days_open: 10,
    days_since_update: 8,
    ...extra,
  });

  it("calls a pull request stuck after 7 days without a move, never a draft", () => {
    const stuck = stuckPulls([
      pull({}),
      pull({ days_since_update: 2 }),
      pull({ draft: true, waiting: "draft" }),
      pull({ days_since_update: null, days_open: 7 }),
    ]);
    expect(stuck).toHaveLength(2);
  });

  it("queues them by the person they wait on", () => {
    const ann = { login: "ann", display_name: "Ann" };
    const bob = { login: "bob", display_name: null };
    expect(
      waitingOnPeople([
        pull({ waiting_on: [ann, bob], days_since_update: 9 }),
        pull({ waiting_on: [ann], days_since_update: 12 }),
        pull({ waiting: "nobody" }),
      ]),
    ).toEqual([
      { who: "Ann", count: 2, oldest: 12 },
      { who: "bob", count: 1, oldest: 9 },
      { who: "Nobody asked to review", count: 1, oldest: 8 },
    ]);
  });

  it("takes the middle wait", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("counts quiet days, unknown when there was no activity", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    expect(daysSince("2026-10-01T12:00:00Z", now)).toBe(18);
    expect(daysSince(null, now)).toBeNull();
  });
});

describe("the organization by workspace", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const rows = [
    ws("calm"),
    ws("fire"),
    project("ok", "calm", { last_at: "2026-10-18T00:00:00Z" }),
    project("broken", "fire", { last_at: "2026-10-18T00:00:00Z" }),
    project("slow", "fire", { specs_failing: 1, last_at: "2026-09-01T00:00:00Z" }),
  ];

  it("puts the workspace in most trouble first, and says why", () => {
    const health = workspaceHealth(rows, {
      spend: new Map([["broken", 30], ["slow", 10], ["ok", 5]]),
      previous: new Map([["broken", 10], ["ok", 5]]),
      stuck: new Map([["slow", 2]]),
      broken: new Set(["broken"]),
      now,
    });
    expect(health.map((w) => w.row.id)).toEqual(["fire", "calm"]);
    const fire = health[0];
    expect(fire.projects.map((p) => p.row.id)).toEqual(["broken", "slow"]);
    expect(fire.projects[0].reason).toBe("its repository connection is refused · spend +200%");
    expect(fire.projects[1].reason).toBe("1 spec fails · 2 pull requests wait over 7 days · quiet for 48 days");
    expect(fire.reason).toBe("broken: its repository connection is refused · spend +200% · 1 more project");
    expect([fire.spend, fire.previous, fire.specsFailing, fire.stuck, fire.quietDays]).toEqual([40, 10, 1, 2, 1]);
    expect(health[1].reason).toBe("");
  });

  it("says spend is unknown when costs cannot be read", () => {
    const health = workspaceHealth(rows, { spend: null, previous: null, stuck: new Map(), broken: new Set(), now });
    expect(health.every((w) => w.spend === null)).toBe(true);
  });
});

describe("what needs the organization's leader", () => {
  const money = (n: number) => `$${n}`;
  const base = {
    broken: [],
    projectNames: new Map<string, string>(),
    spend: null,
    stuck: 0,
    waitingOn: 0,
    undecided: 0,
    otherFailures: 0,
  };

  it("is nothing when nothing is wrong", () => {
    expect(needsYou(base)).toEqual([]);
    expect(needsYou({ ...base, spend: { current: 110, previous: 100, forecast: 120, grower: null, money } })).toEqual([]);
  });

  it("says a refused connection with the projects it stops, first", () => {
    const items = needsYou({
      ...base,
      undecided: 2,
      broken: [
        { key: "k", provider: "github", status: "401", error: "", repos: ["a/b"], projectIds: ["p1", "p2"], since: "" },
      ],
      projectNames: new Map([["p1", "Shop"], ["p2", "Billing"]]),
      spend: { current: 150, previous: 100, forecast: 200, grower: "Shop", money },
      stuck: 3,
      waitingOn: 2,
      otherFailures: 1,
    });
    expect(items.map((i) => i.kind)).toEqual(["connection", "spend", "pulls", "components", "runs"]);
    expect(items[0]).toMatchObject({
      title: "A github connection is refused (401)",
      detail: "2 projects cannot sync: Shop, Billing",
      target: "connectors",
    });
    expect(items[1].title).toBe("Spend +50% against the same days last month");
    expect(items[1].detail).toBe("$150 in 30 days; the month ends near $200. Grows most: Shop");
    expect(items[2].title).toBe("3 pull requests wait over 7 days");
  });
});
