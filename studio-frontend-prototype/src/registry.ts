/* The organization's component registry (ADR-0041), as the Components page
 * reads it: every component its projects declare, where each was found, and
 * the state a person or discovery put it in.
 *
 * Pure rules behind `component-registry.tsx`, kept here for their tests. */

import type { RegistryEntry, RegistryProjectWalk } from "./api";

/** The states in the order a component moves through them. */
export const REGISTRY_STATES = ["candidate", "declared", "registered", "published", "deprecated", "rejected"] as const;

export const STATE_LABEL: Record<string, string> = {
  candidate: "candidate",
  declared: "declared in a project",
  registered: "registered",
  published: "published",
  deprecated: "deprecated",
  rejected: "rejected",
};

/** The badge tone a state is drawn in. */
export const STATE_TONE: Record<string, string> = {
  candidate: "info",
  declared: "warn",
  registered: "ok",
  published: "ok",
  deprecated: "danger",
  rejected: "",
};

export function stateCounts(entries: readonly RegistryEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.state] = (out[e.state] ?? 0) + 1;
  return out;
}

/** The projects that declare it, by name where the server knows one. */
export function projectsOf(e: RegistryEntry): string[] {
  const seen: string[] = [];
  for (const o of e.occurrences) {
    const name = o.project_name || o.project_id || o.repo;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** Declared in more than one repository: two copies of one component, or two
 *  components sharing a name. Either way a person should look. */
export function isDuplicated(e: RegistryEntry): boolean {
  return new Set(e.occurrences.map((o) => o.repo)).size > 1;
}

export interface RegistryFilter {
  state: string | null;
  q: string;
  project: string | null;
}

export function filterEntries(entries: readonly RegistryEntry[], f: RegistryFilter): RegistryEntry[] {
  const q = f.q.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (!f.state || e.state === f.state) &&
      (!f.project || e.occurrences.some((o) => o.project_id === f.project)) &&
      (!q ||
        e.name.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q) ||
        e.occurrences.some((o) => o.path.toLowerCase().includes(q) || o.repo.toLowerCase().includes(q))),
  );
}

/** Every project the registry has seen, for the project filter. */
export function registryProjects(entries: readonly RegistryEntry[]): { id: string; name: string }[] {
  const out = new Map<string, string>();
  for (const e of entries) {
    for (const o of e.occurrences) if (o.project_id && !out.has(o.project_id)) out.set(o.project_id, o.project_name || o.project_id);
  }
  return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** One line for what the last walk did with a project. */
export function walkLine(w: RegistryProjectWalk | undefined): { text: string; failed: boolean; hint: string | null } {
  if (!w) return { text: "not read yet", failed: false, hint: null };
  if (w.error) return { text: `not read: ${w.error}`, failed: true, hint: null };
  const failed = w.repos.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    return {
      text: `${failed.length} of ${w.repos.length} repositor${w.repos.length === 1 ? "y" : "ies"} not readable`,
      failed: true,
      hint: failed.find((r) => r.hint)?.hint ?? failed[0].error ?? null,
    };
  }
  const n = w.repos.reduce((sum, r) => sum + r.components, 0);
  const fresh = w.repos.some((r) => r.status === "read");
  return { text: `${fresh ? "read" : "unchanged"} · ${n} component${n === 1 ? "" : "s"}`, failed: false, hint: null };
}
