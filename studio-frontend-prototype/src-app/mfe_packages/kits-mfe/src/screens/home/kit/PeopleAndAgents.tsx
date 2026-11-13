/**
 * What a kit lets people and agents do (#1099): its Inbox sources and MCP
 * tools as named items, and its permissions grouped by gear (the route's first
 * segment) and by read or write, each path once, shortened to what follows the
 * gear's prefix, with its methods as chips. "Show all routes" keeps the full
 * list, on the shared grid.
 */

import React, { useMemo, useState } from 'react';
import { Badge, Button } from '@gears-frontx/ui-kit';
import type { DataGridTableColumn } from '@gears-frontx/ui-kit';
import { GridEmpty, ListGrid, useLocalGridLoad } from '@constructor-studio/mfe-shared/grid';
import type { KitContents } from '../../../api/KitsApiService';
import { groupPermissions, parseRoute, type GrantedPath } from '../../../model/kitPage';
import { ItemsGrid, type ItemRow } from './ItemsGrid';
import type { Text } from './text';
import styles from './KitPage.module.css';

/** The kit's Inbox sources and MCP tools, one row each, on the grid the Kits tab uses. */
export const AgentItems: React.FC<{ contents: KitContents; t: Text }> = ({ contents, t }) => {
  const rows = useMemo<ItemRow[]>(
    () => [
      ...contents.inbox.map((s) => ({ id: `inbox:${s.id}`, kind: t('sec_inbox'), name: s.id, note: s.label })),
      ...contents.mcp_tools.map((tool) => ({
        id: `tool:${tool.name}`,
        kind: t('sec_tools'),
        name: tool.name,
        note: tool.description ?? '',
      })),
    ],
    [contents.inbox, contents.mcp_tools, t]
  );
  return (
    <div data-kit-agents>
      <ItemsGrid name="kit-agents" label={t('sec_agents')} rows={rows} t={t} />
    </div>
  );
};

const Paths: React.FC<{ paths: GrantedPath[]; label: string }> = ({ paths, label }) =>
  paths.length === 0 ? null : (
    <div>
      <span className={styles.note}>{label}</span>
      <ul className={styles.access}>
        {paths.map((p) => (
          <li key={p.path} data-path={p.path}>
            {p.methods.map((m) => (
              <Badge key={m} variant={m === 'GET' ? 'secondary' : 'warning'}>
                {m}
              </Badge>
            ))}
            <code className={styles.mono}>{p.path}</code>
          </li>
        ))}
      </ul>
    </div>
  );

export const Permissions: React.FC<{ permissions: KitContents['permissions']; t: Text }> = ({ permissions, t }) => {
  const gears = useMemo(() => groupPermissions(permissions), [permissions]);
  const [all, setAll] = useState(false);
  const total = permissions.reads.length + permissions.writes.length;
  return (
    <div className={styles.panel} data-kit-permissions>
      {gears.length > 0 && (
        <div className={styles.gears}>
          {gears.map((g) => (
            <section key={g.gear || '-'} className={styles.gear} data-gear={g.gear || '-'}>
              <h5 className={styles.gearName}>{g.gear || t('perm_other')}</h5>
              <Paths paths={g.reads} label={t('perm_reads')} />
              <Paths paths={g.writes} label={t('perm_writes')} />
            </section>
          ))}
        </div>
      )}
      {permissions.listens.length > 0 && (
        <div className={styles.row} data-kit-listens>
          <span className={styles.note}>{t('perm_listens')}</span>
          {permissions.listens.map((l) => (
            <Badge key={l} variant="outline">
              {l}
            </Badge>
          ))}
        </div>
      )}
      {total > 0 && (
        <div>
          <Button size="sm" variant="ghost" aria-expanded={all} onClick={() => setAll((v) => !v)} data-all-routes>
            {all ? t('perm_hide_all') : t('perm_show_all', { count: total })}
          </Button>
        </div>
      )}
      {all && <AllRoutes permissions={permissions} t={t} />}
    </div>
  );
};

interface RouteRow {
  id: string;
  access: string;
  method: string;
  gear: string;
  route: string;
}

const RoutesText = React.createContext<Text | null>(null);

const RoutesEmpty: React.FC = () => {
  const t = React.useContext(RoutesText);
  return <GridEmpty noMatches={t?.('perm_no_matches') ?? ''} />;
};

const RouteCell: React.FC<{ item: RouteRow }> = ({ item }) => <code className={styles.mono}>{item.route}</code>;

const byText = (pick: (row: RouteRow) => string) => (a: RouteRow, b: RouteRow) => pick(a).localeCompare(pick(b));

const ROUTE_OPTIONS = {
  search: (row: RouteRow) => [row.route, row.gear, row.method, row.access],
  compare: {
    access: byText((r) => r.access),
    method: byText((r) => r.method),
    gear: byText((r) => r.gear),
    route: byText((r) => r.route),
  },
};

/** Every route as the manifest says it, one row each. */
const AllRoutes: React.FC<{ permissions: KitContents['permissions']; t: Text }> = ({ permissions, t }) => {
  const rows = useMemo<RouteRow[]>(
    () =>
      (['reads', 'writes'] as const).flatMap((side) =>
        permissions[side].map((entry, i) => {
          const route = parseRoute(entry);
          return {
            id: `${side}:${i}`,
            access: t(`perm_${side}`),
            method: route?.method ?? '',
            gear: route?.gear ?? '',
            route: route ? entry.slice(route.method.length).trim() : entry,
          };
        })
      ),
    [permissions, t]
  );
  const { load, reloadBridge } = useLocalGridLoad(rows, ROUTE_OPTIONS);
  const columns = useMemo<DataGridTableColumn<RouteRow>[]>(
    () => [
      { id: 'access', label: t('perm_col_access'), width: 110 },
      { id: 'method', label: t('perm_col_method'), width: 100 },
      { id: 'gear', label: t('perm_col_gear'), width: 200 },
      { id: 'route', label: t('perm_col_route'), component: RouteCell },
    ],
    [t]
  );
  return (
    <RoutesText.Provider value={t}>
      <ListGrid<RouteRow>
        name="kit-routes"
        label={t('perm_all_routes')}
        columns={columns}
        load={load}
        search={t('perm_search')}
        empty={RoutesEmpty}
        defaultOrder={{ id: 'gear', direction: 'asc' }}
        minWidth="40rem"
      >
        {reloadBridge}
      </ListGrid>
    </RoutesText.Provider>
  );
};
