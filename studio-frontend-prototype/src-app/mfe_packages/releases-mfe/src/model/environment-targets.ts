/* Where each environment of Releases runs (owner feedback, 2026-11-23): a
 * Kubernetes environment is a namespace of a cluster the organization
 * connected; a Constructor Research one is an application in a Research
 * project, on its hardware, signed in with a Research account. Releases
 * groups its environments by that and names the place on every row.
 *
 * Pure, so it is tested without a backend: the screen reads the
 * connections and the caller's Research projects and hands their names in. */

import type { Connection, DeployEnvironment, ResearchHardware, ResearchProject } from "../api/types";
import type { IdeBuild } from "./builds";
import { RESEARCH_STEPS, type ResearchProgress } from "./research-progress";

export type TargetKind = "kubernetes" | "research";

/** An environment written before kinds is a cluster's. */
export function targetKindOf(env: Pick<DeployEnvironment, "kind">): TargetKind {
  return env.kind === "research" ? "research" : "kubernetes";
}

/** The names the screen could read: what an id is called. */
export interface TargetNames {
  connections: readonly Pick<Connection, "id" | "label" | "account">[];
  researchProjects: readonly Pick<ResearchProject, "id" | "name">[];
  /** Hardware by Research project id. */
  hardware: ReadonlyMap<string, readonly Pick<ResearchHardware, "id" | "name">[]>;
}

export const NO_NAMES: TargetNames = { connections: [], researchProjects: [], hardware: new Map() };

export type EnvironmentTarget =
  | {
      kind: "kubernetes";
      /** The cluster connection's label; null when it is not readable here. */
      cluster: string | null;
      namespace: string;
    }
  | {
      kind: "research";
      /** The Research project's name, or its short id when the caller's
       *  sign-in does not list it. */
      project: string | null;
      /** Whether `project` is a name (true) or only a short id. */
      projectNamed: boolean;
      /** The hardware's name, its short id, or null: the project's default. */
      hardware: string | null;
      /** The Research sign-in's label. */
      account: string | null;
    };

/** A Research id as people can tell it apart: its first eight characters. */
export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function connectionLabel(names: TargetNames, id: string): string | null {
  const c = names.connections.find((x) => x.id === id);
  return c ? c.label || c.account || null : null;
}

/** Where `env` runs, by the names the screen could read. */
export function environmentTarget(env: DeployEnvironment, namespace: string, names: TargetNames = NO_NAMES): EnvironmentTarget {
  if (targetKindOf(env) === "kubernetes") {
    return { kind: "kubernetes", cluster: connectionLabel(names, env.connection_id), namespace };
  }
  const projectId = env.research_project ?? null;
  const named = projectId ? names.researchProjects.find((p) => p.id === projectId)?.name : undefined;
  const hardwareId = env.research_hardware ?? null;
  const hw = hardwareId && projectId ? names.hardware.get(projectId)?.find((h) => h.id === hardwareId)?.name : undefined;
  return {
    kind: "research",
    project: named || (projectId ? shortId(projectId) : null),
    projectNamed: !!named,
    hardware: hw || (hardwareId ? shortId(hardwareId) : null),
    account: connectionLabel(names, env.connection_id),
  };
}

/** The Research projects whose hardware a row needs a name for. */
export function researchProjectsWithHardware(environments: readonly DeployEnvironment[]): string[] {
  const ids = environments
    .filter((e) => targetKindOf(e) === "research" && e.research_project && e.research_hardware)
    .map((e) => e.research_project as string);
  return [...new Set(ids)];
}

/** Items split by where their environment runs, each keeping its order. */
export function byTargetKind<T>(items: readonly T[], envOf: (item: T) => Pick<DeployEnvironment, "kind">): Record<TargetKind, T[]> {
  return {
    kubernetes: items.filter((i) => targetKindOf(envOf(i)) === "kubernetes"),
    research: items.filter((i) => targetKindOf(envOf(i)) === "research"),
  };
}

/** The project has no product yet: the path's first step is not done. */
export function noProduct(path: { steps: readonly { id: string; state: string }[] } | null): boolean {
  const step = path?.steps.find((s) => s.id === "product");
  return !!step && step.state !== "done";
}

/** How far a running Research build is, as its record says: the step it is
 *  in (no counts: those live in the run, which the dialog follows). */
export function recordedProgress(build: Pick<IdeBuild, "status" | "step">): ResearchProgress | null {
  if (build.status !== "running") return null;
  const step = RESEARCH_STEPS.find((s) => s === build.step) ?? "prepare";
  return { step };
}
