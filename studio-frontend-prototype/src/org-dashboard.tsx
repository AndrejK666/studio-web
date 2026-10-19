/* The organization's overview, for the people who lead it: opened by clicking
 * the organization in the path. It answers what is on fire and where (by
 * workspace, then project), whether money grows and who grows it, whether
 * work moves, and what waits on the organization's decision.
 *
 * One request: `GET /studio-organizations/v1/overview` composes it on the
 * server, rules and all. No run log is shown here: a refused connection is
 * said as one, the rest is a count. Words: `org-dashboard-model.ts`. */

import { LevelBadge, OrgMark } from "./level-marks";
import { useEffect, useState } from "react";

import { api, type CostGroup, type OrgOverview, type OrgProjectHealth, type OrgWorkspace } from "./api";
import { GROUPS, money } from "./costs";
import { DataTable } from "./data-table";
import { errText } from "./format";
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

type Target = "projects" | "people" | "gears" | "platform" | "tasks" | "connectors" | "costs";

export function OrgDashboard({
  token,
  org,
  onOpen,
  onOpenProject,
}: {
  token: string;
  org: { id: string; name: string };
  onOpen: (target: Target) => void;
  onOpenProject: (workspaceId: string, projectId: string, name: string) => void;
}) {
  const [o, setO] = useState<OrgOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<CostGroup>("project");
  const [personal, setPersonal] = useState(false);

  useEffect(() => {
    let live = true;
    setO(null);
    setError(null);
    api
      .orgOverview(token, org.id)
      .then((r) => live && setO(r))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token, org.id]);

  const cash = (n: number) => money(n, o?.spend?.currency || "USD");
  const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));
  const stuckDays = o?.stuck_days ?? 7;
  const spend = o?.spend ?? null;
  const breakdown = o ? moneyFor(o, group, personal) : null;
  const queues = o?.waiting_on ?? null;
  const people = o?.people;

  const projectTable = (ws: OrgWorkspace) => (
    <table className="org-sub">
      <thead>
        <tr>
          <th>Project</th>
          <th className="num">Spend, 30 d</th>
          <th className="num">Δ</th>
          <th className="num">Failing specs</th>
          <th className="num">PRs &gt; {stuckDays} d</th>
          <th className="num">Quiet</th>
        </tr>
      </thead>
      <tbody>
        {ws.projects.map((p: OrgProjectHealth) => (
          <tr key={p.id}>
            <td>
              <button type="button" className="ghost org-dash-link" onClick={() => onOpenProject(ws.id, p.id, p.name)}>
                {p.name}
              </button>
              <div className="sub">{reasonLine(p.reasons, stuckDays) || "nothing wrong"}</div>
            </td>
            <td className="num">{p.spend === null ? "—" : cash(p.spend)}</td>
            <td className="num">{p.spend === null || p.previous === null ? "—" : growthText(p.spend, p.previous)}</td>
            <td className="num">{n(p.specs_failing)}</td>
            <td className="num">{p.stuck || "—"}</td>
            <td className="num">{quietText(p.quiet_days)}</td>
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

      {error && <p className="gcat-err">{error}</p>}

      <section className={`card org-needs${o?.needs.length ? " has-needs" : ""}`} data-org-needs>
        <div className="card-head">
          <h3>{o ? needsHeadline(o.needs.length) : error ? "Not readable" : "Looking for what needs you…"}</h3>
        </div>
        {o && o.needs.length > 0 && (
          <ul className="org-dash-list">
            {o.needs.map((need, i) => {
              const t = needText(need, stuckDays, cash);
              return (
                <li key={`${need.kind}|${i}`} className={`org-need tone-${need.tone}`} data-need={need.kind}>
                  <div>
                    <strong>{t.title}</strong>
                    <span className="sub">{t.detail}</span>
                  </div>
                  <button type="button" className="ghost" onClick={() => onOpen(t.target)}>
                    Open
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="dash-stats org-trends">
        <button className="stat" onClick={() => onOpen("costs")} data-trend="spend">
          <span className="stat-k">Spend, 30 days</span>
          <span className="stat-n">{spend ? cash(spend.current) : o ? "—" : "…"}</span>
          <span className="stat-sub">
            {o?.costs === "hidden"
              ? "costs are not yours to see"
              : o?.costs === "unreadable"
                ? "costs could not be read"
                : spend
                  ? `${growthText(spend.current, spend.previous)} vs the same days last month · month ends near ${cash(spend.forecast)}` +
                    (spend.own_keys > 0 ? ` · ${cash(spend.own_keys)} more on people's own keys` : "")
                  : ""}
          </span>
        </button>
        <button className="stat" onClick={() => onOpen("projects")} data-trend="delivery">
          <span className="stat-k">Delivery</span>
          <span className="stat-n">{o ? n(o.delivery.merged) : "…"}</span>
          <span className="stat-sub">
            {o
              ? `merged in ${o.delivery.window_days} days · ${n(o.delivery.open)} open` +
                (o.delivery.median_wait_days !== null ? ` · median wait ${Math.round(o.delivery.median_wait_days)} d` : "")
              : ""}
          </span>
        </button>
        <button className={`stat${o?.specs.failing ? " tone-danger" : ""}`} onClick={() => onOpen("projects")} data-trend="specs">
          <span className="stat-k">Spec health</span>
          <span className="stat-n">{o ? n(o.specs.failing) : "…"}</span>
          <span className="stat-sub">
            {o ? `failing · ${n(o.specs.open_findings)} open findings · ${n(o.specs.specs)} specs` : ""}
          </span>
        </button>
        <button className="stat" onClick={() => onOpen("people")} data-trend="people">
          <span className="stat-k">People</span>
          <span className="stat-n">{o ? n(people?.active) : "…"}</span>
          <span className="stat-sub">
            {"active members" +
              (people?.with_spend !== null && people?.with_spend !== undefined
                ? ` · ${people.with_spend} used a model` +
                  (people.per_person !== null ? `, ${cash(people.per_person)} each` : "")
                : "") +
              (people?.idle ? ` · ${people.idle.length} idle` : "")}
          </span>
        </button>
      </div>

      <DataTable<OrgWorkspace>
        list="org-workspaces"
        urlPrefix="ows."
        title="Workspaces"
        rows={o ? o.workspaces : error ? [] : null}
        rowKey={(w) => w.id}
        rowLabel={(w) => w.name}
        expand={projectTable}
        empty={{ title: "No workspace in this organization yet." }}
        columns={[
          {
            id: "name",
            header: "Workspace",
            cell: (w) => (
              <>
                <strong>{w.name}</strong>
                <div className="sub">{workspaceLine(w, stuckDays)}</div>
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
            cell: (w) => w.specs_failing || "—",
            compare: (a, b) => a.specs_failing - b.specs_failing,
          },
          {
            id: "stuck",
            header: `PRs > ${stuckDays} d`,
            num: true,
            cell: (w) => w.stuck || "—",
            compare: (a, b) => a.stuck - b.stuck,
          },
          {
            id: "quiet",
            header: "Quiet",
            num: true,
            cell: (w) => quietText(w.quiet_days),
            compare: (a, b) => (a.quiet_days ?? -1) - (b.quiet_days ?? -1),
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
            {o === null ? (
              <p className="sub">{error ? "Not readable." : "Loading…"}</p>
            ) : o.costs !== "shown" ? (
              <p className="sub">
                {o.costs === "hidden" ? "Costs are shown to those who may see them." : "Costs could not be read."}
              </p>
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
                {!breakdown || breakdown.rows.length === 0 ? (
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
                      {breakdown.rows.slice(0, 8).map((r) => (
                        <tr key={r.key || "-"}>
                          <td>
                            {moneyLabel(group, r)}
                            {r.unpriced && <span className="sub"> · unpriced</span>}
                          </td>
                          <td className="num">{cash(r.cost)}</td>
                          <td className="num">{cash(r.previous)}</td>
                          <td
                            className={`num${r.previous > 0 && (r.cost - r.previous) / r.previous >= o.growth_alert ? " grows" : ""}`}
                          >
                            {growthText(r.cost, r.previous)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {spend && spend.unattributed > 0 && (
                  <p className="sub org-unpriced">
                    {cash(spend.unattributed)} was spent through sign-ins that are no active member&apos;s: it is
                    counted, under &ldquo;Unattributed&rdquo;.
                  </p>
                )}
                {spend && spend.unpriced.length > 0 && (
                  <p className="sub org-unpriced">
                    No price for {spend.unpriced.join(", ")}: their calls count as nothing until the price list names
                    them.
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
            {o === null ? (
              <p className="sub">{error ? "Not readable." : "Loading…"}</p>
            ) : queues === null ? (
              <p className="sub">Pull requests could not be read.</p>
            ) : queues.length === 0 ? (
              <p className="sub">No pull request has waited over {stuckDays} days.</p>
            ) : (
              <ul className="org-dash-list">
                {queues.slice(0, 6).map((q) => (
                  <li key={q.person_id ?? q.who ?? "nobody"}>
                    <strong>{queueLabel(q)}</strong>
                    <span className="sub">
                      {q.count} pull {q.count === 1 ? "request" : "requests"} · the oldest {q.oldest_days} days without a
                      move
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {people?.idle && people.idle.length > 0 && (
              <p className="sub org-idle" data-org-idle>
                Idle for 30 days (no model use, no open pull request):{" "}
                {people.idle
                  .slice(0, 6)
                  .map((p) => p.name ?? `Person ${p.person_id.slice(0, 8)}`)
                  .join(", ")}
                {people.idle.length > 6 ? ` and ${people.idle.length - 6} more` : ""}
              </p>
            )}
          </section>
          <section className="card" data-org-decisions>
            <div className="card-head">
              <h3>Decisions for the organization</h3>
            </div>
            <ul className="org-dash-list">
              <li>
                <button type="button" className="ghost org-dash-link" onClick={() => onOpen("gears")}>
                  {o?.decisions
                    ? `${o.decisions.undecided} ${o.decisions.undecided === 1 ? "component" : "components"} to decide`
                    : "Components"}
                </button>
                <span className="sub">
                  {o?.decisions
                    ? `${o.decisions.candidates} could become gears · ${o.decisions.registered} registered · ${o.decisions.published} given to the platform`
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
.org-dash .org-need.tone-danger { background:var(--destructive-soft); }
.org-dash .org-need > div { display:flex; flex-direction:column; gap:2px; min-width:0; }
.org-dash .org-trends { margin-bottom:16px; }
.org-dash .org-trends .stat-sub { white-space:normal; }
.org-dash .org-money-controls { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:8px; }
.org-dash .org-money-controls label { display:inline-flex; gap:6px; align-items:center; font-size:12px; }
.org-dash table.org-money, .org-dash table.org-sub { width:100%; border-collapse:collapse; font-size:13px; }
.org-dash table.org-money th, .org-dash table.org-money td,
.org-dash table.org-sub th, .org-dash table.org-sub td { text-align:left; padding:5px 6px; border-bottom:1px solid var(--border); }
.org-dash table.org-money .num, .org-dash table.org-sub .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.org-dash table.org-money td.grows { color:var(--warning); font-weight:600; }
.org-dash .org-unpriced, .org-dash .org-idle { margin-top:8px; }
`;
