/**
 * The kit library's reads (ADR-0068 §4): the catalogue the `studio-kits` gear
 * keeps. Installing a kit as a base kit or for an organization (ADR-0069 §4)
 * is not served yet; this reads what there is to install.
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
}

export interface CatalogPage {
  items: CatalogKit[];
  total: number;
}

export class KitsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    super({ baseURL: KITS_API_BASE_URL }, restProtocol, restEndpoints);
  }

  /** The whole catalogue: the gear pages at 200, and holds far fewer. */
  readonly catalog = this.protocol(RestEndpointProtocol).query<CatalogPage>('/catalog?limit=200');
}
