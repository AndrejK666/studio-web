/* The environments of the one deploy dialog (#1053) as a dense list: one
 * row each, with what runs there and the newest build that can go there.
 * Those where nothing can go yet fold into one line; a search narrows both
 * once there are many. */

import type { Deployment, DeployEnvironment } from "../api/types";
import type { IdeBuild } from "@constructor-studio/mfe-shared";
import { deployableBuilds, latestByEnvironment } from "./project-deploys";

/** From how many environments the dialog offers a search. */
export const SEARCH_FROM = 7;

export interface TargetRow {
  env: DeployEnvironment;
  /** The newest build that may go there; absent: nothing can go yet. */
  newest?: IdeBuild;
  /** The newest deployment there, whatever its state. */
  latest?: Deployment;
}

export interface Targets {
  /** Where something can go, or the environment the dialog was opened on. */
  open: TargetRow[];
  /** Where nothing built can go yet: one folded line. */
  folded: TargetRow[];
}

/** Does `env` match what was typed: its name or description, any case. */
function matches(env: DeployEnvironment, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || env.name.toLowerCase().includes(q) || (env.description ?? "").toLowerCase().includes(q);
}

/** The dialog's environments: those something can go to first (the one it
 *  was opened on first of all, then those running something, then by
 *  name), the rest folded. */
export function deployTargets(
  environments: readonly DeployEnvironment[],
  builds: readonly IdeBuild[],
  deployments: readonly Deployment[],
  focused: string | null,
  query = "",
): Targets {
  const latest = latestByEnvironment(deployments);
  const rows: TargetRow[] = environments
    .filter((e) => matches(e, query))
    .map((env) => ({ env, newest: deployableBuilds(builds, env)[0], latest: latest.get(env.id) }));
  const rank = (r: TargetRow) => (r.env.id === focused ? 0 : r.latest ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || a.env.name.localeCompare(b.env.name));
  return {
    open: rows.filter((r) => r.newest || r.env.id === focused),
    folded: rows.filter((r) => !r.newest && r.env.id !== focused),
  };
}
