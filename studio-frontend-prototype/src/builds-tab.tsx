// A project's Builds tab (ADR-0045, phase 1): the CI runs of its
// repositories, as the artifact sync reads them. The portal does not build;
// this is what was built, where and how it went.

import { useEffect, useMemo, useState } from "react";

import { api } from "./api";
import {
  type BuildRun,
  buildDuration,
  buildsHeadline,
  buildsOf,
  ciReadFailures,
  statusTone,
  workflowsOf,
} from "./builds";
import { errText } from "./format";

/** At most this many runs are read: the sync keeps the newest few hundred
 *  per repository. */
const LIMIT = 200;

export function ProjectBuilds({ token, projectId }: { token: string; projectId: string }) {
  const [runs, setRuns] = useState<BuildRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [failures, setFailures] = useState<{ repo: string; error: string }[]>([]);

  // The repositories say whether their CI could be read at all: no runs and
  // "could not read the runs" are different answers.
  useEffect(() => {
    let live = true;
    api
      .listArtifactNodes(token, "repo", projectId, undefined, 200)
      .then((page) => live && setFailures(ciReadFailures(page.nodes ?? [])))
      .catch(() => live && setFailures([]));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  useEffect(() => {
    let live = true;
    setRuns(null);
    setError(null);
    api
      .listArtifactNodes(token, "workflow_run", projectId, undefined, LIMIT, { sort: "updated" })
      .then((page) => live && setRuns(buildsOf(page.nodes ?? [])))
      .catch((e: unknown) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  const workflows = useMemo(() => workflowsOf(runs ?? []), [runs]);
  // The workflow that runs most is usually the one that builds: shown first,
  // until a member picks another.
  const chosen = workflow || workflows[0]?.name || "";
  const branches = useMemo(
    () => [...new Set((runs ?? []).filter((r) => r.workflow === chosen).map((r) => r.branch).filter(Boolean))] as string[],
    [runs, chosen],
  );
  const shown = (runs ?? []).filter((r) => r.workflow === chosen && (!branch || r.branch === branch));

  return (
    <>
      <h1>Builds</h1>
      <p className="subtitle">
        What the project&apos;s product was built into, where, and how it went. Studio does not build: CI and the
        IDE do. This reads the CI runs of the project&apos;s repositories on every sync.
      </p>
      {error && <div className="error">{error}</div>}
      {failures.map((f) => (
        <div key={f.repo} className="error" data-builds-ci-error>
          Studio could not read the CI runs of {f.repo}: {f.error}. The connection may lack read access to the
          repository&apos;s Actions.
        </div>
      ))}
      {!error && runs === null && <div className="empty">Loading…</div>}
      {runs && runs.length === 0 && (
        <div className="empty" data-builds-empty>
          No CI runs yet. They arrive with the next sync of the project&apos;s sources, if the connection can read the
          repository&apos;s Actions.
        </div>
      )}
      {runs && runs.length > 0 && (
        <section className="card">
          <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
            <div>
              <h2 data-builds-headline>{buildsHeadline(runs, chosen || null, branch || null)}</h2>
              <p className="subtitle">
                Newest first. A run links to its page in CI. Which workflow builds the product is not set yet, so this
                speaks of the one you pick.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                aria-label="Workflow"
                value={chosen}
                onChange={(e) => {
                  setWorkflow(e.target.value);
                  // The branch picked may not exist in the other workflow.
                  setBranch("");
                }}
              >
                {workflows.map((w) => (
                  <option key={w.name} value={w.name}>
                    {w.name} ({w.runs})
                  </option>
                ))}
              </select>
              <select aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">every branch</option>
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table" data-builds-table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Commit</th>
                  <th>Branch</th>
                  <th>Started by</th>
                  <th>When</th>
                  <th>Took</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} data-build-status={r.status}>
                    <td>
                      <span className={`badge ${statusTone(r.status)}`}>{r.status}</span>
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <code>{r.shortSha}</code>{" "}
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noreferrer">
                          {r.title || `run ${r.number ?? ""}`}
                        </a>
                      ) : (
                        r.title
                      )}
                      {r.attempt && r.attempt > 1 ? <span className="sub"> · attempt {r.attempt}</span> : null}
                    </td>
                    <td>{r.branch ?? "—"}</td>
                    <td>
                      {r.author ?? "—"}
                      {r.event ? <span className="sub"> · {r.event}</span> : null}
                    </td>
                    <td>{r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}</td>
                    <td>{buildDuration(r) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
