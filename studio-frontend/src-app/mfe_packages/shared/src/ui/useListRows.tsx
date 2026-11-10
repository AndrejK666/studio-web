import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DataGridItem, DataGridLoadContext, DataGridLoadResult } from '@gears-frontx/ui-kit';
import { TEXT_SEARCH_FILTER_KEY } from './ListGrid';
import { RowsBridge } from './RowsBridge';

export interface ListRows<TItem> {
  load: (context: DataGridLoadContext) => Promise<DataGridLoadResult<TItem>>;
  found: number | null;
  rowsBridge: React.ReactElement;
}

/** A DataGrid's `load` over rows read outside it: searched and paged in memory. */
export function useListRows<TItem extends DataGridItem>(
  rows: readonly TItem[],
  search: (rows: readonly TItem[], text: string) => readonly TItem[]
): ListRows<TItem> {
  const rowsKey = useMemo(() => JSON.stringify(rows), [rows]);
  const latest = useRef({ rows, search });
  useLayoutEffect(() => {
    latest.current = { rows, search };
  }, [rows, search]);

  const [found, setFound] = useState<number | null>(null);
  const load = useCallback(
    async (context: DataGridLoadContext): Promise<DataGridLoadResult<TItem>> => {
      const text: string = context.filters?.[TEXT_SEARCH_FILTER_KEY]?.value ?? '';
      const shown = latest.current.search(latest.current.rows, text);
      setFound(shown.length);
      const { page, limit } = context.pagination ?? { page: 1, limit: shown.length };
      return { results: shown.slice((page - 1) * limit, page * limit), total: shown.length };
    },
    []
  );

  return { load, found, rowsBridge: <RowsBridge rowsKey={rowsKey} /> };
}
