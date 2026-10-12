/* The organization's dashboard: the level between the platform and the
 * workspaces, opened by clicking the organization in the path. Everything on
 * it is read from what the portal already serves -- the rollups (one
 * request for every workspace and project), the members, the component
 * registry and the background runs -- and every tile opens the place its
 * number comes from. Rules: `org-dashboard-model.ts`. */

import { useEffect, useMemo, useState } from "react";

import { api, type RollupRow, type TaskRun } from "./api";
import { errText, relTime } from "./format";
import {
  attentionLine,
  needsAttention,
  orgTotals,
  recentlyActive,
  registrySummary,
  rowsOfOrg,
} from "./org-dashboard-model";

type Target = "projects" | "people" | "gears" | "platform" | "tasks" | "connectors";

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
  const [failed, setFailed] = useState<TaskRun[] | null>(null);
  const wsKey = workspaceIds.join(",");

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
    api
      .taskRuns(token, { state: "failed", limit: 5 })
      .then((r) => live && setFailed(r.items))
      .catch(() => live && setFailed(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, org.id, wsKey]);

  const totals = useMemo(() => (rows ? orgTotals(rows) : null), [rows]);
  const attention = useMemo(() => (rows ? needsAttention(rows) : []), [rows]);
  const recent = useMemo(() => (rows ? recentlyActive(rows) : []), [rows]);
  const reg = registry ? registrySummary(registry) : null;
  const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));

  const projectRow = (r: RollupRow, line: string) => (
    <li key={r.id}>
      <button
        type="button"
        className="ghost org-dash-link"
        onClick={() => r.parent_id && onOpenProject(r.parent_id, r.id, r.name)}
      >
        {r.name}
      </button>
      <span className="sub">{line}</span>
    </li>
  );

  return (
    <div className="dash org-dash" data-org-dashboard>
      <style>{ORG_DASH_CSS}</style>
      <div className="dash-context">
        <span className="org-dash-level">Organization</span>
        <h1>{org.name}</h1>
        <span className="sub">
          Between the platform and its workspaces: its projects, people and own components.
        </span>
      </div>

      <div className="dash-stats">
        <button className="stat" onClick={() => onOpen("projects")}>
          <span className="stat-k">Workspaces</span>
          <span className="stat-n">{totals ? totals.workspaces : "…"}</span>
          <span className="stat-sub">{totals ? `${totals.projects} projects` : ""}</span>
        </button>
        <button className="stat" onClick={() => onOpen("people")}>
          <span className="stat-k">People</span>
          <span className="stat-n">{members === null ? "—" : members}</span>
          <span className="stat-sub">active members</span>
        </button>
        <button className="stat" onClick={() => onOpen("connectors")}>
          <span className="stat-k">Repositories</span>
          <span className="stat-n">{totals ? n(totals.repos) : "…"}</span>
          <span className="stat-sub">attached to projects</span>
        </button>
        <button className={`stat${totals?.specsFailing ? " danger" : ""}`} onClick={() => onOpen("projects")}>
          <span className="stat-k">Specs</span>
          <span className="stat-n">{totals ? n(totals.specs) : "…"}</span>
          <span className="stat-sub">
            {totals?.specsFailing ? `${totals.specsFailing} failing` : totals?.openFindings ? `${totals.openFindings} open findings` : ""}
          </span>
        </button>
        <button className={`stat${totals?.pullsOpen ? " warn" : ""}`} onClick={() => onOpen("projects")}>
          <span className="stat-k">Open pull requests</span>
          <span className="stat-n">{totals ? n(totals.pullsOpen) : "…"}</span>
          <span className="stat-sub">across projects</span>
        </button>
        <button className={`stat${reg?.undecided ? " warn" : ""}`} onClick={() => onOpen("gears")}>
          <span className="stat-k">Our components</span>
          <span className="stat-n">{reg ? reg.total : "—"}</span>
          <span className="stat-sub">{reg ? `${reg.registered} registered · ${reg.undecided} to decide` : ""}</span>
        </button>
      </div>

      {rowsErr && <p className="gcat-err">{rowsErr}</p>}

      <div className="dash-grid">
        <div className="dash-col">
          <section className="card">
            <div className="card-head">
              <h3>Needs attention</h3>
              <button className="ghost" onClick={() => onOpen("projects")}>All projects</button>
            </div>
            {rows === null ? (
              <p className="sub">Loading…</p>
            ) : attention.length === 0 ? (
              <p className="sub">Nothing failing or waiting: no failing specs, open findings or open pull requests.</p>
            ) : (
              <ul className="org-dash-list">{attention.map((r) => projectRow(r, attentionLine(r)))}</ul>
            )}
          </section>
          <section className="card">
            <div className="card-head">
              <h3>Recently active</h3>
            </div>
            {rows === null ? (
              <p className="sub">Loading…</p>
            ) : recent.length === 0 ? (
              <p className="sub">No activity synced yet.</p>
            ) : (
              <ul className="org-dash-list">
                {recent.map((r) =>
                  projectRow(r, [r.last_event, r.last_subject].filter(Boolean).join(": ") + ` · ${relTime(r.last_at)}`),
                )}
              </ul>
            )}
          </section>
        </div>
        <div className="dash-col">
          <section className="card">
            <div className="card-head">
              <h3>Components</h3>
            </div>
            <ul className="org-dash-list">
              <li>
                <button type="button" className="ghost org-dash-link" onClick={() => onOpen("gears")}>
                  Our components
                </button>
                <span className="sub">
                  {reg
                    ? `${reg.total} in the registry · ${reg.candidates} could become gears · ${reg.published} given to the platform`
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
          <section className="card">
            <div className="card-head">
              <h3>Background work</h3>
              <button className="ghost" onClick={() => onOpen("tasks")}>All runs</button>
            </div>
            {failed === null ? (
              <p className="sub">Not readable.</p>
            ) : failed.length === 0 ? (
              <p className="sub">No failed runs.</p>
            ) : (
              <ul className="org-dash-list">
                {failed.map((t) => (
                  <li key={t.id}>
                    <code>{t.task_type}</code>
                    <span className="sub">{(t.last_error ?? "failed").slice(0, 140)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const ORG_DASH_CSS = `
.org-dash .dash-context h1 { font-size:20px; font-weight:600; margin:0; }
.org-dash .org-dash-level { font:600 11px/1 var(--mono, monospace); letter-spacing:.06em; text-transform:uppercase; padding:4px 8px; border-radius:6px; background:#dcfce7; color:#15803d; }
.org-dash .card-head h3 { margin:0; font-size:14px; }
.org-dash .org-dash-list { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.org-dash .org-dash-list li { display:flex; flex-direction:column; gap:2px; min-width:0; }
.org-dash .org-dash-list .sub { color:var(--muted-foreground); font-size:12px; overflow-wrap:anywhere; }
.org-dash .org-dash-link { padding:0; font-weight:600; text-align:left; justify-content:flex-start; }
`;
