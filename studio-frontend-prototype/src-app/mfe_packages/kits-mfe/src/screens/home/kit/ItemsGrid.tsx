/**
 * A list on a kit's page as the Kits tab draws its own (#1081, #1099): the
 * shared DataGrid with search, header sort and pages, following the portal
 * theme. One shape for every named thing a kit brings: what kind it is, its
 * name, and what it says about itself.
 */

import React, { useMemo } from 'react';
import type { DataGridTableColumn } from '@gears-frontx/ui-kit';
import { GridEmpty, ListGrid, useLocalGridLoad } from '@constructor-studio/mfe-shared/grid';
import type { Text } from './text';
import styles from './KitPage.module.css';

export interface ItemRow {
  id: string;
  /** What it is: an Inbox source, an MCP tool, a rule, a field's type... */
  kind: string;
  name: string;
  note: string;
}

const ItemsText = React.createContext<{ t: Text; empty: string } | null>(null);

const NameCell: React.FC<{ item: ItemRow }> = ({ item }) => (
  <code className={styles.mono} data-item={item.name}>
    {item.name}
  </code>
);

const NoteCell: React.FC<{ item: ItemRow }> = ({ item }) => <span className={styles.note}>{item.note}</span>;

const ItemsEmpty: React.FC = () => {
  const ctx = React.useContext(ItemsText);
  return <GridEmpty noMatches={ctx?.t('items_no_matches') ?? ''} title={ctx?.empty} />;
};

const byText = (pick: (row: ItemRow) => string) => (a: ItemRow, b: ItemRow) =>
  pick(a).localeCompare(pick(b), undefined, { sensitivity: 'base', numeric: true });

const OPTIONS = {
  search: (row: ItemRow) => [row.name, row.kind, row.note],
  compare: { kind: byText((r) => r.kind), name: byText((r) => r.name), note: byText((r) => r.note) },
};

export const ItemsGrid: React.FC<{
  /** The grid's identity on the screen. */
  name: string;
  label: string;
  rows: ItemRow[];
  t: Text;
  /** Column headings: kind, name, note. */
  headings?: [string, string, string];
  /** Said when the list is empty. */
  empty?: string;
  /** Keep the order the kit declares (a type's fields) rather than sorting by kind. */
  asDeclared?: boolean;
}> = ({ name, label, rows, t, headings, empty = '', asDeclared = false }) => {
  const { load, reloadBridge } = useLocalGridLoad(rows, OPTIONS);
  const [kind, title, note] = headings ?? [t('items_col_kind'), t('items_col_name'), t('items_col_note')];
  const columns = useMemo<DataGridTableColumn<ItemRow>[]>(
    () => [
      { id: 'kind', label: kind, width: 160 },
      { id: 'name', label: title, component: NameCell, width: 260 },
      { id: 'note', label: note, component: NoteCell },
    ],
    [kind, title, note]
  );
  return (
    <ItemsText.Provider value={{ t, empty }}>
      <ListGrid<ItemRow>
        name={name}
        label={label}
        columns={columns}
        load={load}
        search={rows.length > 8 ? t('items_search') : undefined}
        empty={ItemsEmpty}
        defaultOrder={asDeclared ? undefined : { id: 'kind', direction: 'asc' }}
        minWidth="36rem"
      >
        {reloadBridge}
      </ListGrid>
    </ItemsText.Provider>
  );
};

ItemsGrid.displayName = 'ItemsGrid';
