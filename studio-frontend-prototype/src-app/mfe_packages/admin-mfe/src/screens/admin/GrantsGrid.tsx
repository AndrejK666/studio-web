/**
 * Admin › Access' grants on the kit's DataGrid, the way Specs draws its list
 * (#1076): who (a member or a team), which role, where (the whole organization
 * or one workspace), and Remove. The grants are the access document's draft:
 * a removal waits for Save, as before. Header sort by subject, role and scope.
 */

import React, { useMemo } from 'react';
import { KeyRound } from 'lucide-react';
import { Badge, Button, DataGridRowActionsPlugin, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import type { ScreenText } from '@constructor-studio/mfe-shared';
import { GridEmpty, ListGrid, createGridCells, useLocalGridLoad } from '@constructor-studio/mfe-shared/grid';
import type { GrantDef, RoleDef } from '../../model/access';
import styles from './Admin.module.css';

/** What a cell needs beyond its row. */
interface GrantCells {
  t: ScreenText;
  roleName: (key: string) => string;
  onRemove: (grant: GrantDef) => void;
}

const [GrantCellsProvider, useGrantCells] = createGridCells<GrantCells>('Grants');

const SubjectCell: React.FC<{ item: GrantDef }> = ({ item }) => {
  const { t } = useGrantCells();
  return (
    <span data-access-grant={item.id}>
      <Badge variant="secondary">{t(`access_subject_${item.subjectType}`)}</Badge> {item.subjectName}
    </span>
  );
};

const RoleCell: React.FC<{ item: GrantDef }> = ({ item }) => <span>{useGrantCells().roleName(item.roleKey)}</span>;

const scopeText = (t: ScreenText, g: GrantDef) =>
  g.scopeType === 'org' ? t('access_scope_org', { name: g.scopeName }) : g.scopeName;

const ScopeCell: React.FC<{ item: GrantDef }> = ({ item }) => (
  <span className={styles.sub}>{scopeText(useGrantCells().t, item)}</span>
);

const RowActions: React.FC<{ item: GrantDef }> = ({ item }) => {
  const { t, onRemove } = useGrantCells();
  return (
    <Button size="sm" variant="ghost" onClick={() => onRemove(item)}>
      {t('remove')}
    </Button>
  );
};

const GrantsEmpty: React.FC = () => {
  const { t } = useGrantCells();
  return <GridEmpty icon={<KeyRound />} title={t('access_no_grants')} noMatches={t('access_no_grants')} />;
};

export function GrantsGrid({
  t,
  grants,
  roles,
  onRemove,
}: {
  t: ScreenText;
  grants: GrantDef[];
  roles: RoleDef[];
  onRemove: (grant: GrantDef) => void;
}) {
  const roleName = useMemo(() => {
    const names = new Map(roles.map((r) => [r.key, r.name]));
    return (key: string) => names.get(key) ?? key;
  }, [roles]);
  const { load, reloadBridge } = useLocalGridLoad(grants, {
    compare: {
      subject: (a, b) => a.subjectName.localeCompare(b.subjectName),
      role: (a, b) => roleName(a.roleKey).localeCompare(roleName(b.roleKey)),
      scope: (a, b) => scopeText(t, a).localeCompare(scopeText(t, b)),
    },
  });
  const columns = useMemo<DataGridTableColumn<GrantDef>[]>(
    () => [
      { id: 'subject', label: t('access_col_subject'), component: SubjectCell },
      { id: 'role', label: t('access_col_role'), component: RoleCell },
      { id: 'scope', label: t('access_col_scope'), component: ScopeCell },
    ],
    [t]
  );
  const cells = useMemo<GrantCells>(() => ({ t, roleName, onRemove }), [t, roleName, onRemove]);

  return (
    <GrantCellsProvider value={cells}>
      <ListGrid<GrantDef>
        name="access_grants"
        label={t('access_grants')}
        columns={columns}
        load={load}
        empty={GrantsEmpty}
        minWidth="40rem"
      >
        <DataGridRowActionsPlugin<GrantDef> component={RowActions} />
        {reloadBridge}
      </ListGrid>
    </GrantCellsProvider>
  );
}
