/**
 * The kit library and the installer (ADR-0068 §4–5, ADR-0069 §4), over the
 * `studio-kits` gear: the catalogue, what an organization has installed, and
 * installing a kit as a base kit (the platform, for every organization) or
 * for one organization.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';

export const KITS_API_BASE_URL = '/cf/studio-kits/v1';

/** One kit in the catalogue (`KitDto`). */
export interface CatalogKit {
  slug: string;
  name: string;
  description: string;
  publisher: string;
  visibility: string;
  source: string;
  repository_url: string;
  default_version: string;
  manifest_path: string;
  /** `builtin` (in Studio's image), `official`, or `organization`. */
  shelf?: string;
  /** The levels the kit places screens on. */
  levels?: string[];
}

export interface CatalogPage {
  items: CatalogKit[];
  total: number;
}

/** One installation (`InstalledKitDto`). */
export interface InstalledKit {
  kit_slug: string;
  version: string;
  shelf: string;
  /** `base` (the platform's, for every organization) or `organization`. */
  kind: 'base' | 'organization';
  installed_by?: string | null;
  installed_at?: string | null;
  /** A built-in kit nobody removed: installed by default. */
  by_default?: boolean;
}

export interface InstalledKits {
  organization_id: string;
  base: InstalledKit[];
  organization: InstalledKit[];
  effective: InstalledKit[];
}

const org = (organizationId: string) => new URLSearchParams({ organization_id: organizationId }).toString();

export class KitsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    super({ baseURL: KITS_API_BASE_URL }, restProtocol, restEndpoints);
  }

  /** The whole catalogue: the gear pages at 200, and holds far fewer. */
  readonly catalog = this.protocol(RestEndpointProtocol).query<CatalogPage>('/catalog?limit=200');

  readonly installed = this.protocol(RestEndpointProtocol).queryWith<InstalledKits, { organizationId: string }>(
    ({ organizationId }) => `/installed-kits?${org(organizationId)}`
  );

  installBase(slug: string) {
    return this.protocol(RestEndpointProtocol).mutation<InstalledKit, Record<string, never>>(
      'PUT',
      `/base-kits/${encodeURIComponent(slug)}`
    );
  }

  removeBase(slug: string) {
    return this.protocol(RestEndpointProtocol).mutation<void, void>('DELETE', `/base-kits/${encodeURIComponent(slug)}`);
  }

  installForOrganization(slug: string, organizationId: string) {
    return this.protocol(RestEndpointProtocol).mutation<InstalledKit, Record<string, never>>(
      'PUT',
      `/organization-kits/${encodeURIComponent(slug)}?${org(organizationId)}`
    );
  }

  removeFromOrganization(slug: string, organizationId: string) {
    return this.protocol(RestEndpointProtocol).mutation<void, void>(
      'DELETE',
      `/organization-kits/${encodeURIComponent(slug)}?${org(organizationId)}`
    );
  }
}
