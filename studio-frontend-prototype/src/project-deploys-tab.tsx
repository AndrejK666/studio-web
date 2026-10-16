/* A project's Deploys tab (ADR-0043): where its product runs. One card per
 * environment the organization lets the project deploy to -- the namespace it
 * gets there, the images' registry, what was deployed last and how it went --
 * then the bindings of the product's kubernetes profiles and the history,
 * which `ProjectEnvironments` already draws.
 *
 * Builds before it, because a deploy takes what a build made; the portal
 * neither builds nor deploys by itself: Deploy is asked for from the IDE after
 * Generate, and the server installs it with the environment's connection. */

import { useEffect, useState } from "react";

import { ApiError, api, type Deployment, type ProjectTargets } from "./api";
import { ProjectEnvironments } from "./environments-screen";
import { STATE_LABELS, shortCommit, stateTone } from "./environments";
import { errText, relTime } from "./format";
import { KUBERNETES_PROFILES } from "./kits";
import { latestByEnvironment, profilesBoundTo } from "./project-deploys";

export function ProjectDeploys({
  token,
  projectId,
  onOpenStudio,
}: {
  token: string;
  projectId: string;
  onOpenStudio: () => void;
}) {
  const [targets, setTargets] = useState<ProjectTargets | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.projectTargets(token, projectId),
      api.deployments(token, { project: projectId }).catch(() => ({ items: [] as Deployment[], total: 0 })),
    ])
      .then(([t, d]) => {
        if (!live) return;
        setTargets(t);
        setDeployments(d.items);
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setUnavailable(true);
        else setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [token, projectId]);

  const latest = latestByEnvironment(deployments);

  return (
    <div className="project-deploys" data-project-deploys>
      <style>{DEPLOYS_CSS}</style>
      <h1>Deploys</h1>
      <p className="subtitle">
        Where this project&apos;s product runs. The organization keeps the environments (Organization › Environments); the
        project picks which of them its product goes to. A deploy is asked for from the IDE, after Generate, and the server
        installs it with the environment&apos;s cluster connection.
      </p>
      {error && <div className="error">{error}</div>}
      {unavailable ? (
        <p className="empty">This Studio has no environments yet (the backend predates them).</p>
      ) : targets === null ? (
        !error && <p className="hint">Loading…</p>
      ) : targets.environments.length === 0 ? (
        <div className="card">
          <p className="empty">
            The organization has no environment this project may deploy to yet. An organization administrator adds them under
            Organization › Environments.
          </p>
        </div>
      ) : (
        <div className="deploy-envs">
          {targets.environments.map(({ environment: e, namespace }) => {
            const d = latest.get(e.id);
            const profiles = profilesBoundTo(targets.bindings, e.id);
            return (
              <section key={e.id} className="card deploy-env" data-deploy-environment={e.name}>
                <div className="deploy-env-head">
                  <b>{e.name}</b>
                  {e.protected && <span className="badge">needs approval</span>}
                </div>
                {e.description && <div className="sub">{e.description}</div>}
                <dl>
                  <dt>Namespace</dt>
                  <dd>
                    <code>{namespace}</code>
                  </dd>
                  <dt>Images from</dt>
                  <dd>{e.registry ? <code>{e.registry}</code> : <span className="sub">where the chart says</span>}</dd>
                  <dt>Profiles</dt>
                  <dd>
                    {profiles.length ? profiles.map((p) => <code key={p}>{p} </code>) : <span className="sub">none bound yet</span>}
                  </dd>
                  <dt>Last deploy</dt>
                  <dd>
                    {d ? (
                      <>
                        <span className={`badge deploy-${stateTone(d.state)}`}>{STATE_LABELS[d.state] ?? d.state}</span>{" "}
                        {d.commit && <code>{shortCommit(d.commit)}</code>} <span className="sub">{relTime(d.requested_at)}</span>
                      </>
                    ) : (
                      <span className="sub">nothing deployed yet</span>
                    )}
                  </dd>
                </dl>
              </section>
            );
          })}
        </div>
      )}
      {targets && targets.environments.length > 0 && (
        <div className="row deploy-how">
          <span className="grow hint">To deploy: open the project in the IDE, Generate, then Deploy to a bound environment.</span>
          <button type="button" onClick={onOpenStudio}>
            Open in IDE
          </button>
        </div>
      )}
      {!unavailable && (
        <div className="card">
          <ProjectEnvironments token={token} projectId={projectId} profiles={KUBERNETES_PROFILES} />
        </div>
      )}
    </div>
  );
}

const DEPLOYS_CSS = `
.project-deploys .deploy-envs { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px; margin:12px 0; }
.project-deploys .deploy-env { margin:0; }
.project-deploys .deploy-env-head { display:flex; gap:8px; align-items:baseline; }
.project-deploys .deploy-env dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:10px 0 0; font-size:13px; }
.project-deploys .deploy-env dt { color:var(--muted-foreground); }
.project-deploys .deploy-env dd { margin:0; overflow-wrap:anywhere; }
.project-deploys .sub { color:var(--muted-foreground); font-size:12px; }
.project-deploys .deploy-ok { background:color-mix(in srgb, #16a34a 18%, transparent); }
.project-deploys .deploy-warn { background:color-mix(in srgb, #d97706 18%, transparent); }
.project-deploys .deploy-bad { background:color-mix(in srgb, #dc2626 18%, transparent); }
.project-deploys .deploy-how { margin:0 0 12px; align-items:center; }
`;
