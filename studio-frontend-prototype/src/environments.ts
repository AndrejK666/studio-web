/* Where an organization's products run (ADR-0043): the rules behind the
 * Environments screen and the product card's Deploy section, kept apart
 * from the React for their tests. The server checks all of these again;
 * here they say what is wrong before the form is sent. */

import type { Connection, DeployEnvironment, DeployEnvironmentInput, Deployment, DeploymentState } from "./api";

/** One namespace per project and environment, unless the environment says otherwise. */
export const DEFAULT_NAMESPACE_PATTERN = "{project}-{environment}";

/** A name made fit for a namespace, as the server makes it: lowercased, every
 *  run of other characters one `-`, trimmed of `-`. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A Kubernetes namespace (DNS-1123 label). */
export function isDnsLabel(s: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s);
}

/** The namespace `pattern` gives `project` in `environment`. */
export function namespaceFor(pattern: string, project: string, environment: string): string {
  return (pattern.trim() || DEFAULT_NAMESPACE_PATTERN)
    .split("{project}")
    .join(slug(project))
    .split("{environment}")
    .join(slug(environment));
}

/** A form with nothing in it yet. */
export function emptyEnvironment(): DeployEnvironmentInput {
  return {
    name: "",
    description: "",
    connection_id: "",
    registry: "",
    namespace_pattern: DEFAULT_NAMESPACE_PATTERN,
    database: "none",
    protected: false,
    projects: null,
  };
}

/** What a stored environment looks like as a form. */
export function environmentInput(e: DeployEnvironment): DeployEnvironmentInput {
  return {
    name: e.name,
    description: e.description,
    connection_id: e.connection_id,
    registry: e.registry,
    namespace_pattern: e.namespace_pattern,
    database: e.database,
    protected: e.protected,
    projects: e.projects ?? null,
  };
}

/** What is wrong with a form, in the words the person reads; `null` when nothing. */
export function environmentProblem(input: DeployEnvironmentInput, others: readonly DeployEnvironment[], editing?: string): string | null {
  const name = input.name.trim();
  if (!isDnsLabel(name)) return "Name: lowercase letters, digits and '-', like dev, stage or prod.";
  if (others.some((e) => e.name === name && e.id !== editing)) return `The organization already has an environment '${name}'.`;
  if (!input.connection_id) return "Choose the cluster: a Kubernetes connection of the organization.";
  const pattern = (input.namespace_pattern ?? "").trim() || DEFAULT_NAMESPACE_PATTERN;
  if (!pattern.includes("{project}")) return "The namespace pattern must contain {project}: each project gets its own namespace.";
  if (!isDnsLabel(namespaceFor(pattern, "a-project", name))) return `The pattern does not make a namespace: '${namespaceFor(pattern, "a-project", name)}'.`;
  const registry = input.registry.trim();
  if (registry.includes("://")) return "Write the registry without a scheme, e.g. ghcr.io/acme.";
  if (registry !== "" && !/^[A-Za-z0-9._\-/:]+$/.test(registry)) return "That is not an image registry prefix, e.g. ghcr.io/acme.";
  if (input.projects && input.projects.length === 0) return "Choose at least one project, or let every project deploy here.";
  return null;
}

/** The connections an environment can name: the organization's clusters,
 *  not a personal one -- a deploy runs as the server, which cannot read it. */
export function clusterConnections(connections: readonly Connection[]): Connection[] {
  return connections.filter((c) => c.provider === "kubernetes" && c.scope !== "personal");
}

/** A deployment's state, as a person reads it. */
export const STATE_LABELS: Record<DeploymentState, string> = {
  awaiting_approval: "Waiting for approval",
  declined: "Declined",
  queued: "Queued",
  running: "Deploying",
  succeeded: "Deployed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** The badge class a state is drawn with. */
export function stateTone(state: DeploymentState): "ok" | "warn" | "bad" | "idle" {
  switch (state) {
    case "succeeded":
      return "ok";
    case "awaiting_approval":
    case "queued":
    case "running":
      return "warn";
    case "failed":
    case "declined":
      return "bad";
    default:
      return "idle";
  }
}

/** What runs where: the latest succeeded deployment of each project in each
 *  environment, newest first as the server lists them. */
export function runningNow(deployments: readonly Deployment[]): Deployment[] {
  const seen = new Set<string>();
  const out: Deployment[] = [];
  for (const d of deployments) {
    if (d.state !== "succeeded") continue;
    const key = `${d.project_id}/${d.environment_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** The deploys an administrator has to decide about. */
export function awaitingDecision(deployments: readonly Deployment[]): Deployment[] {
  return deployments.filter((d) => d.state === "awaiting_approval");
}

/** A short commit, as people quote one. */
export function shortCommit(commit: string | null | undefined): string {
  return commit ? commit.slice(0, 8) : "";
}
