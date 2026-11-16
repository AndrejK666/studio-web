/**
 * The organization's connections on the kit's DataGrid, the way Specs draws its
 * list (#1076): the mockup's columns (Connection, Status, Available data,
 * Projects, Last sync, Actions), search by name, account and provider, header
 * sort by name, pages, the list's empty state, the portal theme. Rows keep the
 * order the connector service lists them in until a header sorts them.
 */

import React, { useMemo } from 'react';
import { Network } from 'lucide-react';
import type { DataGridTableColumn } from '@gears-frontx/ui-kit';
import {
  GridClearFilters,
  GridEmpty,
  GridFooter,
  ListGrid,
  NoData,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import { useConnectionListText } from '../../../i18n';
import { connectionSearchTexts, type ConnectionRow } from '../../../shared/useConnectionList';
import { ProviderGlyph } from './ProviderGlyph';
import { HealthInline } from './HealthInline';
import styles from '../ConnectionListScreen.module.css';

// @cpt-dod:cpt-studiofrontend-dod-connection-list-gaps:p1
// @cpt-algo:cpt-studiofrontend-algo-connection-list-read:p2

/** How the grid searches and sorts the connections in memory. */
export const CONNECTION_GRID_OPTIONS = {
  search: connectionSearchTexts,
  compare: {
    connection: (a: ConnectionRow, b: ConnectionRow) =>
      a.connection.label.localeCompare(b.connection.label, undefined, { sensitivity: 'base', numeric: true }),
  },
};

/** What a cell needs beyond its row. */
interface ConnectionCells {
  t: ReturnType<typeof useConnectionListText>;
  /** The organization the connections belong to: the health check is scoped to it. */
  tenantId: string;
  /** Whether an organization is in scope: without one the empty list says so. */
  hasOrg: boolean;
}

const [ConnectionCellsProvider, useConnectionCells] = createGridCells<ConnectionCells>('Connections');

const ConnectionCell: React.FC<{ item: ConnectionRow }> = ({ item }) => {
  const { connection, providerName } = item;
  return (
    <span className={styles.nameCell} data-connection-row={item.id}>
      <ProviderGlyph code={connection.provider} label={providerName} />
      <span className={styles.nameText}>
        <span className={styles.name}>{connection.label}</span>
        <span className={styles.subtitle}>
          {connection.account} · {connection.scope}
        </span>
      </span>
    </span>
  );
};

const StatusCell: React.FC<{ item: ConnectionRow }> = ({ item }) => {
  const { tenantId } = useConnectionCells();
  return <HealthInline connectionId={item.connection.id} tenantId={tenantId} />;
};

// @cpt-begin:cpt-studiofrontend-algo-connection-list-read:p2:inst-5
/** The four columns no source feeds yet: a dash each, its title saying which gap. */
const AvailableCell: React.FC = () => <NoData label={useConnectionCells().t('no_data')} />;
const ProjectsCell: React.FC = () => <NoData label={useConnectionCells().t('no_projects')} />;
const LastSyncCell: React.FC = () => <NoData label={useConnectionCells().t('no_sync')} />;
const ActionsCell: React.FC = () => <NoData label={useConnectionCells().t('no_actions')} />;
// @cpt-end:cpt-studiofrontend-algo-connection-list-read:p2:inst-5

const ConnectionsEmpty: React.FC = () => {
  const { t, hasOrg } = useConnectionCells();
  return (
    <GridEmpty
      icon={<Network />}
      title={t('empty_title')}
      note={hasOrg ? t('empty_hint') : t('empty_no_org')}
      noMatches={t('empty_no_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export interface ConnectionsGridProps {
  rows: readonly ConnectionRow[];
  /** The organization in scope; empty while there is none. */
  tenantId: string;
}

export const ConnectionsGrid: React.FC<ConnectionsGridProps> = ({ rows, tenantId }) => {
  const t = useConnectionListText();
  const { load, shown, reloadBridge } = useLocalGridLoad(rows, CONNECTION_GRID_OPTIONS);

  const columns = useMemo<DataGridTableColumn<ConnectionRow>[]>(
    () => [
      { id: 'connection', label: t('col_connection'), component: ConnectionCell },
      { id: 'status', label: t('col_status'), component: StatusCell, width: 140 },
      { id: 'available', label: t('col_available'), component: AvailableCell, width: 140 },
      { id: 'projects', label: t('col_projects'), component: ProjectsCell, width: 104 },
      { id: 'last_sync', label: t('col_last_sync'), component: LastSyncCell, width: 112 },
      { id: 'actions', label: t('col_actions'), component: ActionsCell, width: 96 },
    ],
    [t]
  );
  const cells = useMemo<ConnectionCells>(() => ({ t, tenantId, hasOrg: tenantId !== '' }), [t, tenantId]);

  return (
    <ConnectionCellsProvider value={cells}>
      <ListGrid<ConnectionRow>
        name="connections"
        label={t('title')}
        columns={columns}
        load={load}
        search={t('search_placeholder')}
        empty={ConnectionsEmpty}
        unsortable={['status', 'available', 'projects', 'last_sync', 'actions']}
        minWidth="52rem"
      >
        {reloadBridge}
      </ListGrid>
      {shown && shown.length > 0 && <GridFooter parts={[t.count('count', shown.length)]} />}
    </ConnectionCellsProvider>
  );
};

ConnectionsGrid.displayName = 'ConnectionsGrid';
