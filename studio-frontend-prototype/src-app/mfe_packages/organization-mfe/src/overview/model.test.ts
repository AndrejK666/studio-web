import { describe, expect, it } from "vitest";

import type { Line, OrgNeed, OrgOverview, OrgWorkspace } from "./types";
import {
  hasKit,
  attentionStatus,
  growthText,
  othersAttention,
  say,
  wordsIn,
  workspaceDescription,
  workspaceStatus,
  needText,
  needsHeadline,
  quietText,
  reasonLine,
  workspaceLine,
  type SayOptions,
} from "./model";

// The rules are the server's (organizations/overview_tests.rs); these are the words.

const need = (extra: Partial<OrgNeed>): OrgNeed => ({ kind: "runs", tone: "warn", projects: [], ...extra });
const words: SayOptions = { language: "en", money: (v, c) => `${v} ${c}`, unknown: "—" };

describe("hasKit", () => {
  it("answers from the kits the overview was computed for; unknown kits count as installed", () => {
    expect(hasKit({ kits: ["project-git"] }, "project-git")).toBe(true);
    expect(hasKit({ kits: ["components"] }, "project-git")).toBe(false);
    expect(hasKit({ kits: [] }, "project-git")).toBe(false);
    expect(hasKit({ kits: null }, "project-git")).toBe(true);
    expect(hasKit({}, "project-git")).toBe(true);
  });
});

describe("the organization's overview, in words", () => {
  it("says growth, and 'new' when nothing was spent before", () => {
    expect(growthText(123, 100)).toBe("+23%");
    expect(growthText(95, 100)).toBe("−5%");
    expect(growthText(100, 100)).toBe("±0%");
    expect(growthText(10, 0)).toBe("new");
    expect(growthText(0, 0)).toBe("—");
  });

  it("says each of the organization's own needs and where it is fixed", () => {
    expect(
      needText(need({ kind: "connection", tone: "danger", provider: "github", status: "401", projects: ["Shop", "Billing"] })),
    ).toEqual({
      title: "A github connection is refused (401)",
      detail: "2 projects cannot sync: Shop, Billing",
      target: "connectors",
    });
    expect(needText(need({ kind: "connection", provider: "gitlab", status: "403", repos: 1 })).detail).toBe(
      "1 repository cannot sync",
    );
    expect(needText(need({ kind: "runs", runs: 3 }))).toMatchObject({ title: "3 background runs failed", target: "tasks" });
    expect(needsHeadline(0)).toBe("Nothing needs you");
    expect(needsHeadline(1)).toBe("1 thing needs you");
  });

  it("says a kit's line in the reader's language, figures formatted and the unknown never zero", () => {
    const line: Line = {
      text: { en: "{current}, {growth}, {n} open, {wait} d", ru: "{current}: {n}" },
      args: {
        current: { kind: "money", value: 120, currency: "EUR" },
        growth: { kind: "text", text: "+20%" },
        n: { kind: "count", value: 4 },
        wait: { kind: "count", value: null },
      },
    };
    expect(say(line, words)).toBe("120 EUR, +20%, 4 open, — d");
    expect(say(line, { ...words, language: "ru-RU" })).toBe("120 EUR: 4");
    expect(say({ text: { en: "{missing}" }, args: {} }, words)).toBe("{missing}");
    expect(wordsIn({ en: "Spend", ru: "Расходы" }, "de")).toBe("Spend");
  });

  it("says a workspace by its worst project, and a project by what is wrong", () => {
    const ws: OrgWorkspace = {
      id: "w",
      name: "Fire",
      spend: null,
      previous: null,
      specs_failing: 1,
      stuck: 2,
      quiet_days: 1,
      score: 20,
      projects: [
        {
          id: "p1",
          name: "broken",
          spend: 30,
          previous: 10,
          specs_failing: 0,
          open_findings: 0,
          stuck: 0,
          quiet_days: 1,
          broken: true,
          score: 12,
          reasons: [
            { kind: "refused", value: null },
            { kind: "spend_grows", value: 2 },
          ],
        },
        {
          id: "p2",
          name: "slow",
          spend: null,
          previous: null,
          specs_failing: 1,
          open_findings: 0,
          stuck: 2,
          quiet_days: 48,
          broken: false,
          score: 8,
          reasons: [
            { kind: "specs_failing", value: 1 },
            { kind: "stuck", value: 2 },
            { kind: "quiet", value: 48 },
          ],
        },
      ],
    };
    expect(workspaceLine(ws, 7)).toBe("broken: its repository connection is refused · spend +200% · 1 more project");
    expect(reasonLine(ws.projects[1].reasons, 7)).toBe("1 spec fails · 2 pull requests wait over 7 days · quiet for 48 days");
    expect(workspaceLine({ ...ws, projects: [{ ...ws.projects[0], reasons: [] }] }, 7)).toBe("1 project, nothing wrong");
    expect([quietText(null), quietText(0), quietText(3)]).toEqual(["—", "today", "3 d"]);
  });

  it("says what needs the others once: refused connections, then the kits' needs in their order, then runs and the idle", () => {
    const o = {
      stuck_days: 7,
      needs: [
        need({ kind: "runs", runs: 1 }),
        need({ kind: "connection", tone: "danger", provider: "github", status: "401", projects: ["Shop"] }),
      ],
      blocks: [
        {
          kit: "org-costs", id: "spend", order: 10, tile: null, data: {},
          needs: [{
            key: "spend", tone: "warn",
            sentence: { text: { en: "Spend {g}" }, args: { g: { kind: "text", text: "+50%" } } },
            detail: { text: { en: "{c} in 30 days" }, args: { c: { kind: "money", value: 150, currency: "USD" } } },
            action: { route: "/costs", label: { en: "Open Costs" } },
          }],
        },
        {
          kit: "project-git", id: "delivery", order: 20, tile: null, data: {},
          needs: [{ key: "queue:nobody", tone: "info", sentence: { text: { en: "1 waits on nobody" }, args: {} } }],
        },
      ],
      people: { active: 3, idle: [{ person_id: "abcdef123", name: null }] },
    } as unknown as OrgOverview;
    const rows = othersAttention(o, words);
    expect(rows.map((r) => [r.key, r.sentence, r.action?.target ?? r.action?.link?.route ?? null])).toEqual([
      ["need:connection:1", "A github connection is refused (401)", "connectors"],
      ["org-costs/spend:spend", "Spend +50%", "/costs"],
      ["project-git/delivery:queue:nobody", "1 waits on nobody", null],
      ["need:runs:0", "1 background run failed", "tasks"],
      ["idle", "1 person has been idle for 30 days", "people"],
    ]);
    expect(rows[1].detail).toBe("150 USD in 30 days");
    expect(rows[1].action?.label).toBe("Open Costs");
    expect(rows[0].tone).toBe("danger");
    expect(rows[2].tone).toBe("info");
    // Without the blocks, only the organization's own.
    expect(othersAttention({ ...o, blocks: [], people: { active: 3, idle: null } }, words).map((r) => r.key)).toEqual([
      "need:connection:1",
      "need:runs:0",
    ]);
    expect(attentionStatus(null, 0)).toBe("Reading what needs attention…");
    expect(attentionStatus(0, 0)).toBe("Nothing needs attention");
    expect(attentionStatus(2, 1)).toBe("3 things need attention");
  });

  it("describes a workspace by what it holds, not by the word workspace", () => {
    expect(workspaceDescription(["Shop", "Billing"], false)).toBe("Shop, Billing");
    expect(workspaceDescription(["a", "b", "c", "d", "e"], true)).toBe("Self-managed · a, b, c and 2 more");
    expect(workspaceDescription([], false)).toBe("No projects yet");
    expect(workspaceDescription(undefined, false)).toBe("");
    expect(workspaceStatus(3, 213)).toBe("3 projects · 213 findings");
    expect(workspaceStatus(1, null)).toBe("1 project");
    expect(workspaceStatus(null, null)).toBe("");
  });
});
