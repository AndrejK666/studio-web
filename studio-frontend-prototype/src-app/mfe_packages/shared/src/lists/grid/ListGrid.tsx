import React, { createContext, useContext } from 'react';
import {
  DataGrid,
  DataGridEmptyStatePlugin,
  DataGridFiltersPlugin,
  DataGridOrderPlugin,
  DataGridPaginationPlugin,
  DataGridTextSearchPlugin,
  type DataGridDefaultOrder,
  type DataGridFilterEntity,
  type DataGridItem,
  type DataGridProps,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import { useThemedRoot } from './useThemedRoot';
import styles from './ListGrid.module.css';

/** The page sizes every list tab offers; the first is the default. */
export const GRID_PAGE_LIMITS: readonly number[] = [25, 50, 100];

export interface ListGridProps<T extends DataGridItem> {
  /** The grid's identity (its state's storage key); unique on the screen. */
  name: string;
  /** Spoken name, for a screen with more than one grid. */
  label?: string;
  /** Snake_case ids, stable identity (module level or `useMemo`): the kit throws on others and resets on a new array. */
  columns: DataGridTableColumn<T>[];
  load: DataGridProps<T>['load'];
  /** The search box's placeholder; without it the list has no search. */
  search?: string;
  /** Quick filters, stable identity; without them no filter bar. */
  filters?: DataGridFilterEntity[];
  /** What the list says when it has no rows: a module-level component, usually rendering `GridEmpty`. */
  empty: React.ComponentType;
  /** Column ids with no sort in their header. */
  unsortable?: string[];
  defaultOrder?: DataGridDefaultOrder;
  /** Rows per page at first; one of `GRID_PAGE_LIMITS` keeps the selector honest. */
  pageSize?: number;
  /**
   * Floor of the table's width (`--data-grid-table-min-inline-size`): a narrow
   * pane then scrolls the table sideways rather than breaking words.
   */
  minWidth?: string;
  /** Extra plugins (row select, row click, row actions) and bridges (`reloadBridge`). */
  children?: React.ReactNode;
}

/**
 * A list tab's grid, the way Specs draws one (#692, #1076): the kit's
 * `DataGrid` with search, filters, header sort, pages of 25/50/100 and the
 * list's own empty state, its popups portalled into the screen's themed root
 * so they follow the portal theme. State lives in memory: a remount starts
 * clean. The grid keeps `load` in a ref, so a list whose source changes (another
 * project, a retry) needs a new `key`, or `useLocalGridLoad`'s `reloadBridge`.
 */
export function ListGrid<T extends DataGridItem>({
  name,
  label,
  columns,
  load,
  search,
  filters,
  empty,
  unsortable,
  defaultOrder,
  pageSize = GRID_PAGE_LIMITS[0],
  minWidth,
  children,
}: ListGridProps<T>): React.ReactElement {
  const [container, findThemedRoot] = useThemedRoot();
  const style = minWidth
    ? ({ '--data-grid-table-min-inline-size': minWidth } as React.CSSProperties)
    : undefined;
  return (
    <div ref={findThemedRoot} className={styles.section} style={style} data-list-grid={name}>
      <DataGrid<T>
        name={name}
        label={label}
        persistent="memory"
        columns={columns}
        load={load}
        portalContainer={container ?? undefined}
      >
        {search !== undefined && <DataGridTextSearchPlugin placeholder={search} />}
        {filters && filters.length > 0 && (
          <DataGridFiltersPlugin entities={filters} isAllFiltersOptionVisible={false} />
        )}
        <DataGridOrderPlugin excludedColumns={unsortable} defaultOrder={defaultOrder} />
        <DataGridPaginationPlugin defaultLimit={pageSize} limits={[...GRID_PAGE_LIMITS]} />
        <DataGridEmptyStatePlugin component={empty} />
        {children}
      </DataGrid>
    </div>
  );
}

/**
 * What a list's cells need beyond their row (callbacks, labels, a lookup), in
 * a context, so the columns stay one array for the grid's life: a new
 * `columns` array resets the grid's column state. Returns the provider and the
 * hook a cell reads it with; the hook throws outside the provider.
 */
export function createGridCells<C>(
  name: string
): [React.Provider<C | null>, () => C] {
  const Context = createContext<C | null>(null);
  Context.displayName = `${name}Cells`;
  const useCells = (): C => {
    const cells = useContext(Context);
    if (cells === null) throw new Error(`A ${name} cell rendered outside its cells provider`);
    return cells;
  };
  return [Context.Provider, useCells];
}
