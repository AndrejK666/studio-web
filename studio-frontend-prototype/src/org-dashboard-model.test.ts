import { describe, expect, it } from "vitest";

import type { OrgNeed, OrgOverview, OrgWorkspace } from "./api";
import {
  growthText,
  moneyFor,
  moneyLabel,
  needText,
  needsHeadline,
  queueLabel,
  quietText,
  reasonLine,
  workspaceLine,
} from "./org-dashboard-model";

// The rules are the server's (organizations/overview_tests.rs); these are the words.

const money = (n: number) => `$${n}`;
const need = (extra: Partial<OrgNeed>): OrgNeed => ({ kind: "runs", tone: "warn", projects: [], ...extra });

describe("the organization's overview, in words", () => {
  it("says growth, and 'new' when nothing was spent before", () => {
    expect(growthText(123, 100)).toBe("+23%");
    expect(growthText(95, 100)).toBe("−5%");
    expect(growthText(100, 100)).toBe("±0%");
    expect(growthText(10, 0)).toBe("new");
    expect(growthText(0, 0)).toBe("—");
  });

  it("says each need and where it is fixed", () => {
    expect(
      needText(
        need({ kind: "connection", tone: "danger", provider: "github", status: "401", projects: ["Shop", "Billing"] }),
        7,
        money,
      ),
    ).toEqual({
      title: "A github connection is refused (401)",
      detail: "2 projects cannot sync: Shop, Billing",
      target: "connectors",
    });
    expect(needText(need({ kind: "connection", provider: "gitlab", status: "403", repos: 1 }), 7, money).detail).toBe(
      "1 repository cannot sync",
    );
    expect(needText(need({ kind: "spend", current: 150, previous: 100, forecast: 200, grower: "Shop" }), 7, money)).toEqual({
      title: "Spend +50% against the same days last month",
      detail: "$150 in 30 days; the month ends near $200. Grows most: Shop",
      target: "costs",
    });
    expect(needText(need({ kind: "pulls", pulls: 1, people: 1 }), 7, money).title).toBe("1 pull request waits over 7 days");
    expect(needText(need({ kind: "components", components: 2 }), 7, money).title).toBe("2 components wait for a decision");
    expect(needText(need({ kind: "runs", runs: 3 }), 7, money)).toMatchObject({ title: "3 background runs failed", target: "tasks" });
    expect(needsHeadline(0)).toBe("Nothing needs you");
    expect(needsHeadline(1)).toBe("1 thing needs you");
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

  it("names whom spend and stuck work belong to, and never drops the rest", () => {
    const row = (key: string, label: string | null = null) => ({ key, label, cost: 1, previous: 0, unpriced: false });
    expect(moneyLabel("person", row("p-1", "Ada"))).toBe("Ada");
    expect(moneyLabel("person", row("unattributed"))).toBe("Unattributed (not a member's sign-in)");
    expect(moneyLabel("person", row(""))).toBe("IDE sessions (nobody in particular)");
    expect(moneyLabel("payer", row("personal"))).toBe("People's own keys");
    expect(moneyLabel("source", row("llm"))).toBe("Model calls");
    expect(queueLabel({ person_id: null, who: null, count: 1, oldest_days: 8 })).toBe("Nobody asked to review");
    expect(queueLabel({ person_id: "p", who: "Ann", count: 1, oldest_days: 8 })).toBe("Ann");
  });

  it("picks the breakdown the reader asked for", () => {
    const o = {
      money: [
        { group_by: "project", include_personal: false, rows: [] },
        { group_by: "person", include_personal: true, rows: [] },
      ],
    } as unknown as OrgOverview;
    expect(moneyFor(o, "person", true)?.group_by).toBe("person");
    expect(moneyFor(o, "person", false)).toBeNull();
    expect(moneyFor({ money: null } as unknown as OrgOverview, "project", false)).toBeNull();
  });
});
