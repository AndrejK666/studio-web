/* The organization's dashboard: what the level between the platform and the
 * workspaces holds, in one screen (ADR-0042 puts the organization in the
 * path; this is what clicking it shows).
 *
 * Pure rules behind `org-dashboard.tsx`, kept here for their tests. Every
 * count follows the rollups' rule: unknown is `null`, never 0. */

import type { RollupRow } from "./api";

export interface OrgTotals {
  workspaces: number;
  projects: number;
  repos: number | null;
  specs: number | null;
  specsFailing: number | null;
  openFindings: number | null;
  pullsOpen: number | null;
}

/** Sum a column, `null` when no row knows it. */
function sum(rows: readonly RollupRow[], pick: (r: RollupRow) => number | null | undefined): number | null {
  let known = false;
  let total = 0;
  for (const r of rows) {
    const v = pick(r);
    if (typeof v === "number") {
      known = true;
      total += v;
    }
  }
  return known ? total : null;
}

/** The rollup rows of one organization: its workspaces and their projects. */
export function rowsOfOrg(rows: readonly RollupRow[], workspaceIds: ReadonlySet<string>): RollupRow[] {
  return rows.filter((r) =>
    r.kind === "workspace" ? workspaceIds.has(r.id) : !!r.parent_id && workspaceIds.has(r.parent_id),
  );
}

export function orgTotals(rows: readonly RollupRow[]): OrgTotals {
  const projects = rows.filter((r) => r.kind === "project");
  return {
    workspaces: rows.filter((r) => r.kind === "workspace").length,
    projects: projects.length,
    repos: sum(projects, (r) => r.repos),
    specs: sum(projects, (r) => r.specs),
    specsFailing: sum(projects, (r) => r.specs_failing),
    openFindings: sum(projects, (r) => r.open_findings),
    pullsOpen: sum(projects, (r) => r.pulls_open),
  };
}

/** How much a project asks for attention: what is failing, then what waits. */
export function attentionScore(r: RollupRow): number {
  return (r.specs_failing ?? 0) * 3 + (r.open_findings ?? 0) * 2 + (r.pulls_open ?? 0) + (r.open_comments ?? 0);
}

/** What a project's attention is about, in a few words. */
export function attentionLine(r: RollupRow): string {
  const parts: string[] = [];
  const n = (v: number | null | undefined, one: string, many: string) => {
    if (v) parts.push(`${v} ${v === 1 ? one : many}`);
  };
  n(r.specs_failing, "spec failing", "specs failing");
  n(r.open_findings, "open finding", "open findings");
  n(r.pulls_open, "open pull request", "open pull requests");
  n(r.open_comments, "unresolved thread", "unresolved threads");
  return parts.join(" · ");
}

/** The projects most in need of someone, most first; quiet ones are left out. */
export function needsAttention(rows: readonly RollupRow[], limit = 5): RollupRow[] {
  return rows
    .filter((r) => r.kind === "project" && attentionScore(r) > 0)
    .sort((a, b) => attentionScore(b) - attentionScore(a) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** The projects that moved most recently, newest first. */
export function recentlyActive(rows: readonly RollupRow[], limit = 5): RollupRow[] {
  return rows
    .filter((r) => r.kind === "project" && r.last_at)
    .sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""))
    .slice(0, limit);
}

/** Failed runs as one line per kind of failure: the same task failing the
 *  same way five times is one problem, said once with its count. */
export function groupFailures<T extends { task_type: string; last_error?: string | null }>(
  runs: readonly T[],
): { task_type: string; error: string; count: number }[] {
  const out: { task_type: string; error: string; count: number }[] = [];
  for (const r of runs) {
    const error = (r.last_error ?? "failed").trim();
    const same = out.find((g) => g.task_type === r.task_type && g.error === error);
    if (same) same.count += 1;
    else out.push({ task_type: r.task_type, error, count: 1 });
  }
  return out;
}

/** The registry's counts the dashboard shows: every entry, what waits for a
 *  decision (candidates and declared), and what the organization accepted. */
export function registrySummary(states: readonly string[]): {
  total: number;
  candidates: number;
  undecided: number;
  registered: number;
  published: number;
} {
  const count = (s: string) => states.filter((x) => x === s).length;
  return {
    total: states.length,
    candidates: count("candidate"),
    undecided: count("candidate") + count("declared"),
    registered: count("registered"),
    published: count("published"),
  };
}
