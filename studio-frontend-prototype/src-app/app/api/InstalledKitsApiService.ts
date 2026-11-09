/**
 * What kits apply where (ADR-0068 §5, ADR-0069 §4), for the shell: a kit's
 * screens show only where the kit is installed — as a base kit, by the
 * organization, or, inside a project, by the project itself.
 *
 * The base URL and path are the ones kits-mfe's own service uses, so both read
 * one cache entry: installing a kit on a Kits tab refreshes the tabs.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';

export interface InstalledKitsSummary {
  organization_id: string;
  project_id?: string | null;
  effective: { kit_slug: string }[];
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
}
