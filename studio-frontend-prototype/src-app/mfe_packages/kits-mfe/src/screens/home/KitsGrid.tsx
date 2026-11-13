/**
 * The kit library on the kit's DataGrid (#1081), the way Specs draws its list
 * (#1076): search, filters for level, shelf, base / installed and publisher,
 * header sort, pages, an empty state, the portal theme. Two views of the same
 * rows: a table, and tiles that keep the cards the screen drew before. Which
 * one is the person's, remembered in `/me/ui-preferences` (`mfe.kits.view`).
 */

import React, { useEffect, useMemo } from 'react';
import {
  DATA_GRID_VIEW,
  createDataGridPlugin,
  filterTagGroup,
  useDataGrid,
  useDataGridActiveView,
  type DataGridFilterEntity,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import { LayoutGrid } from 'lucide-react';
import { useHostPreference } from '@constructor-studio/mfe-shared';
import {
  GridEmpty,
  ListGrid,
  createGridCells,
  listChoices,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { ChildMfeBridge } from '@gears-frontx/react';
import type { CatalogKit, InstalledKits } from '../../api/KitsApiService';
import type { useHomeTranslations } from '../../i18n';
import { KitIcon } from './KitIcon';
import styles from './HomeScreen.module.css';

type Text = ReturnType<typeof useHomeTranslations>['t'];

/** Where the person's choice of view is kept. */
export const KITS_VIEW_PREFERENCE = 'mfe.kits.view';
/** The tiles view's value of it; anything else is the table. */
export const KITS_VIEW_TILES = 'tiles';

/** A kit here: installed where the screen is, by whom, or not; `unknown` until the installer answers. */
export type KitStatus = 'base' | 'installed' | 'not_installed' | 'unknown';

export interface KitRow extends CatalogKit {
  id: string;
  status: KitStatus;
}

/** The filter keys the grid hands `load`. */
export const KIT_FILTERS = {
  level: 'level',
  shelf: 'shelf',
  status: 'status',
  publisher: 'publisher',
} as const;

export const KIT_STATUSES: readonly KitStatus[] = ['base', 'installed', 'not_installed'];

/** Where `kit` stands in `installed`: a base kit, one the organization or the project installed, or neither. */
export function statusOf(kit: CatalogKit, installed: InstalledKits | null): KitStatus {
  if (!installed) return 'unknown';
  if (installed.base.some((k) => k.kit_slug === kit.slug)) return 'base';
  const own = [...installed.organization, ...(installed.project ?? [])];
  return own.some((k) => k.kit_slug === kit.slug) ? 'installed' : 'not_installed';
}

export function kitRows(kits: readonly CatalogKit[], installed: InstalledKits | null): KitRow[] {
  return kits.map((kit) => ({ ...kit, id: kit.slug, status: statusOf(kit, installed) }));
}

/** Whether `row` passes the grid's filters: within a filter any choice, across filters every one. */
export function keepsKit(row: KitRow, filters: Record<string, unknown>): boolean {
  const chosen = (key: string) => listChoices(filters[key] as { value?: unknown } | undefined);
  const levels = chosen(KIT_FILTERS.level);
  if (levels.length > 0 && !levels.some((level) => row.levels?.includes(level))) return false;
  const shelves = chosen(KIT_FILTERS.shelf);
  if (shelves.length > 0 && !shelves.includes(row.shelf ?? '')) return false;
  const statuses = chosen(KIT_FILTERS.status);
  if (statuses.length > 0 && !statuses.includes(row.status)) return false;
  const publishers = chosen(KIT_FILTERS.publisher);
  return publishers.length === 0 || publishers.includes(row.publisher);
}

const byText = (pick: (row: KitRow) => string) => (a: KitRow, b: KitRow) =>
  pick(a).localeCompare(pick(b), undefined, { sensitivity: 'base', numeric: true });

const LOCAL_OPTIONS = {
  search: (row: KitRow) => [row.name, row.slug, row.description, row.publisher],
  filter: keepsKit,
  compare: {
    name: byText((row) => row.name),
    publisher: byText((row) => row.publisher),
    version: byText((row) => row.default_version),
  },
};

/** What a cell and a tile need beyond their row. */
export interface KitCells {
  t: Text;
  open: (slug: string) => void;
  /** The installer's badges and buttons for the kit, as the card had them. */
  controls: (kit: CatalogKit) => React.ReactNode;
  /** The line saying what the kit brings; `null` before its contents are read. */
  summary: (slug: string) => string | null;
}

const [KitCellsProvider, useKitCells] = createGridCells<KitCells>('Kits');

const NameCell: React.FC<{ item: KitRow }> = ({ item }) => {
  const { open } = useKitCells();
  return (
    <div className={styles.nameCell}>
      <KitIcon kit={item} />
      <span className={styles.nameStack}>
        <button type="button" className={styles.cardLink} onClick={() => open(item.slug)} data-kit-open={item.slug}>
          {item.name}
        </button>
        {item.description && <span className={styles.rowNote}>{item.description}</span>}
      </span>
    </div>
  );
};

const VersionCell: React.FC<{ item: KitRow }> = ({ item }) => <code>{item.default_version}</code>;

const LevelsCell: React.FC<{ item: KitRow }> = ({ item }) => <span>{(item.levels ?? []).join(', ')}</span>;

const StatusCell: React.FC<{ item: KitRow }> = ({ item }) => {
  const { controls } = useKitCells();
  return <div className={styles.statusCell}>{controls(item)}</div>;
};

/** Today's card, one per kit: the tiles view. */
const KitTile: React.FC<{ kit: KitRow }> = ({ kit }) => {
  const { t, open, controls, summary } = useKitCells();
  const said = summary(kit.slug);
  return (
    <li className={styles.card} data-kit={kit.slug}>
      <h3 className={styles.cardTitle}>
        <KitIcon kit={kit} />
        <button type="button" className={styles.cardLink} onClick={() => open(kit.slug)}>
          {kit.name}
        </button>
      </h3>
      <p className={styles.cardText}>{kit.description}</p>
      <dl className={styles.facts}>
        <dt>{t('publisher')}</dt>
        <dd>{kit.publisher}</dd>
        <dt>{t('version')}</dt>
        <dd>{kit.default_version}</dd>
        {kit.repository_url && (
          <>
            <dt>{t('repository')}</dt>
            <dd>
              <a href={kit.repository_url} target="_blank" rel="noreferrer">
                {kit.repository_url.replace('https://', '')}
              </a>
            </dd>
          </>
        )}
        {kit.levels && kit.levels.length > 0 && (
          <>
            <dt>{t('levels')}</dt>
            <dd>{kit.levels.join(', ')}</dd>
          </>
        )}
      </dl>
      {said !== null && (
        <p className={styles.summary} data-kit-summary>
          {said}
        </p>
      )}
      <button type="button" className={styles.inside} onClick={() => open(kit.slug)}>
        {t('inside')}
      </button>
      {controls(kit)}
    </li>
  );
};

const KitTiles: React.FC = () => {
  const records = useDataGrid<KitRow>().useStore((state) => state.visibleRecords);
  return (
    <ul className={styles.grid} data-kit-tiles>
      {records.map((record) => (
        <KitTile key={record.id} kit={record.item} />
      ))}
    </ul>
  );
};

const TilesIcon: React.FC = () => <LayoutGrid aria-hidden="true" />;

/** The tiles as the grid's second main view: the grid draws the table/tiles switch itself. */
const KitTilesPlugin = createDataGridPlugin<KitRow, 'kitTiles'>('kitTiles', (context) => {
  context.registerSlot('main', { id: DATA_GRID_VIEW.cards, component: KitTiles, icon: TilesIcon });
  return {};
});

/**
 * Keeps the grid's view and the person's preference in step: the preference
 * picks the view when it arrives, a click on the switch writes it.
 */
const ViewFromPreference: React.FC<{ bridge: ChildMfeBridge }> = ({ bridge }) => {
  const grid = useDataGrid();
  const active = useDataGridActiveView();
  const [stored, store] = useHostPreference(KITS_VIEW_PREFERENCE, { bridge });
  const tiles = stored === KITS_VIEW_TILES;
  // The instance is not stable between renders, and every set is a store update: set only a change.
  useEffect(() => {
    const view = tiles ? DATA_GRID_VIEW.cards : DATA_GRID_VIEW.table;
    if (grid.getActiveSlotId('main') !== view) grid.setActiveSlotId('main', view);
  }, [grid, tiles]);
  useEffect(() => {
    // The view as it is now, not as this render saw it: the effect above may have just set it.
    const now = grid.getActiveSlotId('main');
    if (!active || !now) return;
    const nowTiles = now === DATA_GRID_VIEW.cards;
    // The table is the default: choosing it again forgets the choice.
    if (nowTiles !== tiles) store(nowTiles ? KITS_VIEW_TILES : '');
  }, [grid, active, tiles, store]);
  return null;
};

function tagGroup(id: string, label: string, options: { value: string; label: string }[]): DataGridFilterEntity {
  return filterTagGroup({ id, label, options });
}

const distinct = (values: (string | undefined)[]) =>
  [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));

const KitsEmpty: React.FC = () => {
  const { t } = useKitCells();
  return <GridEmpty noMatches={t('no_matches')} title={t('empty')} />;
};

export const KitsGrid: React.FC<{
  rows: KitRow[];
  cells: KitCells;
  bridge: ChildMfeBridge;
}> = ({ rows, cells, bridge }) => {
  const { t } = cells;
  const { load, reloadBridge } = useLocalGridLoad(rows, LOCAL_OPTIONS);
  const columns = useMemo<DataGridTableColumn<KitRow>[]>(
    () => [
      { id: 'name', label: t('col_name'), component: NameCell },
      { id: 'publisher', label: t('publisher'), width: 160 },
      { id: 'version', label: t('version'), component: VersionCell, width: 140 },
      { id: 'levels', label: t('levels'), component: LevelsCell, width: 180 },
      { id: 'status', label: t('col_status'), component: StatusCell, width: 300 },
    ],
    [t]
  );
  // The options a filter offers are the ones the rows have: one entity list per set of them.
  const levels = distinct(rows.flatMap((row) => row.levels ?? [])).join(',');
  const shelves = distinct(rows.map((row) => row.shelf)).join(',');
  const publishers = distinct(rows.map((row) => row.publisher)).join(',');
  const known = rows.some((row) => row.status !== 'unknown');
  const filters = useMemo(() => {
    const split = (joined: string) => (joined ? joined.split(',') : []);
    const entities = [
      tagGroup(KIT_FILTERS.level, t('filter_level'), split(levels).map((value) => ({ value, label: value }))),
      tagGroup(
        KIT_FILTERS.shelf,
        t('filter_shelf'),
        split(shelves).map((value) => ({ value, label: t(`shelf_${value}`) }))
      ),
    ];
    if (known) {
      entities.push(
        tagGroup(
          KIT_FILTERS.status,
          t('filter_status'),
          KIT_STATUSES.map((value) => ({ value, label: t(`status_${value}`) }))
        )
      );
    }
    entities.push(
      tagGroup(KIT_FILTERS.publisher, t('filter_publisher'), split(publishers).map((value) => ({ value, label: value })))
    );
    return entities;
  }, [t, levels, shelves, publishers, known]);
  return (
    <KitCellsProvider value={cells}>
      <ListGrid<KitRow>
        name="kits"
        columns={columns}
        load={load}
        search={t('search')}
        filters={filters}
        empty={KitsEmpty}
        unsortable={['levels', 'status']}
        defaultOrder={{ id: 'name', direction: 'asc' }}
        minWidth="56rem"
      >
        <KitTilesPlugin />
        <ViewFromPreference bridge={bridge} />
        {reloadBridge}
      </ListGrid>
    </KitCellsProvider>
  );
};

KitsGrid.displayName = 'KitsGrid';
