/**
 * What kits apply where (ADR-0068 §5, ADR-0069 §4), for the shell: a kit's
 * screens show only where the kit is installed — as a base kit, by the
 * organization, or, inside a project, by the project itself.
 *
 * The base URL and path are the ones kits-mfe's own service uses, so both read
 * one cache entry: installing a kit on a Kits tab refreshes the tabs.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';

/** One micro-frontend package of a kit, as `GET /studio-kits/v1/mfe-manifests` lists it. */
export interface KitMfeManifest {
  kit_slug: string;
  version: string;
  package: string;
  /** Where the package's files are served, through the gateway, ending in `/`. */
  base_path: string;
  /** The package's `mfe-manifest.json`; null when it does not read. */
  config: unknown;
  /** Why `config` is null. */
  error?: string | null;
}

export interface InstalledKitsSummary {
  organization_id: string;
  project_id?: string | null;
  effective: {
    kit_slug: string;
    version?: string;
    /** The kit's icon (#1081): `lucide:<name>`, or a path in its bundle served at `icon_url`. */
    icon?: string | null;
    /** Where a bundled icon is served; null for a lucide one. */
    icon_url?: string | null;
    /**
     * Whether this deployment runs the kit (ADR-0079 §5). `false` for a kit
     * the deployment's composition switched off: its routes answer
     * `KIT_NOT_INSTALLED`, so its screens show nowhere. Absent (an older
     * backend): it runs.
     */
    available_in_deployment?: boolean;
  }[];
}

type EffectiveKit = InstalledKitsSummary['effective'][number];

/** Whether the deployment runs this installed kit: only an explicit `false` says no. */
export function runsInDeployment(kit: EffectiveKit): boolean {
  return kit.available_in_deployment !== false;
}

/**
 * The slugs of the kits that apply where the summary is about and that the
 * deployment runs: an installed kit the deployment switched off counts as not
 * installed, so its tabs, menu items and routes go the way a missing kit's do.
 */
export function runningKits(summary: InstalledKitsSummary): string[] {
  return summary.effective.filter(runsInDeployment).map((k) => k.kit_slug);
}

/** The slugs of installed kits the deployment does not run. */
export function kitsOffInDeployment(summary: InstalledKitsSummary): string[] {
  return summary.effective.filter((k) => !runsInDeployment(k)).map((k) => k.kit_slug);
}

export interface KitMfeManifestList {
  organization_id: string;
  project_id?: string | null;
  items: KitMfeManifest[];
  total: number;
}

/** An organization, or a project in it: the project's read includes its organization's and the base kits. */
export interface InstalledScope {
  organizationId?: string;
  projectId?: string;
}

function scopeQuery({ organizationId, projectId }: InstalledScope): string {
  const q = new URLSearchParams();
  if (projectId) q.set('project_id', projectId);
  else if (organizationId) q.set('organization_id', organizationId);
  return q.toString();
}

export class InstalledKitsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    super({ baseURL: '/cf/studio-kits/v1' }, restProtocol, restEndpoints);
  }

  readonly installed = this.protocol(RestEndpointProtocol).queryWith<InstalledKitsSummary, InstalledScope>(
    (scope) => `/installed-kits?${scopeQuery(scope)}`
  );

  /** The micro-frontends of the kits effective in the scope (ADR-0068 phase 5): `mfe/runtimeKits.ts`. */
  readonly mfeManifests = this.protocol(RestEndpointProtocol).queryWith<KitMfeManifestList, InstalledScope>(
    (scope) => `/mfe-manifests?${scopeQuery(scope)}`
  );
}
