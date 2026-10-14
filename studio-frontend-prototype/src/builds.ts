/* The project's builds (ADR-0045, phase 1): the CI runs the artifact sync
 * reads from the project's repositories, as build records.
 *
 * The portal does not build. CI and the IDE do; this is what was built,
 * where, and how it went. Phase 1 reads CI runs only; builds the IDE reports,
 * and the Build and Deploy actions, come later. */

import type { ArtifactNode } from "./api";

/** One CI run, as the Builds tab shows it. */
export interface BuildRun {
  id: string;
  workflow: string;
  title: string;
  branch: string | null;
  sha: string;
  shortSha: string;
  event: string | null;
  status: BuildStatus;
  author: string | null;
  url: string | null;
  number: number | null;
  attempt: number | null;
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export type BuildStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "skipped";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** A run's status in a build's words, from the provider's `status` and
 *  `conclusion`. A run that has not finished is `running` or `queued`. */
export function buildStatus(status: string | null, conclusion: string | null): BuildStatus {
  if (status && status !== "completed") {
    return status === "in_progress" ? "running" : "queued";
  }
  switch (conclusion) {
    case "success":
      return "passed";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "neutral":
      return "skipped";
    default:
      return "failed";
  }
}

/** The `workflow_run` nodes as runs, newest first. */
export function buildsOf(nodes: readonly ArtifactNode[]): BuildRun[] {
  const runs = nodes.map((n): BuildRun => {
    const v = n.value;
    const sha = str(v.sha) ?? "";
    return {
      id: n.instance_id,
      workflow: str(v.workflow) ?? "workflow",
      title: str(v.title) ?? "",
      branch: str(v.branch),
      sha,
      shortSha: str(v.short_sha) ?? sha.slice(0, 7),
      event: str(v.event),
      status: buildStatus(str(v.status), str(v.conclusion)),
      author: str(v.author),
      url: str(v.url),
      number: num(v.number),
      attempt: num(v.attempt),
      createdAt: str(v.created_at),
      startedAt: str(v.started_at),
      updatedAt: str(v.updated_at),
    };
  });
  return runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** The workflows the runs belong to, with how many runs each, most first:
 *  the one that runs most is usually the one that builds. */
export function workflowsOf(runs: readonly BuildRun[]): { name: string; runs: number }[] {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.workflow, (counts.get(r.workflow) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, n]) => ({ name, runs: n }))
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

/** The branch a product is built from: `main` or `master` when the runs
 *  have one, else the branch with most runs. */
export function mainBranch(runs: readonly BuildRun[]): string | null {
  const branches = new Set(runs.map((r) => r.branch).filter((b): b is string => !!b));
  for (const b of ["main", "master"]) if (branches.has(b)) return b;
  const counts = new Map<string, number>();
  for (const r of runs) if (r.branch) counts.set(r.branch, (counts.get(r.branch) ?? 0) + 1);
  let best: string | null = null;
  for (const [b, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = b;
  return best;
}

/** The newest finished run on `branch`: what "does it build" answers. */
export function latestFinished(runs: readonly BuildRun[], branch: string | null): BuildRun | null {
  return runs.find((r) => r.branch === branch && r.status !== "queued" && r.status !== "running") ?? null;
}

/** How long a run took, or has been running: `6 min`, `40 s`, `1 h 5 min`.
 *  Null when it has not started. */
export function buildDuration(r: Pick<BuildRun, "startedAt" | "createdAt" | "updatedAt" | "status">, now = Date.now()): string | null {
  const start = Date.parse(r.startedAt ?? r.createdAt ?? "");
  if (Number.isNaN(start)) return null;
  const live = r.status === "running" || r.status === "queued";
  const end = live ? now : Date.parse(r.updatedAt ?? "");
  if (Number.isNaN(end) || end < start) return null;
  const s = Math.round((end - start) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The line above the table: what the newest build of the main branch says. */
export function buildsHeadline(runs: readonly BuildRun[], workflow: string | null): string {
  const shown = workflow ? runs.filter((r) => r.workflow === workflow) : runs;
  if (shown.length === 0) return "No CI runs yet.";
  const branch = mainBranch(shown);
  const last = latestFinished(shown, branch);
  if (!branch || !last) return `${shown.length} run${shown.length === 1 ? "" : "s"}; none finished on a main branch yet.`;
  const what = workflow ? workflow : last.workflow;
  switch (last.status) {
    case "passed":
      return `${branch} builds: ${what} passed on ${last.shortSha}.`;
    case "failed":
      return `${branch} does not build: ${what} failed on ${last.shortSha}.`;
    default:
      return `${branch}: the last ${what} run on ${last.shortSha} was ${last.status}.`;
  }
}

/** The badge tone for a status, in the portal's badge classes. */
export function statusTone(s: BuildStatus): string {
  switch (s) {
    case "passed":
      return "ok";
    case "failed":
      return "danger";
    case "running":
    case "queued":
      return "info";
    default:
      return "neutral";
  }
}
