/**
 * What the project is made of, on the kit's DataGrid, the way Specs draws its
 * list (#1076): search by name, kind, place and capability, a filter for whose
 * it is (the chips it had), header sort by component and whose, pages, the
 * list's empty state, the portal theme. A click on a row says why it is there;
 * Create a gear, Open in the catalogue, Make it a gear and Put it into the
 * product sit in its actions. What a row opens shows under the list: the kit's
 * grid has no detail row.
 */

import React, { useMemo } from 'react';
import {
  Badge,
  Button,
  DataGridRowActionsPlugin,
  DataGridRowClickPlugin,
  filterTagGroup,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import { ComponentTypeIcon, registryComponentType, type ComponentType } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  tagGroupChoice,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { PlanRow } from '../../api/types';
import { ROLE_LABEL, type InventoryRole, type InventoryRow } from '../../model/project-inventory';
import type { useComponentsTranslations } from '../../i18n';
import styles from './ProjectComponentsInventory.module.css';

type Text = ReturnType<typeof useComponentsTranslations>['t'];

/** The order the roles are offered and sorted in. */
export const ROLES: InventoryRole[] = ['ours', 'could', 'create', 'organization', 'platform', 'service'];

/** A row of the grid: a component, by its key. */
export type InventoryGridRow = InventoryRow & { id: string };

/** The filter key of whose a component is. */
export const INVENTORY_ROLE_FILTER = 'whose';

/** The glyph the Components screens draw for the row's type (mfe-shared): a
 *  service the project's build tools declare is a service, the rest by their
 *  registry kind, word for word. */
export function inventoryType(r: Pick<InventoryRow, 'role' | 'kind'>): ComponentType {
  return r.role === 'service' ? 'service' : registryComponentType(r.kind);
}

/** What a cell needs beyond its row. */
export interface InventoryCells {
  t: Text;
  /** The row whose "why" is open, and the "could be a gear" opened to make it one. */
  expanded: string | null;
  opened: string | null;
  stateOf: (r: InventoryRow) => string;
  runsOf: (r: InventoryRow) => React.ReactNode;
  /** The capability a gear is being asked for, and whether its draft is ready. */
  scaffold: PlanRow | null;
  drafted: boolean;
  onCreate: (need: PlanRow) => void;
  onOpenCatalogue: () => void;
  onToggleCandidate: (key: string) => void;
  onOpenProduct: () => void;
}

const [InventoryCellsProvider, useInventoryCells] = createGridCells<InventoryCells>('Inventory');

const Dash: React.FC = () => <span className={styles.muted}>—</span>;

const ComponentCell: React.FC<{ item: InventoryGridRow }> = ({ item: r }) => {
  const { expanded } = useInventoryCells();
  return (
    <div data-inventory-row={r.key} data-role={r.role} aria-expanded={expanded === r.key}>
      <ComponentTypeIcon type={inventoryType(r)} className={styles.typeIcon} />
      <b>{r.name}</b> <span className={styles.muted}>{r.kind}</span>
      {r.path && <div className={styles.muted}>{r.path}</div>}
    </div>
  );
};

const WhoseCell: React.FC<{ item: InventoryGridRow }> = ({ item: r }) => (
  <Badge variant={r.role === 'create' ? 'warning' : r.role === 'could' ? 'info' : 'secondary'}>{ROLE_LABEL[r.role]}</Badge>
);

const AnswersCell: React.FC<{ item: InventoryGridRow }> = ({ item: r }) =>
  r.answers.length ? <code className={styles.muted}>{r.answers.join(', ')}</code> : <Dash />;

const ProductCell: React.FC<{ item: InventoryGridRow }> = ({ item: r }) => (r.inProduct ? <span>✓</span> : <Dash />);

const RunsCell: React.FC<{ item: InventoryGridRow }> = ({ item: r }) => <>{useInventoryCells().runsOf(r)}</>;

const CodeCell: React.FC<{ item: InventoryGridRow }> = ({ item: r }) => (r.inCode ? <span>✓</span> : <Dash />);

const StateCell: React.FC<{ item: InventoryGridRow }> = ({ item: r }) => (
  <span className={styles.muted}>{useInventoryCells().stateOf(r)}</span>
);

const RowActions: React.FC<{ item: InventoryGridRow }> = ({ item: r }) => {
  const { t, opened, scaffold, drafted, onCreate, onOpenCatalogue, onToggleCandidate, onOpenProduct } =
    useInventoryCells();
  const reading = !!r.need && scaffold === r.need && !drafted;
  return (
    <div className={styles.actions}>
      {r.role === 'create' && r.need && (
        <Button type="button" size="sm" disabled={reading} onClick={() => onCreate(r.need!)} data-create-gear>
          {reading ? t('reading_model') : t('create_gear')}
        </Button>
      )}
      {(r.role === 'platform' || r.role === 'organization') && (
        <Button type="button" size="sm" variant="ghost" title={t('open_catalogue_hint')} onClick={onOpenCatalogue}>
          {t('open_catalogue')}
        </Button>
      )}
      {r.role === 'could' && (
        <Button type="button" size="sm" variant="ghost" onClick={() => onToggleCandidate(r.key)}>
          {opened === r.key ? t('hide') : t('make_gear')}
        </Button>
      )}
      {r.role !== 'service' && r.role !== 'create' && !r.inProduct && (
        <Button type="button" size="sm" variant="ghost" onClick={onOpenProduct}>
          {t('put_into_product')}
        </Button>
      )}
    </div>
  );
};

const InventoryEmpty: React.FC = () => {
  const { t } = useInventoryCells();
  return (
    <GridEmpty
      title={t('empty_title')}
      note={t('empty_body')}
      noMatches={t('no_matches')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

const OPTIONS = {
  search: (r: InventoryGridRow) => [r.name, r.kind, r.path, ...r.answers],
  filter: (r: InventoryGridRow, filters: Record<string, { value?: unknown } | undefined>) => {
    const role = tagGroupChoice(filters[INVENTORY_ROLE_FILTER]);
    return !role || r.role === role;
  },
  compare: {
    component: (a: InventoryGridRow, b: InventoryGridRow) => a.name.localeCompare(b.name),
    whose: (a: InventoryGridRow, b: InventoryGridRow) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role),
  },
};

export const InventoryGrid: React.FC<{
  rows: InventoryRow[];
  cells: InventoryCells;
  onToggle: (row: InventoryGridRow) => void;
}> = ({ rows, cells, onToggle }) => {
  const { t } = cells;
  const gridRows = useMemo<InventoryGridRow[]>(() => rows.map((r) => ({ ...r, id: r.key })), [rows]);
  const { load, reloadBridge } = useLocalGridLoad(gridRows, OPTIONS);
  const columns = useMemo<DataGridTableColumn<InventoryGridRow>[]>(
    () => [
      { id: 'component', label: t('col_component'), component: ComponentCell },
      { id: 'whose', label: t('col_whose'), component: WhoseCell, width: 140 },
      { id: 'answers', label: t('col_answers'), component: AnswersCell, width: 180 },
      { id: 'product', label: t('col_product'), component: ProductCell, width: 110 },
      { id: 'runs', label: t('col_runs'), component: RunsCell, width: 140 },
      { id: 'code', label: t('col_code'), component: CodeCell, width: 100 },
      { id: 'state', label: t('col_state'), component: StateCell, width: 160 },
    ],
    [t]
  );
  // The roles offered are the ones the rows have, with how many: one entity list per set of them.
  const counted = ROLES.map((r) => `${r}:${rows.filter((x) => x.role === r).length}`).join(',');
  const filters = useMemo(() => {
    const options = counted
      .split(',')
      .map((entry) => entry.split(':') as [InventoryRole, string])
      .filter(([, count]) => count !== '0')
      .map(([role, count]) => ({ value: role, label: `${ROLE_LABEL[role]} · ${count}` }));
    return [filterTagGroup({ id: INVENTORY_ROLE_FILTER, label: t('whose'), mode: 'radio', options })];
  }, [t, counted]);
  return (
    <InventoryCellsProvider value={cells}>
      <ListGrid<InventoryGridRow>
        name="project-components"
        columns={columns}
        load={load}
        search={t('search')}
        filters={filters}
        empty={InventoryEmpty}
        unsortable={['answers', 'product', 'runs', 'code', 'state']}
        minWidth="64rem"
      >
        <DataGridRowClickPlugin<InventoryGridRow> click={onToggle} />
        <DataGridRowActionsPlugin<InventoryGridRow> component={RowActions} />
        {reloadBridge}
      </ListGrid>
    </InventoryCellsProvider>
  );
};

InventoryGrid.displayName = 'InventoryGrid';
