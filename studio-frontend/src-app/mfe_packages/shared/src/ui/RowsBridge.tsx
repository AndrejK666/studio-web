import React, { useEffect, useRef } from 'react';
import { useDataGrid } from '@gears-frontx/ui-kit';

/** The part of the kit's pagination plugin the bridge needs; the kit does not export its type. */
interface PagesApi {
  getPage: () => number;
  setPage: (page: number) => void;
}

export const RowsBridge: React.FC<{ rowsKey: string }> = ({ rowsKey }) => {
  const grid = useDataGrid();
  const shown = useRef(rowsKey);
  useEffect(() => {
    if (shown.current === rowsKey) return;
    shown.current = rowsKey;
    void grid.triggerLoad().promise.then(
      () => {
        // The kit keeps the page when the rows shrink under it; setPage clamps it to the last one.
        const pages = grid.getPlugin<PagesApi>('pagination');
        pages?.setPage(pages.getPage());
      },
      () => undefined
    );
  }, [grid, rowsKey]);
  return null;
};

RowsBridge.displayName = 'RowsBridge';
