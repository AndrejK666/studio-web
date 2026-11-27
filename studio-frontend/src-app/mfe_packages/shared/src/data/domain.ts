/**
 * The Studio domain model as data (ADR-0066), read the one way every screen
 * shares:
 *
 * - the organization's model (`GET /types`): {@link domainTypes} /
 *   {@link useDomainTypes} — one cached read per organization, fresh for
 *   {@link DOMAIN_TYPES_STALE_TIME_MS}; the shell invalidates it when the live
 *   channel says the model changed (`domain.model_changed`), and a screen that
 *   changed the model itself calls {@link invalidateDomainTypes};
 * - a type's objects (`POST /query`): {@link domainQuery} /
 *   {@link useDomainQuery} — keyed by the organization, the type and the body,
 *   so equal queries share one read; invalidated when the live channel says
 *   objects of the type changed (`domain.objects_changed`), or by
 *   {@link invalidateDomainObjects} after a write here;
 * - every page of a query: {@link fetchDomainAll} (keyset), and
 *   {@link PageCursors} for a table that pages by number over a server that
 *   pages by cursor.
 *
 * The query reads are typed by the body's `type` (`DomainQueryOf`): written
 * as a literal, `{type: 'milestone', fields: ['name']}` is checked against the
 * generated model and its rows' `value` is a `Milestone`; a type the
 * generated model does not have (a kit's) reads untyped.
 */

import { useMemo } from 'react';
import { useApiQuery, useQueryCache, type EndpointDescriptor } from '@gears-frontx/react';
import type { DomainTypesResponse } from '../domain/DomainModelApiService';
import type {
  DomainMutation,
  DomainMutationResult,
  DomainQueryOf,
  DomainQueryRequest,
  DomainQueryResult,
  DomainResultOf,
  DomainRowOf,
} from '../domain/domainQuery';
import { domainChanged, useStudioEventRefresh } from '../tasks/liveEvents';
import { GATEWAY_BASE_URL, gateway, gatewayKey, withQuery } from './gateway';
import { fetchAllCursorPages, type AllPages } from './pages';

export const DOMAIN_MODEL_PATH = '/studio-domain-model/v1';

/** The model changes by an edit in Admin, and the live channel says so: five minutes is safe. */
export const DOMAIN_TYPES_STALE_TIME_MS = 5 * 60_000;

/** `GET /studio-domain-model/v1/types` for `orgId`; with `dormant`, the types kits left dormant too. */
export function domainTypesPath(orgId: string, { dormant = false }: { dormant?: boolean } = {}): string {
  return withQuery(`${DOMAIN_MODEL_PATH}/types`, { organization_id: orgId, include: dormant ? 'dormant' : undefined });
}

/** The organization's model: one descriptor, so one cache entry, for every reader. */
export function domainTypes<T = DomainTypesResponse>(
  orgId: string,
  options: { dormant?: boolean } = {}
): EndpointDescriptor<T> {
  return gateway().get<T>(domainTypesPath(orgId, options), { staleTime: DOMAIN_TYPES_STALE_TIME_MS });
}

/** The model read through the shared cache; idle without an organization. */
export function useDomainTypes<T = DomainTypesResponse>(
  orgId: string | null | undefined,
  { dormant = false, enabled = true }: { dormant?: boolean; enabled?: boolean } = {}
) {
  // Without an organization the descriptor is never fetched (`enabled: false`).
  const descriptor = useMemo(() => domainTypes<T>(orgId ?? '', { dormant }), [orgId, dormant]);
  return useApiQuery<T>(descriptor, { enabled: enabled && !!orgId });
}

/** What the invalidators need of `useQueryCache()`. */
export interface DomainCache {
  invalidate(key: readonly unknown[]): unknown;
  invalidateMany(filters: { queryKey: readonly unknown[] }): unknown;
}

/** Marks `orgId`'s model stale (both reads: with and without the dormant types). */
export function invalidateDomainTypes(cache: Pick<DomainCache, 'invalidate'>, orgId: string): void {
  void cache.invalidate(gatewayKey(domainTypesPath(orgId)));
  void cache.invalidate(gatewayKey(domainTypesPath(orgId, { dormant: true })));
}

const QUERY_PATH = `${DOMAIN_MODEL_PATH}/query`;
const MUTATE_PATH = `${DOMAIN_MODEL_PATH}/mutate`;

/** The key of `orgId`'s queries of `type` (a prefix of each query's own key). */
export function domainObjectsKey(orgId: string, type?: string): readonly unknown[] {
  const base = [GATEWAY_BASE_URL, 'POST', QUERY_PATH, orgId];
  return type === undefined ? base : [...base, type];
}

/** `POST /query` as a plain call, uncached: for a read that must not be shared (or a cursor walk). */
export function domainQuerySend<T = DomainQueryResult>(orgId: string) {
  return gateway().send<T, DomainQueryRequest & { cursor?: string }>('POST', withQuery(QUERY_PATH, { organization_id: orgId }));
}

/**
 * `POST /query` with `body`: a read, so a cacheable descriptor keyed by its
 * body. `T` adds fields to the answer; `N`, the body's type, is inferred.
 */
export function domainQuery<T extends Record<string, unknown> = Record<string, unknown>, N extends string = string>(
  orgId: string,
  body: DomainQueryOf<N>
): EndpointDescriptor<DomainResultOf<N> & T> {
  const send = domainQuerySend<DomainResultOf<N> & T>(orgId);
  return {
    key: [...domainObjectsKey(orgId, body.type), body],
    fetch: ({ signal } = {}) => send.fetch(body, { signal }),
  };
}

/** `POST /mutate` for `orgId`; invalidate the types it wrote afterwards. */
export function domainMutate(orgId: string) {
  return gateway().send<DomainMutationResult, DomainMutation>('POST', withQuery(MUTATE_PATH, { organization_id: orgId }));
}

/** Marks every cached query of `type` (of every type, without one) stale. */
export function invalidateDomainObjects(cache: Pick<DomainCache, 'invalidateMany'>, orgId: string, type?: string): void {
  void cache.invalidateMany({ queryKey: domainObjectsKey(orgId, type) });
}

/**
 * A query through the shared cache, read again when objects of its type
 * change (`domain.objects_changed`; with `model`, also when the model does).
 * `body: null` keeps it idle. Must render inside an MFE (it listens on the
 * shell's live channel).
 */
export function useDomainQuery<T extends Record<string, unknown> = Record<string, unknown>, N extends string = string>(
  orgId: string | null | undefined,
  body: DomainQueryOf<N> | null,
  {
    enabled = true,
    live = true,
    watch = [],
    model = false,
  }: {
    enabled?: boolean;
    /** Read again on `domain.objects_changed` for the type (default). */
    live?: boolean;
    /** More types whose changes this answer shows (an `include`'s targets). */
    watch?: readonly string[];
    model?: boolean;
  } = {}
) {
  const bodyKey = body ? JSON.stringify(body) : '';
  const descriptor = useMemo(
    () => domainQuery<T, N>(orgId ?? '', body ?? ({ type: '' } as DomainQueryOf<N>)),
    // The body by value: a literal built in render is the same query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orgId, bodyKey]
  );
  const result = useApiQuery<DomainResultOf<N> & T>(descriptor, { enabled: enabled && !!orgId && !!body });
  const cache = useQueryCache();
  const watchKey = watch.join('\n');
  const matches = useMemo(
    () => domainChanged(body ? [body.type, ...watch] : [], { model }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bodyKey, watchKey, model]
  );
  useStudioEventRefresh(
    live ? matches : NEVER,
    () => {
      if (orgId && body) invalidateDomainObjects(cache, orgId, body.type);
    }
  );
  return result;
}

const NEVER = () => false;

/** Every row of a query, page after page by cursor (at most `max`). */
export async function fetchDomainAll<N extends string = string>(
  orgId: string,
  body: DomainQueryOf<N>,
  { max, signal }: { max?: number; signal?: AbortSignal } = {}
): Promise<AllPages<DomainRowOf<N>>> {
  const send = domainQuerySend<DomainResultOf<N>>(orgId);
  const first: DomainQueryOf<N> = { ...body, limit: body.limit ?? 200 };
  delete first.offset;
  return fetchAllCursorPages(
    (cursor, s) => send.fetch(cursor ? { ...first, cursor } : first, { signal: s }),
    { max, signal }
  );
}

/** A query as {@link PageCursors} pages it: by `offset`, or by `cursor` once known. */
export interface PagedQuery {
  offset?: number;
  limit?: number;
  cursor?: string;
}

/**
 * Where each page of a query starts, as the page before it said. A table
 * pages by number; the server pages by cursor (the platform's only way), so a
 * page that follows one already read is asked by cursor, and only a jump to a
 * page nobody has read yet goes by offset.
 */
export class PageCursors<Q extends PagedQuery = PagedQuery> {
  private readonly starts = new Map<string, Map<number, string>>();

  private static key(q: PagedQuery): string {
    return JSON.stringify({ ...q, offset: undefined, limit: undefined, cursor: undefined });
  }

  /** `q` as sent: by cursor when its offset is a known page start. */
  place(q: Q): Q {
    const at = q.offset ?? 0;
    const cursor = at > 0 ? this.starts.get(PageCursors.key(q))?.get(at) : undefined;
    if (!cursor) return q;
    const out: Q = { ...q, cursor };
    delete out.offset;
    return out;
  }

  /** What a page of `q` (as built, with its offset) said about the next one. */
  note(q: Q, rows: number, next: string | null | undefined): void {
    if (!next) return;
    const key = PageCursors.key(q);
    const starts = this.starts.get(key) ?? new Map<number, string>();
    starts.set((q.offset ?? 0) + rows, next);
    this.starts.set(key, starts);
  }
}
