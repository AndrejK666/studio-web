/* A project's path to running (#1050): Specs → Product → Build → Image →
 * Environment → Running. The server decides Product to Running from what
 * the project keeps (`GET /studio-environments/v1/project-path`); Specs is
 * the spec mapping's, read here from the size of its plan. What a step's
 * action does on this screen, which deploy the address names (the Inbox's
 * "A Research deploy you asked for failed" opens one, #1054), and the
 * Research target of the one deploy dialog (#1053) are decided here too. */

import type {
  DeployEnvironment,
  DeployEnvironmentInput,
  PathAction,
  PathStep,
  PathStepId,
  ProjectPath,
} from "../api/types";

/** The order of the steps, as the path is drawn. */
export const PATH_STEPS: readonly PathStepId[] = ["specs", "product", "build", "image", "environment", "running"];

/** How many capabilities the project's specifications need, or why it is not known. */
export type SpecsSeen = { count: number } | "unavailable";

/** The Specs step: done once the specifications name a capability; never
 *  blocks the rest -- a product may be composed without them. */
export function specsStep(seen: SpecsSeen): PathStep {
  if (seen === "unavailable") {
    return { id: "specs", state: "later", reason: "", checklist: [] };
  }
  return seen.count > 0
    ? { id: "specs", state: "done", reason: "", checklist: [] }
    : { id: "specs", state: "next", reason: "", checklist: [], action: { kind: "open_specs", label: "" } };
}

/** The whole path: Specs first, then the server's steps. The step to look
 *  at stays the server's -- Specs only says what the documents give. */
export function pathSteps(path: ProjectPath, specs: SpecsSeen): PathStep[] {
  return [specsStep(specs), ...path.steps];
}

/** What pressing a step's (or a cause's) button does on Releases. */
export type Intent =
  | { kind: "screen"; route: string }
  | { kind: "tab"; tab: "build" | "deploy" }
  | { kind: "deploy"; environmentId: string | null; research: boolean }
  | { kind: "deployment"; id: string }
  | { kind: "url"; url: string }
  | { kind: "none" };

/** The screens a step leads to, by their routes. */
export const ROUTES = {
  specs: "/projects/specs",
  sources: "/projects/sources",
  product: "/product",
  connections: "/connections",
  infrastructure: "/infrastructure",
} as const;

export function intentOf(a: Pick<PathAction, "kind"> & Partial<PathAction>, deploymentId?: string | null): Intent {
  switch (a.kind) {
    case "open_specs":
      return { kind: "screen", route: ROUTES.specs };
    case "open_sources":
      return { kind: "screen", route: ROUTES.sources };
    case "open_product":
    case "open_gear":
      return { kind: "screen", route: ROUTES.product };
    case "build":
    case "open_build":
      return { kind: "tab", tab: "build" };
    case "deploy":
    case "retry":
      return { kind: "deploy", environmentId: a.environment_id ?? null, research: false };
    case "choose_hardware":
      return { kind: "deploy", environmentId: null, research: true };
    case "bind_profile":
    case "provide_secret":
    case "check_environment":
      return { kind: "tab", tab: "deploy" };
    case "sign_in":
      return { kind: "screen", route: ROUTES.connections };
    case "ask_admin":
    case "ask_organization":
      return { kind: "screen", route: ROUTES.infrastructure };
    case "open_deployment":
    case "open_log": {
      const id = a.deployment_id ?? deploymentId ?? null;
      return id ? { kind: "deployment", id } : { kind: "tab", tab: "deploy" };
    }
    case "open_app":
      return a.url ? { kind: "url", url: a.url } : { kind: "none" };
    default:
      return { kind: "none" };
  }
}

/** The deploy the address names (`…&deployment=<id>`), as the Inbox links it. */
export function deploymentFromSearch(search: string): string | null {
  try {
    const id = new URLSearchParams(search).get("deployment");
    return id && /^[0-9a-f-]{8,}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The Research environment that runs in `researchProject`, if the project
 *  has one: the dialog reuses it rather than adding another, whatever its
 *  name, hardware or sign-in -- one environment per Research project (#1053).
 *  The project's own comes before one of the organization's. */
export function researchEnvironmentFor(
  environments: readonly DeployEnvironment[],
  researchProject: string,
): DeployEnvironment | undefined {
  const mine = environments.filter((e) => e.kind === "research" && e.research_project === researchProject);
  return mine.find((e) => !!e.project_id) ?? mine[0];
}

/** Whether `env` must be changed to run on `hardware` with `connection`: the
 *  dialog asks the server to add the environment again, which changes the
 *  one it has for that Research project instead (#1053). An organization's
 *  environment is not the project's to change. */
export function researchEnvironmentStale(env: DeployEnvironment, connection: string, hardware: string | null): boolean {
  return !!env.project_id && (env.connection_id !== connection || (env.research_hardware ?? null) !== (hardware || null));
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** An environment's name for a Research project: the server takes only a DNS
 *  label (lowercase letters, digits and '-', at most 63), so "Example project"
 *  becomes `research-example-project`. The hardware is not in it: it is a
 *  setting of the one environment. Two Research projects of one name get the
 *  second's id start: `research-example-project-8fae83`. */
export function researchEnvironmentName(researchProject: { id: string; name: string }, taken: readonly string[] = []): string {
  const base = `research-${slug(researchProject.name) || slug(researchProject.id) || "project"}`.slice(0, 63).replace(/-+$/, "");
  if (!taken.includes(base)) return base;
  const tail = `-${slug(researchProject.id).slice(0, 6) || "2"}`;
  return `${base.slice(0, 63 - tail.length).replace(/-+$/, "")}${tail}`;
}

/** A project's own Research environment, on the caller's own sign-in. */
export function researchEnvironmentInput(
  connectionId: string,
  researchProject: { id: string; name: string },
  hardware: string | null,
  taken: readonly string[] = [],
): DeployEnvironmentInput {
  return {
    name: researchEnvironmentName(researchProject, taken),
    description: "",
    kind: "research",
    connection_id: connectionId,
    research_project: researchProject.id,
    research_hardware: hardware || null,
    registry: "",
    database: "none",
    protected: false,
  };
}

/** The caller's Research projects as the picker lists them: those whose
 *  Deployment is on (or not known) first, the others after, in Research's
 *  order within each. */
export function pickableResearchProjects<P extends { deployment_enabled?: boolean | null }>(projects: readonly P[]): P[] {
  return [...projects.filter((p) => p.deployment_enabled !== false), ...projects.filter((p) => p.deployment_enabled === false)];
}

/** A build or a deploy that has ended. */
export function ended(state: string): boolean {
  return ["passed", "failed", "cancelled", "succeeded", "declined"].includes(state);
}
