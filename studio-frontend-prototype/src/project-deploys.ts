/* A project's Deploys tab (ADR-0043, project side): the rules behind it, kept
 * apart from the React for their tests. */

import type { Deployment } from "./api";

/** The newest deployment of the project in each environment, whatever its
 *  state: the server lists them newest first. */
export function latestByEnvironment(deployments: readonly Deployment[]): Map<string, Deployment> {
  const out = new Map<string, Deployment>();
  for (const d of deployments) if (!out.has(d.environment_id)) out.set(d.environment_id, d);
  return out;
}

/** The profiles bound to an environment, as the line under it says them. */
export function profilesBoundTo(bindings: readonly { profile: string; environment_id: string }[], environment: string): string[] {
  return bindings.filter((b) => b.environment_id === environment).map((b) => b.profile);
}
