/**
 * What kits apply to an organization (ADR-0068 §5, ADR-0069 §4), for the
 * shell: a kit's screens show only where the kit is installed — as a base kit
 * or by the organization itself.
 *
 * The base URL and path are the ones kits-mfe's own service uses, so both read
 * one cache entry: installing a kit on Platform › Kits refreshes the tabs.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';

export interface InstalledKitsSummary {
  organization_id: string;
  effective: { kit_slug: string }[];
}

export class InstalledKitsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    super({ baseURL: '/cf/studio-kits/v1' }, restProtocol, restEndpoints);
  }

  readonly installed = this.protocol(RestEndpointProtocol).queryWith<
    InstalledKitsSummary,
    { organizationId: string }
  >(({ organizationId }) => `/installed-kits?${new URLSearchParams({ organization_id: organizationId })}`);
}
