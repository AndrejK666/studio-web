/**
 * Reading every page of a paged list: the loop each screen used to copy.
 *
 * - {@link fetchAllPages} walks `offset`/`limit` pages until a short page, the
 *   reported `total`, or the `max` ceiling;
 * - {@link fetchAllCursorPages} walks keyset pages by `next_cursor`;
 * - {@link useAllPages} is either, cached under a key like any other read.
 */

import { useApiQuery } from '@gears-frontx/react';

/** One page of an offset-paged list, as the gears answer it. */
export interface OffsetPage<T> {
  items?: T[] | null;
  /** Matches across every page, when the gear counts them. */
  total?: number | null;
}

export interface AllPagesOptions {
  /** Rows asked for per page (the gear's ceiling is usually 200). */
  pageSize?: number;
  /** Never more rows than this, however many the gear holds. */
  max?: number;
  signal?: AbortSignal;
  /** The next offset: one page further (default), or the rows read so far (a gear whose pages may come short). */
  advance?: 'page' | 'rows';
}

/** Every row of the list and the gear's total (the rows read when it gave none). */
export interface AllPages<T> {
  items: T[];
  total: number;
  /** False when `max` stopped the walk before the last row. */
  complete: boolean;
}

const DEFAULT_PAGE = 200;
const DEFAULT_MAX = 10_000;

/**
 * Reads `read(offset, limit)` page after page and returns every row. Stops at
 * an empty page, at the gear's `total` (without one, at a page shorter than
 * asked for), or at `max` rows. Offsets step by `pageSize`.
 */
export async function fetchAllPages<T>(
  read: (offset: number, limit: number, signal?: AbortSignal) => Promise<OffsetPage<T>>,
  { pageSize = DEFAULT_PAGE, max = DEFAULT_MAX, signal, advance = 'page' }: AllPagesOptions = {}
): Promise<AllPages<T>> {
  const items: T[] = [];
  let total: number | null = null;
  for (let offset = 0; ; ) {
    signal?.throwIfAborted();
    const page = await read(offset, pageSize, signal);
    const got = page.items ?? [];
    items.push(...got);
    offset = advance === 'rows' ? items.length : offset + pageSize;
    if (typeof page.total === 'number') total = page.total;
    // An empty page ends it (a server that ignores the parameters must not
    // spin forever); so does the gear's total, or, without one, a short page.
    const done = got.length === 0 || (total !== null ? items.length >= total : got.length < pageSize);
    if (done) return { items, total: total ?? items.length, complete: true };
    if (items.length >= max) return { items: items.slice(0, max), total: total ?? items.length, complete: false };
  }
}

/** One page of a keyset-paged list. */
export interface CursorPage<T> {
  items?: T[] | null;
  total?: number | null;
  /** Where the next page starts; absent or null on the last one. */
  next_cursor?: string | null;
}

/** Reads `read(cursor)` from the first page until no `next_cursor` is left, or `max` rows. */
export async function fetchAllCursorPages<T>(
  read: (cursor: string | undefined, signal?: AbortSignal) => Promise<CursorPage<T>>,
  { max = DEFAULT_MAX, signal }: Omit<AllPagesOptions, 'pageSize' | 'advance'> = {}
): Promise<AllPages<T>> {
  const items: T[] = [];
  let total: number | null = null;
  let cursor: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await read(cursor, signal);
    const got = page.items ?? [];
    items.push(...got);
    if (typeof page.total === 'number') total = page.total;
    const next = page.next_cursor ?? undefined;
    if (!next || got.length === 0) return { items, total: total ?? items.length, complete: true };
    if (items.length >= max) return { items: items.slice(0, max), total: total ?? items.length, complete: false };
    cursor = next;
  }
}

/**
 * Every page of a list as one cached read: `key` names it in the shared query
 * cache (invalidate it after a write), `read` is one page.
 */
export function useAllPages<T>(
  key: readonly unknown[],
  read: (offset: number, limit: number, signal?: AbortSignal) => Promise<OffsetPage<T>>,
  options: Omit<AllPagesOptions, 'signal'> & { enabled?: boolean; staleTime?: number } = {}
) {
  const { enabled, staleTime, ...paging } = options;
  return useApiQuery<AllPages<T>>(
    {
      key: ['all-pages', ...key],
      fetch: ({ signal } = {}) => fetchAllPages(read, { ...paging, signal }),
    },
    { ...(enabled === undefined ? {} : { enabled }), ...(staleTime === undefined ? {} : { staleTime }) }
  );
}
