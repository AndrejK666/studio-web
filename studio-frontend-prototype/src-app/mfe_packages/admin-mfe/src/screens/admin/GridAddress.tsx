/**
 * A grid's search, one-choice filters and order kept in the address under a
 * prefix, as the Admin lists kept them with `useListState` before they moved
 * onto the kit's DataGrid (#1076): a reload, a shared link or Back opens the
 * list as it was. The grid itself keeps its state in memory; this bridge seeds
 * it from the address once, and `writeGridAddress`, called from the list's
 * `load`, writes what the grid asks for back. Leaving the screen takes the
 * list's part out of the address, as `useListState` did.
 */

import React, { useEffect } from 'react';
import {
  useDataGrid,
  type DataGridFiltersPluginApi,
  type DataGridLoadContext,
  type DataGridOrderPluginApi,
  type DataGridTextSearchPluginApi,
} from '@gears-frontx/ui-kit';
import { readListState, writeListState } from '@constructor-studio/mfe-shared';
import { searchQuery, tagGroupChoice } from '@constructor-studio/mfe-shared/grid';

function replaceSearch(search: string): void {
  if (search === window.location.search) return;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
}

/** What the grid asks for, written to the address under `prefix`; `filterKeys` are the one-choice filters kept. */
export function writeGridAddress(context: DataGridLoadContext, prefix: string, filterKeys: readonly string[]): void {
  if (typeof window === 'undefined' || context.tree) return;
  const filters: Record<string, string> = {};
  for (const key of filterKeys) {
    const value = tagGroupChoice(context.filters?.[key] as { value?: unknown } | undefined);
    if (value) filters[key] = value;
  }
  const order = context.order?.[0];
  replaceSearch(
    writeListState(
      window.location.search,
      {
        q: searchQuery(context.filters),
        filters,
        sort: order ? { key: order.column, dir: order.direction === 'desc' ? 'desc' : 'asc' } : null,
        page: 0,
      },
      prefix
    )
  );
}

/** Render inside the grid, after its search, filters and order plugins. */
export const GridAddress: React.FC<{ prefix: string; filterKeys: readonly string[] }> = ({ prefix, filterKeys }) => {
  const grid = useDataGrid();
  useEffect(() => {
    const saved = readListState(window.location.search, prefix);
    if (saved.q) grid.getPlugin<DataGridTextSearchPluginApi>('textSearch')?.setSearch(saved.q);
    const filters = grid.getPlugin<DataGridFiltersPluginApi>('filters');
    for (const key of filterKeys) {
      const value = saved.filters[key];
      if (value) filters?.setState(key, { value: [value] });
    }
    if (saved.sort) grid.getPlugin<DataGridOrderPluginApi>('order')?.setOrder(saved.sort.key, saved.sort.dir);
    return () => replaceSearch(writeListState(window.location.search, readListState('', prefix), prefix));
    // Seeded once, on mount: later changes come from the grid, not the address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
};

GridAddress.displayName = 'GridAddress';
