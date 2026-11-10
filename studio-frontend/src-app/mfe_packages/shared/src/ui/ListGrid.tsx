/**
 * The kit's DataGrid as a list under a screen's page header: the space between
 * the header and the grid's toolbar comes with the list, not with the screen
 * around it
 */

import type { ReactNode } from 'react';
import { DataGrid, type DataGridItem, type DataGridProps } from '@gears-frontx/ui-kit';
import styles from './ListGrid.module.css';

export const LIST_PAGE_LIMITS = [25, 50, 100];

export const TEXT_SEARCH_FILTER_KEY = 'textSearch';

export type ListGridProps<TItem extends DataGridItem> = DataGridProps<TItem> & {
  footer?: ReactNode;
};

export function ListGrid<TItem extends DataGridItem = DataGridItem>({
  footer,
  ...grid
}: ListGridProps<TItem>) {
  return (
    <div className={styles.list}>
      <DataGrid<TItem> {...grid} />
      {footer ? <p className={styles.footer}>{footer}</p> : null}
    </div>
  );
}

ListGrid.displayName = 'ListGrid';
