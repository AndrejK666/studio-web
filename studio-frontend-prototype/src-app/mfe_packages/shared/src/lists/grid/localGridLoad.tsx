import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  useDataGrid,
  type DataGridItem,
  type DataGridLoadContext,
  type DataGridLoadResult,
} from '@gears-frontx/ui-kit';
import { searchQuery } from './dataGridFilters';

/** How a list whose rows are all in memory answers the grid's search, filters and order. */
export interface LocalGridOptions<T> {
  /**
   * The text the search box matches, case-insensitively, as a substring of any
   * of the strings. Without it the search keeps every row.
   */
  search?: (row: T) => ReadonlyArray<string | null | undefined> | string;
  /** Keeps a row under the grid's other filters (`context.filters`). Without it every row stays. */
  filter?: (row: T, filters: NonNullable<DataGridLoadContext['filters']>) => boolean;
  /**
   * Per column id: how the order plugin sorts, ascending. A column without one
   * is not sortable here; list it in `ListGrid`'s `unsortable`.
   */
  compare?: Readonly<Record<string, (a: T, b: T) => number>>;
}

/** The rows the grid's search and filters keep, in its order. */
export function shownRows<T>(
  rows: readonly T[],
  context: DataGridLoadContext,
  options: LocalGridOptions<T>
): T[] {
  const query = searchQuery(context.filters).toLocaleLowerCase();
  const filters = context.filters ?? {};
  const kept = rows.filter((row) => {
    if (query && options.search) {
      const text = options.search(row);
      const texts = typeof text === 'string' ? [text] : text;
      if (!texts.some((entry) => entry?.toLocaleLowerCase().includes(query))) return false;
    }
    return options.filter ? options.filter(row, filters) : true;
  });
  const order = context.order?.[0];
  const compare = order && options.compare?.[order.column];
  if (!order || !compare) return kept;
  const sign = order.direction === 'desc' ? -1 : 1;
  // `sort` is stable, so equal rows keep the list's own order in both directions.
  return kept.sort((a, b) => sign * compare(a, b));
}

/** One page of `shownRows`, as `load` returns it. */
export function pageOfRows<T>(shown: readonly T[], context: DataGridLoadContext): DataGridLoadResult<T> {
  const { page, limit } = context.pagination ?? { page: 1, limit: shown.length };
  return { results: shown.slice((page - 1) * limit, page * limit), total: shown.length };
}

export interface LocalGridLoad<T> {
  /** The grid's `load`, stable for the hook's life. */
  load: (context: DataGridLoadContext) => Promise<DataGridLoadResult<T>>;
  /** The rows the last load kept, every page of them; `null` before the first. For a footer's count. */
  shown: readonly T[] | null;
  /** Render inside the `DataGrid`: a change of `rows` reloads the grid, keeping its search, filters and page size. */
  reloadBridge: React.ReactElement;
}

const ReloadOnChange: React.FC<{ rows: unknown }> = ({ rows }) => {
  const grid = useDataGrid();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void grid.triggerLoad();
  }, [grid, rows]);
  return null;
};

/**
 * A `load` over rows already in memory: the grid's search, filters, order and
 * page applied to them here, as Specs does (#689). The grid keeps `load` in a
 * ref, so new rows reach it through `reloadBridge`, not through a new `load`.
 * Keep `rows` the same array while nothing changed (`useMemo`): every new one
 * is a reload. `options` may be a new object each render; the last one is read.
 */
export function useLocalGridLoad<T extends DataGridItem>(
  rows: readonly T[],
  options: LocalGridOptions<T> = {}
): LocalGridLoad<T> {
  const current = useRef({ rows, options });
  // A layout effect runs before the grid's own effects, so a reload `reloadBridge` starts reads these rows.
  useLayoutEffect(() => {
    current.current = { rows, options };
  });
  const [shown, setShown] = useState<readonly T[] | null>(null);
  const load = useCallback(async (context: DataGridLoadContext) => {
    const kept = shownRows(current.current.rows, context, current.current.options);
    context.signal?.throwIfAborted();
    setShown(kept);
    return pageOfRows(kept, context);
  }, []);
  return { load, shown, reloadBridge: <ReloadOnChange rows={rows} /> };
}
