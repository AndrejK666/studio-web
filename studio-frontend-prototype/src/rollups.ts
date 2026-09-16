/* ── Rollups: what a workspace or a project CONTAINS ─────────────────────────
 *
 * The portfolio and the projects table named their rows and then said almost
 * nothing about them — a workspace was a name and some avatars, a project was a
 * name and a truncated id. Neither answered the question people actually open
 * those screens with: which of these has anything in it, and which needs
 * attention. These counts answer that in the row itself, so choosing where to
 * go does not require opening three of them to find out.
 *
 * Three rules hold everywhere in this file.
 *
 * **A count that is not known yet is `null`, never 0.** The tables render `—`
 * for null. A zero that is really "the gear did not answer" or "still loading"
 * is the most expensive kind of wrong here: it says *this project is empty* to
 * someone deciding whether to look inside it.
 *
 * **One failure costs one number.** Every read is settled independently, so a
 * self-managed tenant answering 404 from outside its subtree — which is tenant
 * isolation working correctly — leaves the other columns alone.
 *
 * **Counts come from `total`, not from `length`.** Every listing here is asked
 * for a single row; the server reports how many there are. Fetching the whole
 * set to call `.length` on it would make a portfolio of ten workspaces pull
 * every finding in the organization to print ten numbers.
 */
import { api, TENANT_TYPES } from "./api";

/** What one workspace contains. */
export interface WorkspaceRollup {
  /** Child tenants of type `project`. */
  projects: number | null;
}

/** What one project contains. */
export interface ProjectRollup {
  /** Files the scan has bound to a document type, or is still deciding about. */
  documents: number | null;
  /** Open detector verdicts across those documents. */
  findings: number | null;
  /** Repositories attached in the project's settings. */
  repos: number | null;
}

/** `total` from a one-row page — the cheapest way to count a node type.
 *
 *  `total` is nullable in the contract (graph-storage has no count, so the
 *  server pages a projection and stops at a cap), and a missing total is
 *  unknown rather than zero. */
async function countNodes(token: string, type: string, scope: string): Promise<number | null> {
  const page = await api.listArtifactNodes(token, type, scope, undefined, 1);
  return page.total ?? null;
}

/** Settle a promise into a value or null, never a rejection. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/** How many projects a workspace holds.
 *
 *  Returns the children too, because the portfolio's expandable tree needs
 *  exactly this list: counting by fetching and then fetching again to expand
 *  would ask the same question twice. */
export async function workspaceRollup(
  token: string,
  workspaceId: string,
): Promise<{ rollup: WorkspaceRollup; children: { id: string; name: string }[] | null }> {
  const page = await orNull(api.tenantChildren(token, workspaceId));
  if (!page) return { rollup: { projects: null }, children: null };
  const kids = (page.items ?? [])
    .filter((t) => t.tenant_type === TENANT_TYPES.project)
    .map((t) => ({ id: t.id, name: t.name }));
  return { rollup: { projects: kids.length }, children: kids };
}

/** What one project contains: documents, findings, repositories.
 *
 *  `workspaceId` is the PARENT workspace — document bindings are stored against
 *  it and scoped to the project, which is the pairing the Documents section
 *  uses. Findings are scoped to the project tenant alone, because that is the
 *  scope the detectors write them into. */
export async function projectRollup(
  token: string,
  workspaceId: string,
  projectId: string,
): Promise<ProjectRollup> {
  const [bindings, findings, settings] = await Promise.all([
    orNull(api.docBindings(token, workspaceId, projectId, { limit: 1 })),
    orNull(countNodes(token, "spec_finding", projectId)),
    orNull(api.workspaceSettings(token, projectId)),
  ]);
  return {
    documents: bindings?.total ?? null,
    findings,
    // A project with settings and no repos really has none; a project whose
    // settings could not be read has an unknown number of them.
    repos: settings ? (settings.repos?.length ?? 0) : null,
  };
}

/** Render a rollup count. `—` for unknown, the number otherwise — including a
 *  real 0, which is a fact worth stating. */
export function rollupText(n: number | null): string {
  return n == null ? "—" : String(n);
}
