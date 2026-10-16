/* Where an organization's products run (ADR-0043).
 *
 * `OrgEnvironments` is the organization's Environments section: its
 * environments (a cluster connection, a registry, a namespace per project,
 * whether a deploy needs approval), the deploys waiting for a decision, and
 * what runs where. `ProjectEnvironments` sits on a project's product card:
 * its kubernetes profiles bound to the environments, and its deployments.
 *
 * A deploy itself is asked for from the desktop, which builds and pushes the
 * images and sends the generated chart; the server installs it with the
 * environment's connection. */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  api,
  type Connection,
  type DeployEnvironment,
  type DeployEnvironmentInput,
  type Deployment,
  type DeploymentStatus,
  type EnvironmentBinding,
  type ProjectTargets,
  type Tenant,
} from "./api";
import {
  DEFAULT_NAMESPACE_PATTERN,
  type EnvironmentField,
  STATE_LABELS,
  awaitingDecision,
  clusterConnections,
  emptyEnvironment,
  environmentInput,
  environmentProblems,
  environmentsByConnection,
  namespaceFor,
  runningNow,
  shortCommit,
  stateTone,
} from "./environments";
import { errText, relTime } from "./format";
import { AddCluster } from "./kubeconfig-field";

const PROJECT_TYPE = /tenant\.project\.v1/;

/** The cluster select's "connect a new one" entry. */
const NEW_CLUSTER = "__new_cluster__";

function StateBadge({ d }: { d: Deployment }) {
  return (
    <span className={`badge env-state env-${stateTone(d.state)}`} data-deployment-state={d.state}>
      {STATE_LABELS[d.state] ?? d.state}
    </span>
  );
}

/** One deployment as a row: what, where, who, when. */
function DeploymentLine({ d, showProject }: { d: Deployment; showProject: boolean }) {
  return (
    <div className="env-deployment">
      <StateBadge d={d} />
      <b>{d.product}</b>
      {showProject && <span className="sub">{d.project_name}</span>}
      <span className="sub">
        → {d.environment_name} · <code>{d.namespace}</code>
        {d.commit && (
          <>
            {" "}
            · <code>{shortCommit(d.commit)}</code>
          </>
        )}{" "}
        · {d.requested_by_name || d.requested_by} · {relTime(d.requested_at)}
        {d.decided_at && (
          <>
            {" "}
            · {d.state === "declined" ? "declined" : "approved"} by {d.decided_by_name || d.decided_by}
          </>
        )}
      </span>
      {d.reason && <div className="sub">“{d.reason}”</div>}
      {d.outcome && <div className="sub env-outcome">{d.outcome}</div>}
    </div>
  );
}

/** The rollout read back from the cluster, on demand. */
function StatusButton({ token, org, d }: { token: string; org: string; d: Deployment }) {
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.deploymentStatus(token, org, d.id));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="env-status">
      <button type="button" className="ghost" disabled={busy} onClick={() => void read()} data-deployment-status>
        {busy ? "Asking the cluster…" : status ? "Ask again" : "Status in the cluster"}
      </button>
      {error && <span className="error">{error}</span>}
      {status && (
        <ul className="env-workloads">
          {status.workloads.length === 0 && <li className="sub">No workloads in {d.namespace}.</li>}
          {status.workloads.map((w) => (
            <li key={w.name}>
              <span className={`badge env-${w.ready >= w.desired ? "ok" : "warn"}`}>
                {w.ready}/{w.desired}
              </span>{" "}
              {w.name} <span className="sub">{w.images.join(", ")}</span>
            </li>
          ))}
          {status.hosts.map((h) => (
            <li key={h}>
              <a href={`https://${h}`} target="_blank" rel="noreferrer">
                {h}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Add or change one environment. */
function EnvironmentForm({
  token,
  org,
  editing,
  others,
  clusters,
  projects,
  onDone,
  onCancel,
  onClusterAdded,
}: {
  token: string;
  org: string;
  editing: DeployEnvironment | null;
  others: DeployEnvironment[];
  clusters: Connection[];
  projects: Tenant[];
  onDone: () => void;
  onCancel: () => void;
  onClusterAdded: (c: Connection) => void;
}) {
  const [input, setInput] = useState<DeployEnvironmentInput>(() =>
    editing ? environmentInput(editing) : { ...emptyEnvironment(), connection_id: clusters.length === 1 ? clusters[0].id : "" },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // A field says what is wrong once it was touched, or once Add was pressed:
  // a fresh form is not a list of complaints.
  const [touched, setTouched] = useState<Set<EnvironmentField>>(new Set());
  const [tried, setTried] = useState(false);
  const problems = environmentProblems(input, others, editing?.id);
  const problem = Object.values(problems)[0] ?? null;
  const shown = (f: EnvironmentField) => ((tried || touched.has(f)) && problems[f]) || null;
  const touch = (f: EnvironmentField) => setTouched((t) => (t.has(f) ? t : new Set(t).add(f)));
  const set = <K extends keyof DeployEnvironmentInput>(k: K, v: DeployEnvironmentInput[K]) => {
    setInput((i) => ({ ...i, [k]: v }));
    if (k !== "description" && k !== "database" && k !== "protected") touch(k as EnvironmentField);
  };
  const patternIsDefault = (input.namespace_pattern ?? "").trim() === "" || input.namespace_pattern === DEFAULT_NAMESPACE_PATTERN;
  const examples = (projects.length > 0 ? projects.slice(0, 3).map((p) => p.name) : ["Studio Web"]).map((p) =>
    namespaceFor(input.namespace_pattern ?? "", p, input.name || "dev"),
  );
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) await api.updateEnvironment(token, org, editing.id, input);
      else await api.createEnvironment(token, org, input);
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const restricted = input.projects != null;
  return (
    <form
      className="card env-form"
      data-environment-form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!problem) void save();
      }}
    >
      <h3>{editing ? `Change ${editing.name}` : "Add an environment"}</h3>
      <label className="field">
        Name
        <input
          value={input.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="dev, stage or prod"
          aria-label="Name"
          aria-invalid={shown("name") ? true : undefined}
        />
        {shown("name") && <span className="env-field-error">{shown("name")}</span>}
      </label>
      <label className="field">
        Description
        <input value={input.description} onChange={(e) => set("description", e.target.value)} placeholder="optional" />
      </label>
      <label className="field">
        Cluster
        <select
          value={connecting ? NEW_CLUSTER : input.connection_id}
          onChange={(e) => {
            if (e.target.value === NEW_CLUSTER) {
              setConnecting(true);
              return;
            }
            setConnecting(false);
            set("connection_id", e.target.value);
          }}
          aria-label="Cluster"
          aria-invalid={shown("connection_id") ? true : undefined}
        >
          <option value="">{clusters.length === 0 ? "No cluster connected yet" : "Choose a cluster"}</option>
          {clusters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} — {c.base_url}
            </option>
          ))}
          <option value={NEW_CLUSTER}>+ Connect a cluster…</option>
        </select>
        {!connecting && shown("connection_id") && <span className="env-field-error">{shown("connection_id")}</span>}
      </label>
      {connecting && (
        <AddCluster
          token={token}
          org={org}
          onCancel={() => setConnecting(false)}
          onAdded={(c) => {
            setConnecting(false);
            onClusterAdded(c);
            set("connection_id", c.id);
          }}
        />
      )}
      <label className="field">
        Image registry
        <input
          value={input.registry}
          onChange={(e) => set("registry", e.target.value)}
          placeholder="ghcr.io/acme — where the product's images are pulled from"
          aria-invalid={shown("registry") ? true : undefined}
        />
        {shown("registry") && <span className="env-field-error">{shown("registry")}</span>}
      </label>
      <details className="env-advanced" open={!patternIsDefault || !!shown("namespace_pattern")}>
        <summary>
          Namespaces: <code>{examples.join(", ")}</code>
          <span className="sub"> · one per project</span>
        </summary>
        <label className="field">
          Namespace pattern
          <input
            value={input.namespace_pattern ?? ""}
            onChange={(e) => set("namespace_pattern", e.target.value)}
            placeholder={DEFAULT_NAMESPACE_PATTERN}
            aria-invalid={shown("namespace_pattern") ? true : undefined}
          />
          <span className="hint">
            A pattern, not a name: <code>{"{project}"}</code> becomes each project&apos;s name and <code>{"{environment}"}</code>{" "}
            this environment&apos;s.
          </span>
          {shown("namespace_pattern") && <span className="env-field-error">{shown("namespace_pattern")}</span>}
        </label>
      </details>
      <label className="field">
        Database
        <select value={input.database} onChange={(e) => set("database", e.target.value as "none" | "shared")}>
          <option value="none">None: the product brings its own</option>
          <option value="shared">The environment&apos;s shared Postgres — recorded only, not handed to the chart yet</option>
        </select>
      </label>
      <label className="env-check">
        <input type="checkbox" checked={input.protected} onChange={(e) => set("protected", e.target.checked)} /> Protected: a
        deploy waits for an organization administrator&apos;s approval
      </label>
      <label className="env-check">
        <input type="checkbox" checked={!restricted} onChange={(e) => set("projects", e.target.checked ? null : [])} /> Every
        project of the organization may deploy here
      </label>
      {restricted && (
        <ul className="env-projects">
          {projects.length === 0 && <li className="hint">No projects found.</li>}
          {projects.map((p) => (
            <li key={p.id}>
              <label>
                <input
                  type="checkbox"
                  checked={input.projects?.includes(p.id) ?? false}
                  onChange={(e) =>
                    set(
                      "projects",
                      e.target.checked ? [...(input.projects ?? []), p.id] : (input.projects ?? []).filter((id) => id !== p.id),
                    )
                  }
                />{" "}
                {p.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      {shown("projects") && <span className="env-field-error">{shown("projects")}</span>}
      {error && <div className="error">{error}</div>}
      <div className="env-actions">
        <button type="submit" className="primary" disabled={busy || connecting}>
          {editing ? "Save" : "Add"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The organization's Environments section. */
export function OrgEnvironments({ token, org, workspaceIds }: { token: string; org: { id: string; name: string }; workspaceIds: string[] }) {
  const [environments, setEnvironments] = useState<DeployEnvironment[] | null>(null);
  const [mayManage, setMayManage] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [projects, setProjects] = useState<Tenant[]>([]);
  const [editing, setEditing] = useState<DeployEnvironment | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [connectingCluster, setConnectingCluster] = useState(false);
  // What a Test answered, kept at the row it was asked from.
  const [answers, setAnswers] = useState<Record<string, { ok: boolean; text: string }>>({});
  const ask = async (key: string, run: () => Promise<string>) => {
    setBusy(key);
    try {
      const text = await run();
      setAnswers((a) => ({ ...a, [key]: { ok: true, text } }));
    } catch (e) {
      setAnswers((a) => ({ ...a, [key]: { ok: false, text: errText(e) } }));
    } finally {
      setBusy(null);
    }
  };
  const Answer = ({ id }: { id: string }) =>
    answers[id] ? <div className={`sub env-answer ${answers[id].ok ? "env-answer-ok" : "error"}`}>{answers[id].text}</div> : null;

  const load = useCallback(() => {
    let live = true;
    setError(null);
    Promise.all([
      api.environments(token, org.id),
      api.connections(token, org.id).catch(() => ({ items: [] as Connection[] })),
      api.deployments(token, { org: org.id }).catch(() => ({ items: [] as Deployment[], total: 0 })),
    ])
      .then(([envs, conns, deps]) => {
        if (!live) return;
        setEnvironments(envs.items);
        setMayManage(envs.may_manage);
        setConnections(conns.items);
        setDeployments(deps.items);
      })
      .catch((e) => {
        if (!live) return;
        setEnvironments([]);
        setError(e instanceof ApiError && e.status === 404 ? "This Studio has no environments yet (the backend predates them)." : errText(e));
      });
    return () => {
      live = false;
    };
  }, [token, org.id]);
  useEffect(load, [load]);

  useEffect(() => {
    let live = true;
    Promise.all(workspaceIds.map((w) => api.tenantChildrenAll(token, w).then((p) => p.items).catch(() => [] as Tenant[]))).then((lists) => {
      if (live) setProjects(lists.flat().filter((t) => PROJECT_TYPE.test(t.tenant_type)));
    });
    return () => {
      live = false;
    };
  }, [token, workspaceIds]);

  const clusters = useMemo(() => clusterConnections(connections), [connections]);
  const usedBy = useMemo(() => environmentsByConnection(environments ?? []), [environments]);
  const connectionLabel = (id: string) => connections.find((c) => c.id === id)?.label ?? "a connection this page cannot see";
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  const act = async (key: string, run: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await run());
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const waiting = awaitingDecision(deployments);
  const running = runningNow(deployments);

  return (
    <div className="envs" data-org-environments>
      <style>{ENV_CSS}</style>
      <h1>Environments</h1>
      <p className="subtitle">
        Where {org.name}&apos;s products run: a cluster, the registry its images come from, a namespace per project. A project
        binds its product&apos;s kubernetes profiles to these, and a deploy runs on the server with the environment&apos;s
        connection -- nobody&apos;s laptop holds the cluster&apos;s credentials.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="hint">{notice}</div>}

      {waiting.length > 0 && (
        <section className="card" data-deploys-awaiting>
          <h3>Waiting for a decision</h3>
          <ul className="env-list">
            {waiting.map((d) => (
              <li key={d.id}>
                <DeploymentLine d={d} showProject />
                {mayManage ? (
                  <div className="env-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy === d.id}
                      data-deploy-approve
                      onClick={() =>
                        void act(d.id, async () => {
                          await api.decideDeployment(token, org.id, d.id, "approve");
                          return `Approved: ${d.product} goes to ${d.environment_name}.`;
                        })
                      }
                    >
                      Approve
                    </button>
                    <button type="button" disabled={busy === d.id} onClick={() => setDeclining(declining === d.id ? null : d.id)}>
                      Decline…
                    </button>
                    {declining === d.id && (
                      <>
                        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="required: why not" aria-label="Reason" />
                        <button
                          type="button"
                          disabled={busy === d.id || !reason.trim()}
                          onClick={() =>
                            void act(d.id, async () => {
                              await api.decideDeployment(token, org.id, d.id, "decline", reason.trim());
                              setDeclining(null);
                              setReason("");
                              return `Declined the deploy of ${d.product} to ${d.environment_name}.`;
                            })
                          }
                        >
                          Decline
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="hint">An organization administrator decides.</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" data-clusters>
        <div className="card-head">
          <h3>Clusters</h3>
          {mayManage && !connectingCluster && (
            <button type="button" onClick={() => setConnectingCluster(true)} data-cluster-add>
              Connect a cluster
            </button>
          )}
        </div>
        <p className="hint">
          The Kubernetes clusters the organization deploys to. One cluster can hold several environments; its credential is
          kept in Connections, and only the server reads it.
        </p>
        {connectingCluster && (
          <AddCluster
            token={token}
            org={org.id}
            onCancel={() => setConnectingCluster(false)}
            onAdded={(c) => {
              setConnectingCluster(false);
              setNotice(`Connected ${c.label}.`);
              load();
            }}
          />
        )}
        {clusters.length === 0 ? (
          <p className="empty">No cluster connected yet.</p>
        ) : (
          <ul className="env-list">
            {clusters.map((c) => (
              <li key={c.id} data-cluster={c.label}>
                <div className="env-head">
                  <b>{c.label}</b>
                  <span className="sub">
                    <code>{c.base_url}</code> ·{" "}
                    {usedBy.get(c.id)?.length ? `environments: ${usedBy.get(c.id)?.join(", ")}` : "no environment uses it yet"}
                  </span>
                </div>
                <div className="env-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy === c.id}
                    onClick={() =>
                      void ask(c.id, async () => {
                        const t = await api.testConnection(token, c.id, org.id);
                        return `Answers: ${t.account}`;
                      })
                    }
                  >
                    {busy === c.id ? "Asking…" : "Test"}
                  </button>
                </div>
                <Answer id={c.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Environments</h3>
          {mayManage && editing === null && (
            <button type="button" className="primary" onClick={() => setEditing("new")} data-environment-add>
              Add an environment
            </button>
          )}
        </div>
        {editing !== null && (
          <EnvironmentForm
            token={token}
            org={org.id}
            editing={editing === "new" ? null : editing}
            others={environments ?? []}
            clusters={clusters}
            projects={projects}
            onCancel={() => setEditing(null)}
            onDone={() => {
              setEditing(null);
              load();
            }}
            onClusterAdded={(c) => setConnections((cs) => [...cs, c])}
          />
        )}
        {environments === null ? (
          <p className="hint">Loading…</p>
        ) : environments.length === 0 ? (
          <p className="empty">
            No environments yet.{" "}
            {mayManage ? "Add one for each place products run: dev, stage, prod." : "An organization administrator adds them."}
          </p>
        ) : (
          <ul className="env-list">
            {environments.map((e) => (
              <li key={e.id} data-environment={e.name}>
                <div className="env-head">
                  <b>{e.name}</b>
                  {e.protected && <span className="badge">protected</span>}
                  {e.database === "shared" && <span className="badge">shared database</span>}
                  <span className="sub">
                    cluster {connectionLabel(e.connection_id)} · images from{" "}
                    {e.registry ? <code>{e.registry}</code> : "where the chart says"} · namespaces{" "}
                    <code>{namespaceFor(e.namespace_pattern, projects[0]?.name ?? "Studio Web", e.name)}</code>
                    {projects.length > 1 ? "…" : ""} ·{" "}
                    {e.projects ? `${e.projects.length} project(s): ${e.projects.map(projectName).join(", ")}` : "every project"}
                  </span>
                </div>
                {e.description && <div className="sub">{e.description}</div>}
                {mayManage && (
                  <div className="env-actions">
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy === e.id}
                      onClick={() => void ask(e.id, async () => (await api.testEnvironment(token, org.id, e.id)).message)}
                    >
                      {busy === e.id ? "Asking…" : "Test"}
                    </button>
                    <button type="button" className="ghost" onClick={() => setEditing(e)}>
                      Change
                    </button>
                    <button
                      type="button"
                      className="ghost danger"
                      disabled={busy === e.id}
                      onClick={() => {
                        if (!window.confirm(`Remove ${e.name}? What runs in the cluster stays there.`)) return;
                        void act(e.id, async () => {
                          await api.deleteEnvironment(token, org.id, e.id);
                          return `Removed ${e.name}.`;
                        });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
                <Answer id={e.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" data-running-now>
        <h3>What runs where</h3>
        {running.length === 0 ? (
          <p className="empty">Nothing deployed yet.</p>
        ) : (
          <ul className="env-list">
            {running.map((d) => (
              <li key={d.id}>
                <DeploymentLine d={d} showProject />
                <StatusButton token={token} org={org.id} d={d} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3>Deployments</h3>
        {deployments.length === 0 ? (
          <p className="empty">No deploys yet. A deploy is asked for from the desktop, after Generate.</p>
        ) : (
          <ul className="env-list">
            {deployments.map((d) => (
              <li key={d.id}>
                <DeploymentLine d={d} showProject />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A project's environments, on its product card: bindings and deployments. */
export function ProjectEnvironments({ token, projectId, profiles }: { token: string; projectId: string; profiles: readonly string[] }) {
  const [targets, setTargets] = useState<ProjectTargets | null>(null);
  const [bindings, setBindings] = useState<EnvironmentBinding[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([api.projectTargets(token, projectId), api.deployments(token, { project: projectId }).catch(() => ({ items: [] as Deployment[], total: 0 }))])
      .then(([t, d]) => {
        if (!live) return;
        setTargets(t);
        setBindings(t.bindings);
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

  if (unavailable) return null;
  const bound = (profile: string) => bindings.find((b) => b.profile === profile)?.environment_id ?? "";
  const bind = (profile: string, environment: string) => {
    setSaved(false);
    setBindings((all) => [...all.filter((b) => b.profile !== profile), ...(environment ? [{ profile, environment_id: environment }] : [])]);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setBindings((await api.saveBindings(token, projectId, bindings)).items);
      setSaved(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const changed = targets !== null && JSON.stringify(sortBindings(bindings)) !== JSON.stringify(sortBindings(targets.bindings));

  return (
    <div className="envs env-project" data-project-environments>
      <style>{ENV_CSS}</style>
      <div className="card-head">
        <h3>Environments</h3>
      </div>
      {error && <div className="error">{error}</div>}
      {targets === null ? (
        <p className="hint">Loading…</p>
      ) : targets.environments.length === 0 ? (
        <p className="empty">The organization has no environment this project may deploy to yet.</p>
      ) : (
        <>
          <p className="hint">
            Bind each kubernetes profile of the product to an environment: Deploy on the desktop takes the namespace and the image
            registry from it.
          </p>
          <ul className="env-list">
            {profiles.map((profile) => {
              const env = targets.environments.find((t) => t.environment.id === bound(profile));
              return (
                <li key={profile} className="env-binding">
                  <code>{profile}</code> →{" "}
                  <select value={bound(profile)} onChange={(e) => bind(profile, e.target.value)} aria-label={`Environment for ${profile}`}>
                    <option value="">not bound</option>
                    {targets.environments.map((t) => (
                      <option key={t.environment.id} value={t.environment.id}>
                        {t.environment.name}
                        {t.environment.protected ? " (protected)" : ""}
                      </option>
                    ))}
                  </select>
                  {env && (
                    <span className="sub">
                      {" "}
                      namespace <code>{env.namespace}</code>
                      {env.environment.registry && (
                        <>
                          , images from <code>{env.environment.registry}</code>
                        </>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="env-actions">
            <button type="button" className="primary" disabled={busy || !changed} onClick={() => void save()} data-bindings-save>
              Save
            </button>
            {saved && <span className="hint">Saved.</span>}
          </div>
        </>
      )}
      {deployments.length > 0 && targets && (
        <ul className="env-list">
          {deployments.slice(0, 10).map((d) => (
            <li key={d.id}>
              <DeploymentLine d={d} showProject={false} />
              {d.state === "succeeded" && <StatusButton token={token} org={targets.organization_id} d={d} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sortBindings(b: EnvironmentBinding[]): EnvironmentBinding[] {
  return [...b].sort((x, y) => x.profile.localeCompare(y.profile));
}

const ENV_CSS = `
.envs .env-list { list-style:none; padding:0; margin:8px 0 0; display:grid; gap:10px; }
.envs .env-head, .envs .env-deployment { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
.envs .sub { color:var(--muted-foreground); font-size:12px; }
.envs .env-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px; }
.envs .env-actions input { flex:1; min-width:200px; }
.envs .env-form { display:grid; gap:10px; margin:10px 0; }
.envs .env-check { display:flex; gap:6px; align-items:center; font-size:13px; }
.envs .env-projects { list-style:none; padding:0 0 0 22px; margin:0; display:grid; gap:4px; max-height:180px; overflow:auto; }
.envs .env-ok { background:color-mix(in srgb, #16a34a 18%, transparent); }
.envs .env-warn { background:color-mix(in srgb, #d97706 18%, transparent); }
.envs .env-bad { background:color-mix(in srgb, #dc2626 18%, transparent); }
.envs .env-outcome { white-space:pre-wrap; overflow-wrap:anywhere; }
.envs .env-workloads { list-style:none; padding:0; margin:6px 0 0; display:grid; gap:4px; font-size:13px; }
.envs .env-status { margin-top:6px; }
.envs .env-binding select { min-width:160px; }
.envs .env-field-error { color:var(--destructive, #dc2626); font-size:12px; }
.envs [aria-invalid] { border-color:var(--destructive, #dc2626); }
.envs .env-answer { margin-top:4px; }
.envs .env-answer-ok { color:#15803d; }
.envs .env-advanced summary { cursor:pointer; font-size:13px; }
.envs .env-advanced[open] summary { margin-bottom:8px; }
.env-project { margin-top:12px; }
`;
