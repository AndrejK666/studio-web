/* The organization's overview: what its leaders ask of it, in their words.
 *
 * The rules — which connection is refused, what is stuck, whose spend it is,
 * which workspace is worst — are the server's (`studio-backend/src/
 * organizations/overview.rs`, one request). What stays here is every word a
 * reader sees, decided once and tested, not improvised in the markup. */

import type { CostGroup, OrgMoney, OrgNeed, OrgOverview, OrgQueue, OrgReason, OrgWorkspace } from "./api";

export type NeedTarget = "connectors" | "costs" | "projects" | "gears" | "tasks";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "+23%", "−5%", or "new" when nothing was spent before. */
export function growthText(current: number, previous: number): string {
  if (previous <= 0) return current > 0 ? "new" : "—";
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct > 0 ? `+${pct}%` : pct < 0 ? `−${-pct}%` : "±0%";
}

/** One thing that needs the leader: what is wrong, and where it is fixed. */
export function needText(
  n: OrgNeed,
  stuckDays: number,
  money: (v: number) => string,
): { title: string; detail: string; target: NeedTarget } {
  switch (n.kind) {
    case "connection": {
      const shown = n.projects.slice(0, 3).join(", ") + (n.projects.length > 3 ? "…" : "");
      return {
        title: `A ${n.provider ?? "git"} connection is refused (${n.status ?? "401"})`,
        detail: n.projects.length
          ? `${plural(n.projects.length, "project", "projects")} cannot sync: ${shown}`
          : `${plural(n.repos ?? 0, "repository", "repositories")} cannot sync`,
        target: "connectors",
      };
    }
    case "spend": {
      const current = n.current ?? 0;
      return {
        title: `Spend ${growthText(current, n.previous ?? 0)} against the same days last month`,
        detail:
          `${money(current)} in 30 days; the month ends near ${money(n.forecast ?? 0)}` +
          (n.grower ? `. Grows most: ${n.grower}` : ""),
        target: "costs",
      };
    }
    case "pulls":
      return {
        title: `${plural(n.pulls ?? 0, "pull request waits", "pull requests wait")} over ${stuckDays} days`,
        detail: `on ${plural(n.people ?? 0, "person", "people")}`,
        target: "projects",
      };
    case "components":
      return {
        title: `${plural(n.components ?? 0, "component waits", "components wait")} for a decision`,
        detail: "make it a gear of the organization, or leave it in its project",
        target: "gears",
      };
    case "runs":
      return {
        title: `${plural(n.runs ?? 0, "background run", "background runs")} failed`,
        detail: "not a refused connection; the runs list says what",
        target: "tasks",
      };
  }
}

/** What is wrong with a project, in a few words. */
export function reasonText(r: OrgReason, stuckDays: number): string {
  const v = Math.round(r.value ?? 0);
  switch (r.kind) {
    case "refused":
      return "its repository connection is refused";
    case "specs_failing":
      return `${v} ${v === 1 ? "spec fails" : "specs fail"}`;
    case "stuck":
      return `${plural(v, "pull request waits", "pull requests wait")} over ${stuckDays} days`;
    case "spend_grows":
      return `spend +${Math.round((r.value ?? 0) * 100)}%`;
    case "quiet":
      return `quiet for ${v} days`;
  }
}

export function reasonLine(reasons: readonly OrgReason[], stuckDays: number): string {
  return reasons.map((r) => reasonText(r, stuckDays)).join(" · ");
}

/** A workspace's one line: its worst project and why, and how many more. */
export function workspaceLine(ws: OrgWorkspace, stuckDays: number): string {
  const troubled = ws.projects.filter((p) => p.reasons.length > 0);
  if (troubled.length === 0) return `${plural(ws.projects.length, "project", "projects")}, nothing wrong`;
  const more = troubled.length - 1;
  return (
    `${troubled[0].name}: ${reasonLine(troubled[0].reasons, stuckDays)}` +
    (more > 0 ? ` · ${plural(more, "more project", "more projects")}` : "")
  );
}

/** Days without activity: "today", "3 d", or "—" when unknown. */
export function quietText(days: number | null): string {
  return days === null ? "—" : days === 0 ? "today" : `${days} d`;
}

/** Who a queue is: the member's name, the account, or nobody at all. */
export function queueLabel(q: OrgQueue): string {
  return q.who ?? "Nobody asked to review";
}

/** A row of "where the money goes", named. */
export function moneyLabel(group: CostGroup, row: OrgMoney["rows"][number]): string {
  if (row.label) return row.label;
  switch (group) {
    case "person":
      if (row.key === "unattributed") return "Unattributed (not a member's sign-in)";
      if (!row.key) return "IDE sessions (nobody in particular)";
      return `Person ${row.key.slice(0, 8)}`;
    case "source":
      return row.key === "llm" ? "Model calls" : row.key === "session" ? "IDE sessions" : row.key;
    case "payer":
      return (
        { personal: "People's own keys", workspace: "Workspace connections", organization: "The organization" }[row.key] ??
        (row.key || "Unknown")
      );
    case "model":
      return row.key === "ide-session" ? "IDE sessions" : row.key;
    default:
      return row.key || "—";
  }
}

/** The breakdown the reader picked, from the ones the overview carries. */
export function moneyFor(o: OrgOverview, group: CostGroup, personal: boolean): OrgMoney | null {
  return o.money?.find((m) => m.group_by === group && m.include_personal === personal) ?? null;
}

/** The headline over the needs. */
export function needsHeadline(n: number): string {
  return n === 0 ? "Nothing needs you" : `${n} ${n === 1 ? "thing needs" : "things need"} you`;
}
