/**
 * One way to reach a gear: through the gateway (`/cf`), with the gear named in
 * the path. Every read of the same endpoint then carries the same descriptor
 * key, `['/cf', 'GET', '/studio-…/v1/…']`, whichever screen or MFE asks — so
 * the shared query cache answers the second reader from the first one's read,
 * and one invalidation reaches every reader.
 *
 * A service that set its own base (`/cf/studio-foo/v1`) keyed the same
 * endpoint `['/cf/studio-foo/v1', 'GET', '/bar']`, a different entry for the
 * same bytes. New reads go through {@link gateway}; a service of an MFE can
 * keep its own class and still take the convention by passing
 * {@link GATEWAY_BASE_URL} and full paths.
 *
 * Freshness: a read is fresh for {@link DEFAULT_STALE_TIME_MS} (the query
 * client's default) unless it says otherwise. A screen that re-reads right
 * after its own write invalidates what it wrote ({@link invalidateGateway}),
 * rather than reading everything with `staleTime: 0`.
 */

import {
  BaseApiService,
  RestEndpointProtocol,
  RestProtocol,
  apiRegistry,
  type EndpointDescriptor,
  type MutationDescriptor,
} from '@gears-frontx/react';

/** The gateway prefix every gear's routes hang off. */
export const GATEWAY_BASE_URL = '/cf';

/** How long a read is fresh when nothing says otherwise (the query client's own default). */
export const DEFAULT_STALE_TIME_MS = 30_000;

type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Reads and writes by full gateway path. */
export class GatewayApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 60000 });
    super({ baseURL: GATEWAY_BASE_URL }, restProtocol, new RestEndpointProtocol(restProtocol));
  }

  /** `GET path`, keyed `['/cf', 'GET', path]`. */
  get<T>(path: string, options?: { staleTime?: number; gcTime?: number }): EndpointDescriptor<T> {
    return this.protocol(RestEndpointProtocol).query<T>(path, options);
  }

  /** A write (or a read sent as a POST) to `path`. */
  send<T, B>(method: WriteMethod, path: string): MutationDescriptor<T, B> {
    return this.protocol(RestEndpointProtocol).mutation<T, B>(method, path);
  }
}

/** The gateway service, registered in this MFE's registry the first time it is asked for. */
export function gateway(): GatewayApiService {
  if (!apiRegistry.has(GatewayApiService)) apiRegistry.register(GatewayApiService);
  return apiRegistry.getService(GatewayApiService);
}

/** The descriptor key of `GET path` through the gateway. */
export function gatewayKey(path: string): readonly unknown[] {
  return [GATEWAY_BASE_URL, 'GET', path];
}

/** A path with its query string: `path?a=1&b=2`, empty and undefined values left out. */
export function withQuery(path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  const q = search.toString();
  return q ? `${path}${path.includes('?') ? '&' : '?'}${q}` : path;
}

/** What {@link invalidateGateway} needs of `useQueryCache()`. */
export interface InvalidatingCache {
  invalidate(key: readonly unknown[]): unknown;
}

/**
 * Marks the gateway reads of `paths` stale: their readers on screen read
 * again, and the next `fetch()` of any of them goes to the server.
 */
export function invalidateGateway(cache: InvalidatingCache, ...paths: string[]): void {
  for (const path of paths) void cache.invalidate(gatewayKey(path));
}
