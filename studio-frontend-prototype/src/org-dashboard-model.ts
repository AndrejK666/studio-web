/* The organization's overview: what the level between the platform and the
 * workspaces holds, said for the people who lead it (ADR-0042 puts the
 * organization in the path; this is what clicking it shows).
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

/* ── What an organization's leader asks of it ────────────────────────────────
 *
 * The overview answers four questions before anything else: what is on fire,
 * where (by workspace, then project), whether money grows and who grows it,
 * and whether work moves. The rules below decide each answer; the screen only
 * draws them. */

/** A pull request waiting this many days without a move is stuck. */
export const STUCK_DAYS = 7;
/** Spend growing by this share against the same days last month is news. */
export const GROWTH_ALERT = 0.2;
/** A project with no activity for this many days is quiet. */
export const QUIET_DAYS = 14;

export interface Range {
  from: string;
  to: string;
}

export interface SpendWindows {
  /** The last 30 days, today included. */
  current: Range;
  /** The same 30 days one month earlier. */
  previous: Range;
  /** This month so far, today included: what the month-end forecast runs on. */
  month: Range;
  /** Days of this month counted so far, and in the whole month. */
  elapsedDays: number;
  monthDays: number;
}

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The periods the overview compares, in UTC days like the Costs screen. */
export function spendWindows(now: Date = new Date()): SpendWindows {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const to = Date.UTC(y, m, d + 1);
  // One month back; the 31st after a shorter month is that month's last day.
  const prevMonthDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prevTo = Date.UTC(y, m - 1, Math.min(d, prevMonthDays) + 1);
  return {
    current: { from: iso(to - 30 * DAY_MS), to: iso(to) },
    previous: { from: iso(prevTo - 30 * DAY_MS), to: iso(prevTo) },
    month: { from: iso(Date.UTC(y, m, 1)), to: iso(to) },
    elapsedDays: d,
    monthDays: new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
  };
}

/** How much `current` grew against `previous`, as a share; null when there
 *  was nothing before to grow from. */
export function growth(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

/** "+23%", "−5%", or "new" when nothing was spent before. */
export function growthText(current: number, previous: number): string {
  const g = growth(current, previous);
  if (g === null) return current > 0 ? "new" : "—";
  const pct = Math.round(g * 100);
  return pct > 0 ? `+${pct}%` : pct < 0 ? `−${-pct}%` : "±0%";
}

/** Where the month ends at this month's pace so far. */
export function forecastMonth(monthToDate: number, elapsedDays: number, monthDays: number): number {
  if (elapsedDays <= 0) return monthToDate;
  return (monthToDate / elapsedDays) * monthDays;
}

/** One row of "where the money goes": now, before, and the change. */
export interface CostShift {
  key: string;
  cost: number;
  previous: number;
  delta: number;
  unpriced: boolean;
}

/** The two periods' rows side by side, biggest spend first. A key spent on in
 *  only one of them is still a row: what stopped costing is news too. */
export function costShifts(
  current: readonly { key: string; cost: number; unpriced: boolean }[],
  previous: readonly { key: string; cost: number }[],
): CostShift[] {
  const out = new Map<string, CostShift>();
  for (const r of current) {
    out.set(r.key, { key: r.key, cost: r.cost, previous: 0, delta: r.cost, unpriced: r.unpriced });
  }
  for (const r of previous) {
    const row = out.get(r.key) ?? { key: r.key, cost: 0, previous: 0, delta: 0, unpriced: false };
    row.previous += r.cost;
    row.delta = row.cost - row.previous;
    out.set(r.key, row);
  }
  return [...out.values()].sort((a, b) => b.cost - a.cost || b.previous - a.previous || a.key.localeCompare(b.key));
}

/** The one that grew the most, when anything grew. */
export function topGrower(shifts: readonly CostShift[]): CostShift | null {
  let best: CostShift | null = null;
  for (const s of shifts) if (s.delta > 0 && (!best || s.delta > best.delta)) best = s;
  return best;
}

/** The status a failure says the provider refused the credential with, or
 *  null when the failure is about something else. */
export function refusal(error: string | null | undefined): "401" | "403" | null {
  // A rate limit is said with a 403 too, and passes by itself.
  if (!error || /rate limit/i.test(error)) return null;
  if (/\b401\b|unauthori[sz]ed|bad credentials|token (?:has )?(?:expired|been revoked)|invalid token/i.test(error)) return "401";
  if (/\b403\b|forbidden|resource not accessible/i.test(error)) return "403";
  return null;
}

/** A connection a provider stopped accepting: what it reads, and since when. */
export interface BrokenConnection {
  /** The connection's id or credential reference: what to fix. */
  key: string;
  provider: string;
  status: "401" | "403";
  /** The newest failure, as the provider said it. */
  error: string;
  repos: string[];
  projectIds: string[];
  since: string;
}

interface RunLike {
  task_type: string;
  state: string;
  payload: Record<string, unknown>;
  last_error?: string | null;
  created_at: string;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Connections whose LAST attempt at something was refused. A repository that
 *  failed once and synced since is fine: only the newest run per repository
 *  counts. Runs come newest first, as `taskRuns` lists them. */
export function brokenConnections(runs: readonly RunLike[]): BrokenConnection[] {
  const seen = new Set<string>();
  const out = new Map<string, BrokenConnection>();
  for (const r of runs) {
    const p = r.payload ?? {};
    const repo = text(p.repo_full_path);
    const connection = text(p.connection_id) ?? text(p.secret_ref);
    if (!repo || !connection) continue;
    const subject = `${r.task_type}|${connection}|${repo}|${text(p.project_id) ?? ""}`;
    if (seen.has(subject)) continue;
    seen.add(subject);
    if (r.state !== "failed") continue;
    const status = refusal(r.last_error);
    if (!status) continue;
    const row = out.get(connection) ?? {
      key: connection,
      provider: text(p.provider) ?? "git",
      status,
      error: (r.last_error ?? "").trim(),
      repos: [],
      projectIds: [],
      since: r.created_at,
    };
    if (!row.repos.includes(repo)) row.repos.push(repo);
    const project = text(p.project_id);
    if (project && !row.projectIds.includes(project)) row.projectIds.push(project);
    if (r.created_at < row.since) row.since = r.created_at;
    out.set(connection, row);
  }
  return [...out.values()];
}

/** Failed runs that are not a refused connection: counted, never listed. */
export function otherFailures(runs: readonly RunLike[]): number {
  return runs.filter((r) => r.state === "failed" && !refusal(r.last_error)).length;
}

interface PullLike {
  project_id: string | null;
  waiting: string;
  draft: boolean;
  waiting_on: { login: string; display_name: string | null }[];
  days_open: number | null;
  days_since_update: number | null;
}

/** Open pull requests waiting on someone for `days` or more without a move.
 *  A draft waits on nobody yet. */
export function stuckPulls<T extends PullLike>(pulls: readonly T[], days = STUCK_DAYS): T[] {
  return pulls.filter((p) => !p.draft && p.waiting !== "draft" && (p.days_since_update ?? p.days_open ?? 0) >= days);
}

/** Who the stuck pull requests wait on, longest queue first. One nobody was
 *  asked to review waits on "nobody", said once. */
export function waitingOnPeople(stuck: readonly PullLike[]): { who: string; count: number; oldest: number }[] {
  const out = new Map<string, { who: string; count: number; oldest: number }>();
  const add = (who: string, days: number) => {
    const row = out.get(who) ?? { who, count: 0, oldest: 0 };
    row.count += 1;
    row.oldest = Math.max(row.oldest, days);
    out.set(who, row);
  };
  for (const p of stuck) {
    const days = p.days_since_update ?? p.days_open ?? 0;
    if (p.waiting_on.length === 0) add("Nobody asked to review", days);
    for (const person of p.waiting_on) add(person.display_name || person.login, days);
  }
  return [...out.values()].sort((a, b) => b.count - a.count || b.oldest - a.oldest || a.who.localeCompare(b.who));
}

/** The middle value; null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Whole days since `at`; null when it is unknown. */
export function daysSince(at: string | null | undefined, now: Date = new Date()): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** One project, as the workspace table shows it. */
export interface ProjectHealth {
  row: RollupRow;
  spend: number | null;
  previous: number | null;
  stuck: number;
  quietDays: number | null;
  broken: boolean;
  reason: string;
  score: number;
}

/** One workspace with its projects, worst first. */
export interface WorkspaceHealth {
  row: RollupRow;
  projects: ProjectHealth[];
  spend: number | null;
  previous: number | null;
  specsFailing: number;
  stuck: number;
  /** The most recently active project's quiet days: how long the whole
   *  workspace has not moved. */
  quietDays: number | null;
  reason: string;
  score: number;
}

export interface HealthInputs {
  /** Spend by project id over the two periods; null when costs are not readable. */
  spend: ReadonlyMap<string, number> | null;
  previous: ReadonlyMap<string, number> | null;
  /** Stuck pull requests by project id. */
  stuck: ReadonlyMap<string, number>;
  /** Projects a refused connection reads for. */
  broken: ReadonlySet<string>;
  now?: Date;
}

function projectHealth(r: RollupRow, h: HealthInputs): ProjectHealth {
  const spend = h.spend ? (h.spend.get(r.id) ?? 0) : null;
  const previous = h.previous ? (h.previous.get(r.id) ?? 0) : null;
  const stuck = h.stuck.get(r.id) ?? 0;
  const quietDays = daysSince(r.last_at, h.now);
  const broken = h.broken.has(r.id);
  const failing = r.specs_failing ?? 0;
  const g = spend !== null && previous !== null ? growth(spend, previous) : null;
  const grows = g !== null && g >= GROWTH_ALERT;
  const quiet = quietDays !== null && quietDays >= QUIET_DAYS;
  const reasons: string[] = [];
  if (broken) reasons.push("its repository connection is refused");
  if (failing) reasons.push(`${failing} ${failing === 1 ? "spec fails" : "specs fail"}`);
  if (stuck) reasons.push(`${stuck} pull ${stuck === 1 ? "request waits" : "requests wait"} over ${STUCK_DAYS} days`);
  if (grows && spend !== null && previous !== null) reasons.push(`spend ${growthText(spend, previous)}`);
  if (quiet) reasons.push(`quiet for ${quietDays} days`);
  return {
    row: r,
    spend,
    previous,
    stuck,
    quietDays,
    broken,
    reason: reasons.join(" · "),
    score: (broken ? 10 : 0) + failing * 3 + (r.open_findings ?? 0) + stuck * 2 + (grows ? 2 : 0) + (quiet ? 1 : 0),
  };
}

const sumKnown = (vs: (number | null)[]) =>
  vs.some((v) => v !== null) ? vs.reduce<number>((a, v) => a + (v ?? 0), 0) : null;

/** The organization by workspace, the one in most trouble first; inside it,
 *  its projects the same way. */
export function workspaceHealth(rows: readonly RollupRow[], h: HealthInputs): WorkspaceHealth[] {
  return rows
    .filter((r) => r.kind === "workspace")
    .map((ws) => {
      const projects = rows
        .filter((r) => r.kind === "project" && r.parent_id === ws.id)
        .map((r) => projectHealth(r, h))
        .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
      const troubled = projects.filter((p) => p.reason);
      const quiet = projects.map((p) => p.quietDays).filter((d): d is number => d !== null);
      const reason =
        troubled.length === 0
          ? ""
          : `${troubled[0].row.name}: ${troubled[0].reason}` +
            (troubled.length > 1 ? ` · ${troubled.length - 1} more ${troubled.length === 2 ? "project" : "projects"}` : "");
      return {
        row: ws,
        projects,
        spend: sumKnown(projects.map((p) => p.spend)),
        previous: sumKnown(projects.map((p) => p.previous)),
        specsFailing: projects.reduce((a, p) => a + (p.row.specs_failing ?? 0), 0),
        stuck: projects.reduce((a, p) => a + p.stuck, 0),
        quietDays: quiet.length ? Math.min(...quiet) : null,
        reason,
        score: projects.reduce((a, p) => a + p.score, 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
}

export type NeedTarget = "connectors" | "costs" | "projects" | "gears" | "tasks";

/** One thing that waits on the organization's leader. */
export interface NeedItem {
  kind: "connection" | "spend" | "pulls" | "components" | "runs";
  tone: "danger" | "warn";
  title: string;
  detail: string;
  target: NeedTarget;
}

export interface NeedInputs {
  broken: readonly BrokenConnection[];
  /** Project names by id, to say what a broken connection stops. */
  projectNames: ReadonlyMap<string, string>;
  spend: { current: number; previous: number; forecast: number; grower: string | null; money: (n: number) => string } | null;
  stuck: number;
  waitingOn: number;
  undecided: number;
  otherFailures: number;
}

/** "N things need you": refused connections first, then money, then stuck
 *  work and open decisions. Each says what is wrong and where it is fixed. */
export function needsYou(n: NeedInputs): NeedItem[] {
  const out: NeedItem[] = [];
  for (const b of n.broken) {
    const names = b.projectIds.map((id) => n.projectNames.get(id)).filter((x): x is string => !!x);
    const affected = names.length
      ? `${names.length} ${names.length === 1 ? "project" : "projects"} cannot sync: ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}`
      : `${b.repos.length} ${b.repos.length === 1 ? "repository" : "repositories"} cannot sync`;
    out.push({
      kind: "connection",
      tone: "danger",
      title: `A ${b.provider} connection is refused (${b.status})`,
      detail: affected,
      target: "connectors",
    });
  }
  if (n.spend) {
    const g = growth(n.spend.current, n.spend.previous);
    if (g !== null && g >= GROWTH_ALERT) {
      out.push({
        kind: "spend",
        tone: "warn",
        title: `Spend ${growthText(n.spend.current, n.spend.previous)} against the same days last month`,
        detail:
          `${n.spend.money(n.spend.current)} in 30 days; the month ends near ${n.spend.money(n.spend.forecast)}` +
          (n.spend.grower ? `. Grows most: ${n.spend.grower}` : ""),
        target: "costs",
      });
    }
  }
  if (n.stuck > 0) {
    out.push({
      kind: "pulls",
      tone: "warn",
      title: `${n.stuck} pull ${n.stuck === 1 ? "request waits" : "requests wait"} over ${STUCK_DAYS} days`,
      detail: `on ${n.waitingOn} ${n.waitingOn === 1 ? "person" : "people"}`,
      target: "projects",
    });
  }
  if (n.undecided > 0) {
    out.push({
      kind: "components",
      tone: "warn",
      title: `${n.undecided} ${n.undecided === 1 ? "component waits" : "components wait"} for a decision`,
      detail: "make it a gear of the organization, or leave it in its project",
      target: "gears",
    });
  }
  if (n.otherFailures > 0) {
    out.push({
      kind: "runs",
      tone: "warn",
      title: `${n.otherFailures} background ${n.otherFailures === 1 ? "run" : "runs"} failed`,
      detail: "not a refused connection; the runs list says what",
      target: "tasks",
    });
  }
  return out;
}
