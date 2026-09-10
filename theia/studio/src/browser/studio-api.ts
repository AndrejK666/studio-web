import { Endpoint } from '@theia/core/lib/browser/endpoint';

/**
 * Resolve the same-origin session-gate endpoint through Theia's public URL
 * helper. In Kubernetes the IDE is reverse-proxied below
 * `/studio/{sessionId}/`; an origin-rooted `/studio-api` request bypasses that
 * proxy and lands in the portal SPA instead. Endpoint preserves the active
 * Theia pathname, while still resolving to `/studio-api/...` for standalone
 * root deployments.
 */
export function studioApiUrl(path: string, location: Endpoint.Location = self.location): string {
    const queryIndex = path.indexOf('?');
    const pathname = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
    const query = queryIndex >= 0 ? path.slice(queryIndex) : '';
    const gearPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    const endpoint = new Endpoint(
        { path: `studio-api/${gearPath}` },
        location,
    ).getRestUrl().toString();
    return endpoint + query;
}

/** Server-side ceiling on `limit` (studio-backend `src/pagination.rs`). */
const MAX_PAGE = 200;

/** Latest portal-issued API context, kept in memory and shared by the Studio
 * browser widgets that call backend gears through the session gate. */
export const StudioApi = {
    token: '' as string,
    /** Tenant scope from the portal handshake (`studio.init` workspaceId). */
    scope: '' as string,
    scoped(path: string): string {
        if (!StudioApi.scope) {
            return path;
        }
        const sep = path.includes('?') ? '&' : '?';
        return `${path}${sep}scope=${encodeURIComponent(StudioApi.scope)}`;
    },
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
        return fetch(studioApiUrl(path), {
            ...init,
            headers: {
                ...(init.headers ?? {}),
                Authorization: `Bearer ${StudioApi.token}`,
                'Content-Type': 'application/json',
            },
        });
    },
    /**
     * Walk a paged list endpoint to completion and return every item.
     *
     * The backend list contract is `?offset=&limit=` -> `{ [key]: [...], total }`
     * and defaults to 50 per page, so a widget that lays out a whole graph has
     * to ask for the rest — a plain `fetch` of the collection silently renders
     * the first page only. `total` is the count before paging, so the walk
     * stops as soon as it has that many.
     */
    async fetchAllPages<T>(path: string, key: string): Promise<T[]> {
        const separator = path.includes('?') ? '&' : '?';
        const items: T[] = [];
        for (let offset = 0; ; offset += MAX_PAGE) {
            const res = await StudioApi.fetch(`${path}${separator}offset=${offset}&limit=${MAX_PAGE}`);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const body = await res.json() as Record<string, unknown>;
            const page = (body[key] as T[] | undefined) ?? [];
            items.push(...page);
            const total = typeof body.total === 'number' ? body.total : items.length;
            // An empty page also terminates: a server that ignores the
            // parameters, or a collection shrinking under a concurrent write,
            // must not spin forever.
            if (page.length === 0 || items.length >= total) {
                return items;
            }
        }
    },
};
