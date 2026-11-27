/**
 * The kit's tree (`DataGridTableTreePlugin`, ui-kit 0.4.10) clears its rows only
 * when a root load is a refresh or asks for another page. A new page size
 * (pagination's `setLimit`) or a reload of rows in memory (`useLocalGridReload`)
 * is neither, so each one appended the whole list again under the old one: the
 * Workspaces list showed its 3 workspaces five times (walk 2026-11-18).
 *
 * This plugin makes every load of the root replace the rows, as a grid without
 * the tree does. Put it BEFORE `DataGridTableTreePlugin`: hooks run in the order
 * plugins mount, so the tree then finds no root rows and lays the new page out
 * from scratch, opening again what was open. Loads of a branch (`tree.parentId`)
 * are left alone.
 */

import { createDataGridPlugin, type DataGridItem } from '@gears-frontx/ui-kit';

export const GridTreeReplace = createDataGridPlugin<DataGridItem, 'treeReplace'>('treeReplace', (context) => {
  context.hook('load:store', (instance) => {
    const parent = (instance.loadContext.tree as { parentId?: string | number | null } | undefined)?.parentId;
    if (parent === undefined || parent === null) context.clearSections();
  });
  return {};
});
