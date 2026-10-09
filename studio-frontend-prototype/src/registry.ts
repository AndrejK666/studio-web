/* The organization's component registry (ADR-0041), as the Components page
 * reads it: every component its projects declare, where each was found, and
 * the state a person or discovery put it in.
 *
 * Pure rules behind `component-registry.tsx`, kept here for their tests. */

import type { RegistryDecision, RegistryEntry, RegistryOwner, RegistryProjectWalk } from "./api";

/** The states in the order a component moves through them. */
export const REGISTRY_STATES = ["candidate", "declared", "registered", "published", "deprecated", "rejected", "merged"] as const;

export const STATE_LABEL: Record<string, string> = {
  candidate: "could become a gear",
  declared: "declared in a project",
  registered: "registered",
  published: "published",
  deprecated: "deprecated",
  rejected: "rejected",
  merged: "merged",
};

/** The badge tone a state is drawn in. */
export const STATE_TONE: Record<string, string> = {
  candidate: "info",
  declared: "warn",
  registered: "ok",
  published: "ok",
  deprecated: "danger",
  rejected: "",
  merged: "",
};

/** What a person can do to an entry (ADR-0041 P2). */
export type RegistryAction = "register" | "reject" | "deprecate" | "restore" | "publish" | "merge" | "edit";

/** The button for each action. */
export const ACTION_LABEL: Record<RegistryAction, string> = {
  register: "Register",
  reject: "Reject",
  deprecate: "Deprecate",
  restore: "Restore",
  publish: "Publish",
  merge: "Merge into…",
  edit: "Edit",
};

/** The past tense, for the decisions history. */
export const ACTION_DONE: Record<string, string> = {
  declare: "opened a pull request declaring",
  register: "registered",
  reject: "rejected",
  deprecate: "deprecated",
  restore: "restored",
  publish: "published",
  merge: "merged",
  edit: "edited",
};

/** The actions the server allows from a state, in the order the buttons
 *  show. The same table the backend enforces; a move outside it is refused
 *  there too. */
export function allowedActions(state: string): RegistryAction[] {
  switch (state) {
    case "candidate":
    case "declared":
      return ["register", "reject", "merge", "edit"];
    case "registered":
      return ["publish", "deprecate", "merge", "edit"];
    case "published":
      return ["deprecate", "merge", "edit"];
    case "rejected":
      return ["restore", "merge", "edit"];
    case "deprecated":
      return ["restore", "merge", "edit"];
    case "merged":
      return ["edit"];
    default:
      return [];
  }
}

/** An owner in a few words: "Ada (person)", "Payments (team)". */
export function ownerLabel(o: RegistryOwner | null | undefined): string | null {
  if (!o || !o.name) return null;
  return `${o.name} (${o.kind === "person" ? "person" : "team"})`;
}

/** The entries a decision may name (a replacement, a merge target): every
 *  other entry that is not merged itself. */
export function decisionTargets(entries: readonly RegistryEntry[], self: string): string[] {
  return entries
    .filter((e) => e.state !== "merged" && e.name.toLowerCase() !== self.toLowerCase())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** One line of the decisions history. `names` turns a person id into a name. */
export function decisionLine(d: RegistryDecision, names: Record<string, string> = {}): string {
  const who = d.by_name || names[d.by] || d.by;
  const what = ACTION_DONE[d.action] ?? d.action;
  const move = d.from === d.to ? "" : ` (${d.from} → ${d.to})`;
  const details = d.details ?? {};
  const extra: string[] = [];
  if (typeof details.replaced_by === "string") extra.push(`use ${details.replaced_by} instead`);
  if (typeof details.merge_into === "string") extra.push(`into ${details.merge_into}`);
  if (typeof details.merged_from === "string") extra.push(`took in ${details.merged_from}`);
  if (typeof details.version === "string") extra.push(`version ${details.version}`);
  if (typeof details.pr_url === "string") extra.push(`pull request ${details.pr_url}`);
  else if (typeof details.branch === "string" && d.action === "declare") extra.push(`branch ${details.branch}`);
  const owner = details.owner as RegistryOwner | undefined;
  if (owner && typeof owner === "object" && owner.name) extra.push(`owner ${ownerLabel(owner)}`);
  const said = [extra.join(", "), d.reason ? `“${d.reason}”` : ""].filter(Boolean).join(" — ");
  return `${who} ${what}${move}${said ? `: ${said}` : ""}`;
}

/** What a refused decision says to a person. A 403 means only an
 *  administrator may decide; anything else is the server's own words. */
export function decisionRefusal(status: number | undefined, fallback: string): string {
  if (status === 403) return `Only an organization administrator can decide about the registry (${fallback}).`;
  return fallback;
}

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

/* ── Candidates (ADR-0041 P3) ─────────────────────────────────────────────── */

/** Code that looks like a gear and is not declared one, strongest first. */
export function candidatesOf(entries: readonly RegistryEntry[]): RegistryEntry[] {
  return entries
    .filter((e) => e.state === "candidate")
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name));
}

/** Why a candidate looks like a gear, one line per signal, heaviest first:
 *  "own REST surface: rest.rs (+3)". */
export function evidenceLines(e: Pick<RegistryEntry, "evidence">): string[] {
  return (e.evidence ?? [])
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((v) => `${v.detail} (+${v.weight})`);
}

/** Where a candidate was detected, for its row: the first detected
 *  occurrence's project and path. */
export function candidateWhere(e: RegistryEntry): string {
  const o = e.occurrences.find((x) => x.declared_in === "detected") ?? e.occurrences[0];
  if (!o) return "—";
  const project = o.project_name || o.project_id || o.repo;
  return `${project} · ${o.path}`;
}

/** The project ids a candidate was detected in, so Declare it can name one
 *  when it was found in several. */
export function detectedProjects(e: Pick<RegistryEntry, "occurrences">): string[] {
  const out: string[] = [];
  for (const o of e.occurrences) {
    if (o.declared_in === "detected" && o.project_id && !out.includes(o.project_id)) out.push(o.project_id);
  }
  return out;
}

/** What a refused Declare it says to a person: a 403 is the administrator
 *  rule, a 503 a deployment without studio-product. */
export function declareRefusal(status: number | undefined, fallback: string): string {
  if (status === 403) return `Only an organization administrator can declare a gear (${fallback}).`;
  if (status === 503) return `Declaring a gear is not available in this deployment (${fallback}).`;
  return fallback;
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
