/**
 * What a kit's page lists under Contents: its files, the routes it claims, the reads it needs
 * and the gears it relies on, all read from `GET /studio-kits/v1/catalog/{slug}`.
 */

import type { CatalogKit, KitContents } from '../api/KitsApiService';

/** A route as `METHOD /path`, split. */
export interface Route {
  method: string;
  path: string;
  /** The gear that serves it (`studio-usage`), when the path names one. */
  gear: string | null;
}

/** The gear a `/studio-<gear>/v1/...` path is served by. */
export function gearOf(path: string): string | null {
  const m = /^\/(studio-[a-z0-9-]+)\/v\d+\//.exec(path);
  return m ? m[1] : null;
}

/** `METHOD /path` split; a grant that is not a route (a GTS type) has no method. */
export function routeOf(grant: string): Route {
  const space = grant.indexOf(' ');
  if (space > 0 && grant[space + 1] === '/') {
    const path = grant.slice(space + 1);
    return { method: grant.slice(0, space), path, gear: gearOf(path) };
  }
  return { method: '', path: grant, gear: null };
}

/** The write routes the kit claims of its gears (ADR-0071 §2), in the manifest's order. */
export function writeRoutes(c: KitContents): Route[] {
  const seen = new Set<string>();
  const out: Route[] = [];
  for (const claim of c.gears ?? []) {
    for (const r of claim.routes) {
      if (seen.has(r)) continue;
      seen.add(r);
      out.push({ ...routeOf(r), gear: claim.gear });
    }
  }
  return out;
}

/** What the kit reads: the gears' routes its screens call, or types. */
export function readsOf(c: KitContents): Route[] {
  return c.permissions.reads.map(routeOf);
}

/** A gear the kit relies on: one it claims something of, one whose routes it calls, or both. */
export interface GearUse {
  gear: string;
  /** It claims types, tools or write routes of the gear. */
  claims: boolean;
  /** Its permissions name routes of the gear. */
  calls: boolean;
  types: string[];
  tools: string[];
}

/** Every gear the kit relies on: the ones it claims first, then the ones it only calls. */
export function gearsOf(c: KitContents): GearUse[] {
  const out = new Map<string, GearUse>();
  const at = (gear: string) => {
    let use = out.get(gear);
    if (!use) {
      use = { gear, claims: false, calls: false, types: [], tools: [] };
      out.set(gear, use);
    }
    return use;
  };
  for (const claim of c.gears ?? []) {
    const use = at(claim.gear);
    use.claims = true;
    use.types.push(...claim.types);
    use.tools.push(...claim.mcp_tools);
  }
  for (const grant of [...c.permissions.reads, ...c.permissions.writes]) {
    const gear = routeOf(grant).gear;
    if (gear) at(gear).calls = true;
  }
  return [...out.values()];
}

/** A version that is a commit, shortened as the archive's name has it. */
export function shortVersion(version: string): string {
  return /^[0-9a-f]{40}$/i.test(version) ? version.slice(0, 12) : version;
}

/** The archive's file name, as the server names it: `<slug>-<version>.tar.gz`. */
export function archiveName(kit: Pick<CatalogKit, 'slug' | 'default_version'>): string {
  const version = shortVersion(kit.default_version).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${kit.slug}-${version}.tar.gz`;
}

/** The name a `kit.gdl` is saved under: one per kit. */
export function gdlName(slug: string): string {
  return `${slug}.kit.gdl`;
}
