/* The organization's overview, for the people who lead it: opened by clicking
 * the organization in the path. It answers what is on fire and where (by
 * workspace, then project), whether money grows and who grows it, whether
 * work moves, and what waits on the organization's decision. Everything is
 * read from what the portal already serves -- the rollups (one request for
 * every workspace and project), the costs, the open pull requests, the
 * members, the component registry and the background runs -- and every line
 * opens the place it comes from. No run log is shown here: a refused
 * connection is said as one, the rest is a count. Rules:
 * `org-dashboard-model.ts`. */

import { LevelBadge, OrgMark } from "./level-marks";
import { useEffect, useMemo, useState } from "react";

import { api, type CostGroup, type CostReport, type OpenPullRequest, type RollupRow, type TaskRun } from "./api";
import { GROUPS, money, rowLabel } from "./costs";
import { DataTable } from "./data-table";
import { errText } from "./format";
import {
  STUCK_DAYS,
  brokenConnections,
  costShifts,
  forecastMonth,
  growthText,
  median,
  needsYou,
  orgTotals,
  otherFailures,
  registrySummary,
  rowsOfOrg,
  spendWindows,
  stuckPulls,
  topGrower,
  waitingOnPeople,
  workspaceHealth,
  type ProjectHealth,
  type WorkspaceHealth,
} from "./org-dashboard-model";

type Target = "projects" | "people" | "gears" | "platform" | "tasks" | "connectors" | "costs";

/** The organization's spend, read once per period. */
interface Spend {
  current: CostReport;
  previous: CostReport;
  month: CostReport;
  /** The last 30 days by who paid, people's own keys included. */
  payers: CostReport;
}

export function OrgDashboard({
  token,
  org,
  workspaceIds,
  onOpen,
  onOpenProject,
}: {
  token: string;
  org: { id: string; name: string };
  /** The organization's workspaces: which rollup rows are its own. */
  workspaceIds: readonly string[];
  onOpen: (target: Target) => void;
  onOpenProject: (workspaceId: string, projectId: string, name: string) => void;
}) {
  const [rows, setRows] = useState<RollupRow[] | null>(null);
  const [rowsErr, setRowsErr] = useState<string | null>(null);
  const [members, setMembers] = useState<number | null>(null);
  const [registry, setRegistry] = useState<string[] | null>(null);
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [pulls, setPulls] = useState<OpenPullRequest[] | null>(null);
  /** `null` while loading or unreadable; `false` when the caller may not see costs. */
  const [spend, setSpend] = useState<Spend | null | false>(null);
  const [group, setGroup] = useState<CostGroup>("project");
  const [personal, setPersonal] = useState(false);
  const [money2, setMoney2] = useState<{ current: CostReport; previous: CostReport } | null>(null);
  const wsKey = workspaceIds.join(",");
  const windows = useMemo(() => spendWindows(), []);

  useEffect(() => {
    let live = true;
    const own = new Set(workspaceIds);
    api
      .rollups(token)
      .then((p) => live && setRows(rowsOfOrg(p.items ?? [], own)))
      .catch((e) => live && setRowsErr(errText(e)));
    api
      .orgMembers(token, org.id)
      .then((m) => live && setMembers(m.filter((x) => x.status === "active").length))
      .catch(() => live && setMembers(null));
    api
      .componentRegistry(token)
      .then((r) => live && setRegistry(r.items.map((e) => e.state)))
      .catch(() => live && setRegistry(null));
    // Every state, not only failures: a repository that failed and synced
    // since is not broken, and only its newest run says so.
    api
      .taskRuns(token, { limit: 200 })
      .then((r) => live && setRuns(r.items))
      .catch(() => live && setRuns(null));
    Promise.all(
      workspaceIds.map((id) =>
        api
          .workspacePullRequests(token, id)
          .then((r) => r.items)
          .catch(() => [] as OpenPullRequest[]),
      ),
    ).then((pages) => live && setPulls(pages.flat()));
    api
      .prices(token, org.id)
      .then((p) => {
        if (!p.may_view_costs) {
          if (live) setSpend(false);
          return;
        }
        const read = (range: { from: string; to: string }, group_by: CostGroup, include_personal: boolean) =>
          api.costs(token, org.id, { ...range, group_by, include_personal });
        return Promise.all([
          read(windows.current, "project", false),
          read(windows.previous, "project", false),
          read(windows.month, "project", false),
          read(windows.current, "payer", true),
        ]).then(([current, previous, month, payers]) => live && setSpend({ current, previous, month, payers }));
      })
      .catch(() => live && setSpend(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, org.id, wsKey]);

  // "Where the money goes", by what the reader picked.
  useEffect(() => {
    if (!spend) return;
    let live = true;
    setMoney2(null);
    const read = (range: { from: string; to: string }) =>
      api.costs(token, org.id, { ...range, group_by: group, include_personal: personal });
    Promise.all([read(windows.current), read(windows.previous)])
      .then(([current, previous]) => live && setMoney2({ current, previous }))
      .catch(() => live && setMoney2(null));
    return () => {
      live = false;
    };
  }, [token, org.id, spend, group, personal, windows]);

  const totals = useMemo(() => (rows ? orgTotals(rows) : null), [rows]);
  const reg = registry ? registrySummary(registry) : null;
  const names = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r.name])), [rows]);
  const currency = spend ? spend.current.currency : "USD";
  const cash = (n: number) => money(n, currency);

  const broken = useMemo(() => (runs ? brokenConnections(runs) : []), [runs]);
  const stuck = useMemo(() => (pulls ? stuckPulls(pulls) : []), [pulls]);
  const queues = useMemo(() => waitingOnPeople(stuck), [stuck]);
  const people = queues.filter((q) => q.who !== "Nobody asked to review").length;

  const byProject = (r: CostReport) => new Map(r.rows.map((x) => [x.key, x.cost]));
  const health = useMemo(() => {
    if (!rows) return null;
    const stuckBy = new Map<string, number>();
    for (const p of stuck) if (p.project_id) stuckBy.set(p.project_id, (stuckBy.get(p.project_id) ?? 0) + 1);
    return workspaceHealth(rows, {
      spend: spend ? byProject(spend.current) : null,
      previous: spend ? byProject(spend.previous) : null,
      stuck: stuckBy,
      broken: new Set(broken.flatMap((b) => b.projectIds)),
    });
  }, [rows, spend, stuck, broken]);

  const forecast = spend ? forecastMonth(spend.month.total, windows.elapsedDays, windows.monthDays) : 0;
  const ownKeys = spend ? (spend.payers.rows.find((r) => r.key === "personal")?.cost ?? 0) : 0;
  const projectShifts = spend ? costShifts(spend.current.rows, spend.previous.rows) : [];
  const grower = topGrower(projectShifts);
  const needs = needsYou({
    broken,
    projectNames: names,
    spend: spend
      ? {
          current: spend.current.total,
          previous: spend.previous.total,
          forecast,
          grower: grower ? (names.get(grower.key) ?? (grower.key || null)) : null,
          money: cash,
        }
      : null,
    stuck: stuck.length,
    waitingOn: people,
    undecided: reg?.undecided ?? 0,
    otherFailures: runs ? otherFailures(runs) : 0,
  });

  const openPulls = (pulls ?? []).filter((p) => !p.draft);
  const medianWait = median(openPulls.map((p) => p.days_open).filter((d): d is number => d !== null));
  const merged = rows
    ? rows.filter((r) => r.kind === "project").reduce((a, r) => a + (r.pulls_merged ?? 0), 0)
    : null;
  const activityDays = rows?.find((r) => r.activity_days)?.activity_days ?? 30;
  const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));
  const quiet = (d: number | null) => (d === null ? "—" : d === 0 ? "today" : `${d} d`);

  const label = (key: string, report: CostReport) => {
    if (group === "project" && names.has(key)) return names.get(key)!;
    const row = report.rows.find((r) => r.key === key);
    return row ? rowLabel(row, group) : key || "—";
  };

  const projectTable = (ws: WorkspaceHealth) => (
    <table className="org-sub">
      <thead>
        <tr>
          <th>Project</th>
          <th className="num">Spend, 30 d</th>
          <th className="num">Δ</th>
          <th className="num">Failing specs</th>
          <th className="num">PRs &gt; {STUCK_DAYS} d</th>
          <th className="num">Quiet</th>
        </tr>
      </thead>
      <tbody>
        {ws.projects.map((p: ProjectHealth) => (
          <tr key={p.row.id}>
            <td>
              <button
                type="button"
                className="ghost org-dash-link"
                onClick={() => p.row.parent_id && onOpenProject(p.row.parent_id, p.row.id, p.row.name)}
              >
                {p.row.name}
              </button>
              <div className="sub">{p.reason || "nothing wrong"}</div>
            </td>
            <td className="num">{p.spend === null ? "—" : cash(p.spend)}</td>
            <td className="num">{p.spend === null || p.previous === null ? "—" : growthText(p.spend, p.previous)}</td>
            <td className="num">{n(p.row.specs_failing)}</td>
            <td className="num">{p.stuck || "—"}</td>
            <td className="num">{quiet(p.quietDays)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="dash org-dash" data-org-dashboard>
      <style>{ORG_DASH_CSS}</style>
      <div className="dash-context">
        <LevelBadge level="organization" />
        <OrgMark token={token} orgId={org.id} name={org.name} />
        <h1>{org.name}</h1>
        <span className="sub">What needs you, where the problems are, what it costs and whether work moves.</span>
      </div>

      <section className={`card org-needs${needs.length ? " has-needs" : ""}`} data-org-needs>
        <div className="card-head">
          <h3>
            {rows === null || runs === null
              ? "Looking for what needs you…"
              : needs.length === 0
                ? "Nothing needs you"
                : `${needs.length} ${needs.length === 1 ? "thing needs" : "things need"} you`}
          </h3>
        </div>
        {needs.length > 0 && (
          <ul className="org-dash-list">
            {needs.map((item) => (
              <li key={`${item.kind}|${item.title}`} className={`org-need tone-${item.tone}`} data-need={item.kind}>
                <div>
                  <strong>{item.title}</strong>
                  <span className="sub">{item.detail}</span>
                </div>
                <button type="button" className="ghost" onClick={() => onOpen(item.target)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="dash-stats org-trends">
        <button className="stat" onClick={() => onOpen("costs")} data-trend="spend">
          <span className="stat-k">Spend, 30 days</span>
          <span className="stat-n">{spend ? cash(spend.current.total) : "—"}</span>
          <span className="stat-sub">
            {spend === false
              ? "costs are not yours to see"
              : spend
                ? `${growthText(spend.current.total, spend.previous.total)} vs the same days last month · month ends near ${cash(forecast)}` +
                  (ownKeys > 0 ? ` · ${cash(ownKeys)} more on people's own keys` : "")
                : ""}
          </span>
        </button>
        <button className="stat" onClick={() => onOpen("projects")} data-trend="delivery">
          <span className="stat-k">Delivery</span>
          <span className="stat-n">{merged === null ? "…" : merged}</span>
          <span className="stat-sub">
            {`merged in ${activityDays} days · ${n(totals?.pullsOpen)} open` +
              (medianWait !== null ? ` · median wait ${Math.round(medianWait)} d` : "")}
          </span>
        </button>
        <button className={`stat${totals?.specsFailing ? " tone-danger" : ""}`} onClick={() => onOpen("projects")} data-trend="specs">
          <span className="stat-k">Spec health</span>
          <span className="stat-n">{totals ? n(totals.specsFailing) : "…"}</span>
          <span className="stat-sub">
            {totals ? `failing · ${n(totals.openFindings)} open findings · ${n(totals.specs)} specs` : ""}
          </span>
        </button>
        <button className="stat" onClick={() => onOpen("people")} data-trend="people">
          <span className="stat-k">People</span>
          <span className="stat-n">{members === null ? "—" : members}</span>
          <span className="stat-sub">
            {"active members" +
              (spend && members ? ` · ${cash(spend.current.total / members)} per person` : "")}
          </span>
        </button>
      </div>

      {rowsErr && <p className="gcat-err">{rowsErr}</p>}

      <DataTable<WorkspaceHealth>
        list="org-workspaces"
        urlPrefix="ows."
        title="Workspaces"
        rows={health}
        rowKey={(w) => w.row.id}
        rowLabel={(w) => w.row.name}
        expand={projectTable}
        empty={{ title: "No workspace in this organization yet." }}
        columns={[
          {
            id: "name",
            header: "Workspace",
            cell: (w) => (
              <>
                <strong>{w.row.name}</strong>
                <div className="sub">{w.reason || `${w.projects.length} projects, nothing wrong`}</div>
              </>
            ),
          },
          {
            id: "spend",
            header: "Spend, 30 d",
            num: true,
            cell: (w) => (w.spend === null ? "—" : cash(w.spend)),
            compare: (a, b) => (a.spend ?? 0) - (b.spend ?? 0),
          },
          {
            id: "delta",
            header: "Δ",
            num: true,
            cell: (w) => (w.spend === null || w.previous === null ? "—" : growthText(w.spend, w.previous)),
          },
          {
            id: "failing",
            header: "Failing specs",
            num: true,
            cell: (w) => w.specsFailing || "—",
            compare: (a, b) => a.specsFailing - b.specsFailing,
          },
          {
            id: "stuck",
            header: `PRs > ${STUCK_DAYS} d`,
            num: true,
            cell: (w) => w.stuck || "—",
            compare: (a, b) => a.stuck - b.stuck,
          },
          {
            id: "quiet",
            header: "Quiet",
            num: true,
            cell: (w) => quiet(w.quietDays),
            compare: (a, b) => (a.quietDays ?? -1) - (b.quietDays ?? -1),
          },
        ]}
      />

      <div className="dash-grid">
        <div className="dash-col">
          <section className="card" data-org-money>
            <div className="card-head">
              <h3>Where the money goes</h3>
              <button className="ghost" onClick={() => onOpen("costs")}>Costs</button>
            </div>
            {spend === false ? (
              <p className="sub">Costs are shown to those who may see them.</p>
            ) : (
              <>
                <div className="org-money-controls">
                  <label>
                    By
                    <select value={group} onChange={(e) => setGroup(e.target.value as CostGroup)} aria-label="Group by">
                      {GROUPS.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label title="What people spent on keys in their own profiles or personal connections">
                    <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />
                    Include people&apos;s own keys
                  </label>
                </div>
                {money2 === null ? (
                  <p className="sub">Loading…</p>
                ) : money2.current.rows.length === 0 && money2.previous.rows.length === 0 ? (
                  <p className="sub">Nothing spent in the last 60 days.</p>
                ) : (
                  <table className="org-money">
                    <thead>
                      <tr>
                        <th>{GROUPS.find((g) => g.id === group)?.label}</th>
                        <th className="num">30 days</th>
                        <th className="num">Before</th>
                        <th className="num">Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {costShifts(money2.current.rows, money2.previous.rows)
                        .slice(0, 8)
                        .map((s) => (
                          <tr key={s.key}>
                            <td>
                              {label(s.key, s.cost ? money2.current : money2.previous)}
                              {s.unpriced && <span className="sub"> · unpriced</span>}
                            </td>
                            <td className="num">{cash(s.cost)}</td>
                            <td className="num">{cash(s.previous)}</td>
                            <td className={`num${s.delta > 0 && s.previous > 0 && s.delta / s.previous >= 0.2 ? " grows" : ""}`}>
                              {growthText(s.cost, s.previous)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
                {money2 && money2.current.unpriced.length > 0 && (
                  <p className="sub org-unpriced">
                    No price for {money2.current.unpriced.join(", ")}: their calls count as nothing until the price list
                    names them.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
        <div className="dash-col">
          <section className="card" data-org-waiting>
            <div className="card-head">
              <h3>Waiting on people</h3>
              <button className="ghost" onClick={() => onOpen("projects")}>All projects</button>
            </div>
            {pulls === null ? (
              <p className="sub">Loading…</p>
            ) : queues.length === 0 ? (
              <p className="sub">No pull request has waited over {STUCK_DAYS} days.</p>
            ) : (
              <ul className="org-dash-list">
                {queues.slice(0, 6).map((q) => (
                  <li key={q.who}>
                    <strong>{q.who}</strong>
                    <span className="sub">
                      {q.count} pull {q.count === 1 ? "request" : "requests"} · the oldest {q.oldest} days without a move
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card" data-org-decisions>
            <div className="card-head">
              <h3>Decisions for the organization</h3>
            </div>
            <ul className="org-dash-list">
              <li>
                <button type="button" className="ghost org-dash-link" onClick={() => onOpen("gears")}>
                  {reg ? `${reg.undecided} ${reg.undecided === 1 ? "component" : "components"} to decide` : "Components"}
                </button>
                <span className="sub">
                  {reg
                    ? `${reg.candidates} could become gears · ${reg.registered} registered · ${reg.published} given to the platform`
                    : "registry not readable"}
                </span>
              </li>
              <li>
                <button type="button" className="ghost org-dash-link" onClick={() => onOpen("platform")}>
                  Platform components
                </button>
                <span className="sub">the common set every organization builds on, one level up</span>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

const ORG_DASH_CSS = `
.org-dash .dash-context h1 { font-size:20px; font-weight:600; margin:0; }
.org-dash .stat.tone-danger .stat-n { color:var(--destructive); }
.org-dash .stat.tone-warn .stat-n { color:var(--warning); }
.org-dash .card-head h3 { margin:0; font-size:14px; }
.org-dash .org-dash-list { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.org-dash .org-dash-list li { display:flex; flex-direction:column; gap:2px; min-width:0; }
.org-dash .sub { color:var(--muted-foreground); font-size:12px; overflow-wrap:anywhere; }
.org-dash .org-dash-link { padding:0; font-weight:600; text-align:left; justify-content:flex-start; }
.org-dash .org-needs { margin-bottom:12px; }
.org-dash .org-needs.has-needs { border-color:var(--warning); }
.org-dash .org-need { flex-direction:row !important; align-items:center; justify-content:space-between; gap:12px;
  padding:8px 10px; border-radius:8px; background:var(--warning-soft); }
.org-dash .org-need.tone-danger { background:var(--destructive-soft, var(--warning-soft)); }
.org-dash .org-need > div { display:flex; flex-direction:column; gap:2px; min-width:0; }
.org-dash .org-trends .stat-sub { white-space:normal; }
.org-dash .org-trends { margin-bottom:16px; }
.org-dash .org-money-controls { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:8px; }
.org-dash .org-money-controls label { display:inline-flex; gap:6px; align-items:center; font-size:12px; }
.org-dash table.org-money, .org-dash table.org-sub { width:100%; border-collapse:collapse; font-size:13px; }
.org-dash table.org-money th, .org-dash table.org-money td,
.org-dash table.org-sub th, .org-dash table.org-sub td { text-align:left; padding:5px 6px; border-bottom:1px solid var(--border); }
.org-dash table.org-money .num, .org-dash table.org-sub .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.org-dash table.org-money td.grows { color:var(--warning); font-weight:600; }
.org-dash .org-unpriced { margin-top:8px; }
`;
