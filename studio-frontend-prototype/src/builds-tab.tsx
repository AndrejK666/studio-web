// A project's Builds tab (ADR-0045): the CI runs of its repositories, as the
// artifact sync reads them (phase 1); the builds the IDE ran and reported,
// in a member's desktop or a session (phase 2); and Build, which starts the
// project's build workflow in CI, beside Open in the IDE (phase 3). The
// portal does not build; this is what was built, where and how it went.

import { useEffect, useMemo, useState } from "react";

import { api, type ProjectConfig } from "./api";
import {
  type BuildRun,
  type BuildWorkflow,
  type IdeBuild,
  buildDuration,
  buildWorkflowOf,
  buildsHeadline,
  buildsOf,
  ciReadFailures,
  ideBuildDuration,
  ideBuildsOf,
  isBuildWorkflow,
  repoPathsOf,
  statusTone,
  workflowsOf,
} from "./builds";
import { errText } from "./format";

/** At most this many runs are read: the sync keeps the newest few hundred
 *  per repository. */
const LIMIT = 200;

export function ProjectBuilds({
  token,
  projectId,
  onOpenStudio,
}: {
  token: string;
  projectId: string;
  /** Open the project in the IDE, where Build, Run and Deploy run. */
  onOpenStudio?: () => void;
}) {
  const [runs, setRuns] = useState<BuildRun[] | null>(null);
  const [ideBuilds, setIdeBuilds] = useState<IdeBuild[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [failures, setFailures] = useState<{ repo: string; error: string }[]>([]);
  const [repoPaths, setRepoPaths] = useState<Map<string, string>>(new Map());
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The repositories say whether their CI could be read at all: no runs and
  // "could not read the runs" are different answers. They also name the
  // repository a run belongs to, which Build needs.
  useEffect(() => {
    let live = true;
    api
      .listArtifactNodes(token, "repo", projectId, undefined, 200)
      .then((page) => {
        if (!live) return;
        setFailures(ciReadFailures(page.nodes ?? []));
        setRepoPaths(repoPathsOf(page.nodes ?? []));
      })
      .catch(() => live && setFailures([]));
    api
      .projectConfig(token, projectId)
      .then((c) => live && setConfig(c))
      .catch(() => live && setConfig(null));
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
    api
      .listArtifactNodes(token, "build", projectId, undefined, LIMIT, { sort: "updated" })
      .then((page) => live && setIdeBuilds(ideBuildsOf(page.nodes ?? [])))
      .catch(() => live && setIdeBuilds([]));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  const workflows = useMemo(() => workflowsOf(runs ?? []), [runs]);
  const setting = config?.build ?? null;
  // The project's build workflow first; else the workflow that runs most,
  // which is usually the one that builds, until a member picks another.
  const settingName = useMemo(
    () =>
      workflows.find((w) => isBuildWorkflow(setting, buildWorkflowOf(runs ?? [], w.name, repoPaths)))?.name ?? "",
    [workflows, setting, runs, repoPaths],
  );
  const chosen = workflow || settingName || workflows[0]?.name || "";
  const candidate = useMemo(() => buildWorkflowOf(runs ?? [], chosen, repoPaths), [runs, chosen, repoPaths]);
  const chosenIsTheBuild = isBuildWorkflow(setting, candidate);
  const branches = useMemo(
    () => [...new Set((runs ?? []).filter((r) => r.workflow === chosen).map((r) => r.branch).filter(Boolean))] as string[],
    [runs, chosen],
  );
  const shown = (runs ?? []).filter((r) => r.workflow === chosen && (!branch || r.branch === branch));

  const act = async (what: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    setActionError(null);
    try {
      setNote(await what());
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const makeTheBuild = (picked: BuildWorkflow) =>
    act(async () => {
      const current = (await api.projectConfig(token, projectId).catch(() => null)) ?? {};
      const next = { ...current, build: picked };
      await api.putProjectConfig(token, projectId, next);
      setConfig(next);
      return `${picked.workflow} in ${picked.repo} is the project's build workflow now.`;
    });

  const startBuild = (picked: BuildWorkflow) =>
    act(async () => {
      const r = await api.dispatchBuild(token, projectId, {
        repo: picked.repo,
        workflow: picked.workflow,
        ...(branch ? { ref: branch } : {}),
      });
      return `Started ${r.workflow} on ${r.ref} in ${r.repo}. The run shows here after the next sync of the project's sources.`;
    });

  return (
    <>
      <h1>Builds</h1>
      <p className="subtitle">
        What the project&apos;s product was built into, where, and how it went. Studio does not build: CI and the
        IDE do. This reads the CI runs of the project&apos;s repositories on every sync, and the builds the IDE reports
        as they start and end.
      </p>
      {error && <div className="error">{error}</div>}
      {failures.map((f) => (
        <div key={f.repo} className="error" data-builds-ci-error>
          Studio could not read the CI runs of {f.repo}: {f.error}. The connection may lack read access to the
          repository&apos;s Actions.
        </div>
      ))}
      {actionError && (
        <div className="error" data-builds-action-error>
          {actionError}
        </div>
      )}
      {note && (
        <div className="hint" data-builds-note>
          {note}
        </div>
      )}
      <IdeBuilds builds={ideBuilds} onOpenStudio={onOpenStudio} />
      {!error && runs === null && <div className="empty">Loading…</div>}
      {runs && runs.length === 0 && (
        <div className="empty" data-builds-empty>
          No CI runs yet. Next: push the composed product to a repository with a CI workflow, then sync it on
          Sources; runs arrive if the connection can read the repository&apos;s Actions.
        </div>
      )}
      {runs && runs.length > 0 && (
        <section className="card">
          <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
            <div>
              <h2 data-builds-headline>{buildsHeadline(runs, chosen || null, branch || null)}</h2>
              <p className="subtitle">
                Newest first. A run links to its page in CI.{" "}
                {chosenIsTheBuild
                  ? "This is the project's build workflow: Build starts it."
                  : setting
                    ? `The project's build workflow is ${setting.workflow} in ${setting.repo}.`
                    : "Which workflow builds the product is not set yet, so this speaks of the one you pick."}
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
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
              {candidate && !chosenIsTheBuild && (
                <button type="button" disabled={busy} onClick={() => void makeTheBuild(candidate)} data-builds-set>
                  Use as the build workflow
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={busy || !candidate}
                title={
                  candidate
                    ? `Start ${candidate.workflow} on ${branch || "the repository's branch"} in CI`
                    : "Its runs name no workflow file this connection can start"
                }
                onClick={() => candidate && void startBuild(candidate)}
                data-builds-start
              >
                {busy ? "Starting…" : "Build in CI"}
              </button>
              {onOpenStudio && (
                <button type="button" onClick={onOpenStudio} data-builds-open-ide>
                  Open in the IDE
                </button>
              )}
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

/** The builds the IDE ran, newest first: a failed one with its first error,
 *  so the next member does not rebuild to find it; a passed one is deployed
 *  from the IDE, where its chart is. */
function IdeBuilds({ builds, onOpenStudio }: { builds: IdeBuild[]; onOpenStudio?: () => void }) {
  if (builds.length === 0) return null;
  return (
    <section className="card" data-ide-builds>
      <div className="card-head">
        <div>
          <h2>In the IDE</h2>
          <p className="subtitle">
            Build and Run in a member&apos;s desktop or a session, as the IDE reported them. A passed build is
            deployed from the IDE&apos;s Generate view, where its chart is made; the deploy names the build.
          </p>
        </div>
        {onOpenStudio && (
          <button type="button" onClick={onOpenStudio}>
            Open in the IDE
          </button>
        )}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="table" data-ide-builds-table>
          <thead>
            <tr>
              <th>Status</th>
              <th>What</th>
              <th>Commit</th>
              <th>Where</th>
              <th>When</th>
              <th>Took</th>
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <tr key={b.id} data-ide-build-status={b.status}>
                <td>
                  <span className={`badge ${statusTone(b.status)}`}>{b.status}</span>
                </td>
                <td style={{ minWidth: 240 }}>
                  {b.action === "run" ? "Run" : "Build"} {b.product ?? "the product"}
                  {b.profile ? <span className="sub"> · {b.profile}</span> : null}
                  {b.status === "failed" && b.failure ? (
                    <div className="error" style={{ marginTop: 4 }} data-ide-build-failure>
                      {b.failureStep ? `${b.failureStep}: ` : ""}
                      {b.failure}
                    </div>
                  ) : null}
                  {b.outputs.length > 0 ? <div className="sub">{b.outputs.join(", ")}</div> : null}
                </td>
                <td>
                  {b.shortSha ? <code>{b.shortSha}</code> : "—"}
                  {b.branch ? <span className="sub"> · {b.branch}</span> : null}
                </td>
                <td>{b.where}</td>
                <td>{b.startedAt ? new Date(b.startedAt).toLocaleString() : "—"}</td>
                <td>{ideBuildDuration(b) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
