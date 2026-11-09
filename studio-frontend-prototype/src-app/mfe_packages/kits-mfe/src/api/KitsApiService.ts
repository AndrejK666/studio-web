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
  /** `base` (the platform's, for every organization), `organization`, or `project`. */
  kind: 'base' | 'organization' | 'project';
  installed_by?: string | null;
  installed_at?: string | null;
  /** A built-in kit nobody removed: installed by default. */
  by_default?: boolean;
}

export interface InstalledKits {
  organization_id: string;
  /** Set when the read named a project. */
  project_id?: string | null;
  base: InstalledKit[];
  organization: InstalledKit[];
  /** What the project installed for itself; empty for an organization's read. */
  project?: InstalledKit[];
  effective: InstalledKit[];
}

/** Whose installations a read is about: an organization, or a project in it. */
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

/** What a kit brings, by the sections of its manifest (ADR-0068 §3, §8). */
export interface KitContents {
  screens: { kind: 'tab' | 'section'; level: string; label: string; route: string | null; slot: string | null }[];
  types: { gts: string; name: string; description: string | null }[];
  rules: { name: string; description: string | null }[];
  functions: { name: string; runtime: 'wasm' | 'agent'; description: string | null }[];
  services: { name: string; description: string | null }[];
  inbox: { id: string; label: string }[];
  mcp_tools: { name: string; description: string | null }[];
  permissions: { reads: string[]; writes: string[]; listens: string[] };
  material: { path: string; description: string | null }[];
  kinds: string[];
  docs: string[];
}

/** One kit with what is inside it (GET /studio-kits/v1/catalog/{slug}). */
export interface KitDetail {
  kit: CatalogKit;
  contents: KitContents;
  /** Where the description came from: built-in, .cf-studio-kit.toml, kit.gdl — or unknown. */
  manifest: string | null;
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

  readonly describe = this.protocol(RestEndpointProtocol).queryWith<KitDetail, { slug: string }>(
    ({ slug }) => `/catalog/${encodeURIComponent(slug)}`
  );

  readonly installed = this.protocol(RestEndpointProtocol).queryWith<InstalledKits, InstalledScope>(
    (scope) => `/installed-kits?${scopeQuery(scope)}`
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

  installForProject(slug: string, projectId: string) {
    return this.protocol(RestEndpointProtocol).mutation<InstalledKit, Record<string, never>>(
      'PUT',
      `/project-kits/${encodeURIComponent(slug)}?${new URLSearchParams({ project_id: projectId })}`
    );
  }

  removeFromProject(slug: string, projectId: string) {
    return this.protocol(RestEndpointProtocol).mutation<void, void>(
      'DELETE',
      `/project-kits/${encodeURIComponent(slug)}?${new URLSearchParams({ project_id: projectId })}`
    );
  }

  removeFromOrganization(slug: string, organizationId: string) {
    return this.protocol(RestEndpointProtocol).mutation<void, void>(
      'DELETE',
      `/organization-kits/${encodeURIComponent(slug)}?${org(organizationId)}`
    );
  }
}
