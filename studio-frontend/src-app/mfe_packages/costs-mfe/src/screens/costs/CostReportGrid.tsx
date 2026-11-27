/**
 * The cost report's rows on the kit's DataGrid, the way Specs draws its list
 * (#1076): search by the row's name, header sort by every column, pages, the
 * list's empty state ("nothing used" / "nothing matched" with Clear search),
 * the portal theme. The period, the grouping and the personal-keys switch stay
 * above it: they ask the server for another report, not a filter of this one.
 * The total for the period is the line under it.
 */

import React, { useMemo } from 'react';
import type { DataGridTableColumn } from '@gears-frontx/ui-kit';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { CostGroup, CostReport, CostRow } from '../../api/types';
import { hours, money, rowLabel, tokens } from '../../model/costs';
import type { useCostsTranslations } from '../../i18n';
import styles from './CostsScreen.module.css';

type Text = ReturnType<typeof useCostsTranslations>['t'];

/** A row of the grid: a report row, its name worked out, by its key. */
export type CostGridRow = CostRow & { id: string; name: string };

interface CostCells {
  t: Text;
  currency: string;
}

const [CostCellsProvider, useCostCells] = createGridCells<CostCells>('CostReport');

const NameCell: React.FC<{ item: CostGridRow }> = ({ item }) => <span data-cost-row={item.key}>{item.name}</span>;

const numberCell = (value: (row: CostGridRow) => string): React.FC<{ item: CostGridRow }> => {
  const Cell: React.FC<{ item: CostGridRow }> = ({ item }) => <span className={styles.numCell}>{value(item)}</span>;
  Cell.displayName = 'CostNumberCell';
  return Cell;
};

const InputCell = numberCell((r) => tokens(r.input_tokens));
const OutputCell = numberCell((r) => tokens(r.output_tokens));
const CacheReadCell = numberCell((r) => tokens(r.cache_read_tokens));
const CacheWriteCell = numberCell((r) => tokens(r.cache_write_tokens));
const SessionsCell = numberCell((r) => hours(r.session_seconds));

const CostCell: React.FC<{ item: CostGridRow }> = ({ item }) => {
  const { t, currency } = useCostCells();
  return (
    <span className={styles.numCell}>
      {money(item.cost, currency)}
      {item.unpriced && (
        <span className={styles.unpriced} title={t('row_unpriced')}>
          {' '}
          *
        </span>
      )}
    </span>
  );
};

const CostEmpty: React.FC = () => {
  const { t } = useCostCells();
  return (
    <GridEmpty
      title={t('nothing_used')}
      noMatches={t('no_matches')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

const LOCAL_OPTIONS = {
  search: (r: CostGridRow) => [r.name, r.key],
  compare: {
    name: (a: CostGridRow, b: CostGridRow) => a.name.localeCompare(b.name),
    input: (a: CostGridRow, b: CostGridRow) => a.input_tokens - b.input_tokens,
    output: (a: CostGridRow, b: CostGridRow) => a.output_tokens - b.output_tokens,
    cache_read: (a: CostGridRow, b: CostGridRow) => a.cache_read_tokens - b.cache_read_tokens,
    cache_write: (a: CostGridRow, b: CostGridRow) => a.cache_write_tokens - b.cache_write_tokens,
    sessions: (a: CostGridRow, b: CostGridRow) => a.session_seconds - b.session_seconds,
    cost: (a: CostGridRow, b: CostGridRow) => a.cost - b.cost,
  },
};

export const CostReportGrid: React.FC<{ report: CostReport; group: CostGroup; you: string | undefined; t: Text }> = ({
  report,
  group,
  you,
  t,
}) => {
  const by = report.group_by ?? group;
  const rows = useMemo<CostGridRow[]>(
    () => report.rows.map((r) => ({ ...r, id: r.key || '-', name: rowLabel(r, by, you) })),
    [report, by, you]
  );
  const { load, reloadBridge } = useLocalGridLoad(rows, LOCAL_OPTIONS);
  const groupLabel = t(`group_${by}`);
  const columns = useMemo<DataGridTableColumn<CostGridRow>[]>(
    () => [
      { id: 'name', label: groupLabel, component: NameCell },
      { id: 'input', label: t('col_input'), component: InputCell, width: 110 },
      { id: 'output', label: t('col_output'), component: OutputCell, width: 110 },
      { id: 'cache_read', label: t('col_cache_read'), component: CacheReadCell, width: 120 },
      { id: 'cache_write', label: t('col_cache_write'), component: CacheWriteCell, width: 120 },
      { id: 'sessions', label: t('col_sessions'), component: SessionsCell, width: 130 },
      { id: 'cost', label: t('col_cost'), component: CostCell, width: 120 },
    ],
    [t, groupLabel]
  );
  const cells = useMemo<CostCells>(() => ({ t, currency: report.currency }), [t, report.currency]);
  return (
    <CostCellsProvider value={cells}>
      <div data-cost-table>
        <ListGrid<CostGridRow>
          name="cost-report"
          columns={columns}
          load={load}
          search={t('search')}
          empty={CostEmpty}
          minWidth="52rem"
        >
          {reloadBridge}
        </ListGrid>
      </div>
      {rows.length > 0 && (
        <p className={styles.totalLine} data-cost-total-line>
          {t('total')}: <span data-cost-total>{money(report.total, report.currency)}</span>
        </p>
      )}
    </CostCellsProvider>
  );
};

CostReportGrid.displayName = 'CostReportGrid';
