/**
 * The project's team on the kit's DataGrid, the way Specs draws its list
 * (#1076): search by name, address and role, header sort by person, role and
 * scope, pages, the list's empty state (add someone, or invite on People), the
 * portal theme. A member's role is a select in its cell; removing sits in the
 * row's actions. An organization-wide grant is shown with its role locked: it
 * is managed in Access.
 */

import React, { useMemo } from 'react';
import {
  Button,
  DataGridRowActionsPlugin,
  NativeSelect,
  NativeSelectOption,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import { initials, type AccessConfig, type GrantDef, type ScreenText } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import styles from './TeamScreen.module.css';

/** A grant on the team, with its holder's name and address worked out. */
export type TeamGridRow = GrantDef & {
  person: string;
  email: string;
  /** The role's name in the config, or its key when the config has none by it. */
  roleName: string;
  orgWide: boolean;
};

/** What a cell needs beyond its row. */
export interface TeamCells {
  t: ScreenText;
  cfg: AccessConfig;
  busy: boolean;
  /** Whether anybody in the organization is not on the team yet. */
  canAdd: boolean;
  changeRole: (grant: GrantDef, roleKey: string) => void;
  remove: (grant: GrantDef) => void;
  add: () => void;
  openPeople: () => void;
}

const [TeamCellsProvider, useTeamCells] = createGridCells<TeamCells>('Team');

const PersonCell: React.FC<{ item: TeamGridRow }> = ({ item }) => (
  <div className={styles.pcell} data-team-grant={item.id}>
    <span className={styles.photo} aria-hidden>
      {initials(item.person)}
    </span>
    <div>
      <div className={styles.pname}>{item.person}</div>
      <div className={styles.muted}>{item.email}</div>
    </div>
  </div>
);

const RoleCell: React.FC<{ item: TeamGridRow }> = ({ item }) => {
  const { t, cfg, busy, changeRole } = useTeamCells();
  return (
    <NativeSelect
      size="sm"
      aria-label={t('role_of', { name: item.person })}
      value={item.roleKey}
      disabled={busy || item.orgWide}
      onChange={(e) => changeRole(item, e.target.value)}
    >
      {cfg.roles.map((r) => (
        <NativeSelectOption key={r.key} value={r.key}>
          {r.name}
        </NativeSelectOption>
      ))}
      {!cfg.roles.some((r) => r.key === item.roleKey) && (
        <NativeSelectOption value={item.roleKey}>{item.roleKey}</NativeSelectOption>
      )}
    </NativeSelect>
  );
};

const ScopeCell: React.FC<{ item: TeamGridRow }> = ({ item }) => {
  const { t } = useTeamCells();
  return <span className={styles.muted}>{item.orgWide ? t('scope_org') : t('scope_project')}</span>;
};

const RowActions: React.FC<{ item: TeamGridRow }> = ({ item }) => {
  const { t, busy, remove } = useTeamCells();
  if (item.orgWide) {
    return (
      <span className={styles.muted} title={t('in_access_title')}>
        {t('in_access')}
      </span>
    );
  }
  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(item)}>
      {t('remove')}
    </Button>
  );
};

const TeamEmpty: React.FC = () => {
  const { t, canAdd, add, openPeople } = useTeamCells();
  return (
    <div data-team-empty>
      <GridEmpty
        title={t('empty_title')}
        noMatches={t('no_matches')}
        noMatchesActions={<GridClearFilters label={t('clear_search')} />}
        actions={
          <>
            <Button disabled={!canAdd} onClick={add}>
              {t('add')}
            </Button>
            <Button variant="ghost" onClick={openPeople}>
              {t('open_people')}
            </Button>
          </>
        }
      />
    </div>
  );
};

const LOCAL_OPTIONS = {
  search: (row: TeamGridRow) => [row.person, row.email, row.roleName],
  compare: {
    person: (a: TeamGridRow, b: TeamGridRow) => a.person.localeCompare(b.person),
    role: (a: TeamGridRow, b: TeamGridRow) => a.roleName.localeCompare(b.roleName),
    scope: (a: TeamGridRow, b: TeamGridRow) => Number(b.orgWide) - Number(a.orgWide),
  },
};

export const TeamGrid: React.FC<{ rows: TeamGridRow[]; cells: TeamCells }> = ({ rows, cells }) => {
  const { t } = cells;
  const { load, reloadBridge } = useLocalGridLoad(rows, LOCAL_OPTIONS);
  const columns = useMemo<DataGridTableColumn<TeamGridRow>[]>(
    () => [
      { id: 'person', label: t('col_person'), component: PersonCell },
      { id: 'role', label: t('col_role'), component: RoleCell, width: 200 },
      { id: 'scope', label: t('col_scope'), component: ScopeCell, width: 180 },
    ],
    [t]
  );
  return (
    <TeamCellsProvider value={cells}>
      <div data-team-list>
        <ListGrid<TeamGridRow>
          name="team"
          columns={columns}
          load={load}
          search={t('search')}
          empty={TeamEmpty}
          defaultOrder={{ id: 'person', direction: 'asc' }}
          minWidth="40rem"
        >
          <DataGridRowActionsPlugin<TeamGridRow> component={RowActions} />
          {reloadBridge}
        </ListGrid>
      </div>
    </TeamCellsProvider>
  );
};

TeamGrid.displayName = 'TeamGrid';
