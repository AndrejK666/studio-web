/**
 * Admin › All identities' list on the kit's DataGrid, the way Specs draws its
 * list (#1076): identity, provider, access (where Studio records them and what
 * Keycloak still says), the assignment controls, first seen; a search over
 * names, addresses, organizations and access; the access as a quick filter;
 * header sort, by name at first.
 */

import React, { useMemo } from 'react';
import { Fingerprint } from 'lucide-react';
import {
  Badge,
  Button,
  NativeSelect,
  NativeSelectOption,
  filterTagGroup,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import type { ScreenText, Tenant } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  tagGroupChoice,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { MembershipRole, PlatformIdentity } from '../../api/types';
import { idpDrift, initials, orgMemberships, roleIn } from '../../model/members';
import { when } from './common';
import styles from './Admin.module.css';

/** The access filter's key in the grid's filters. */
export const ACCESS_FILTER_KEY = 'access';
const ACCESS: PlatformIdentity['status'][] = ['unassigned', 'assigned', 'platform_admin'];

/** What a cell needs beyond its row. */
interface IdentityCells {
  t: ScreenText;
  language: string;
  organizations: Tenant[];
  busyId: string | null;
  roleLabel: (role: string) => string;
  targetOf: (i: PlatformIdentity) => string;
  roleOf: (i: PlatformIdentity) => MembershipRole;
  onTarget: (i: PlatformIdentity, tenantId: string) => void;
  onRole: (i: PlatformIdentity, role: MembershipRole) => void;
  onAssign: (i: PlatformIdentity) => void;
}

const [IdentityCellsProvider, useIdentityCells] = createGridCells<IdentityCells>('Identities');

const nameOf = (i: PlatformIdentity) => i.display_name || i.username;

const IdentityCell: React.FC<{ item: PlatformIdentity }> = ({ item }) => (
  <div className={styles.person} data-identity={item.id}>
    <span className={styles.avatar}>{initials(nameOf(item))}</span>
    <div>
      <div className={styles.name}>{nameOf(item)}</div>
      <div className={styles.sub}>{item.email || item.username}</div>
    </div>
  </div>
);

const ProviderCell: React.FC<{ item: PlatformIdentity }> = ({ item }) => (
  <span className={styles.sub}>{item.identity_provider || 'local'}</span>
);

const AccessCell: React.FC<{ item: PlatformIdentity }> = ({ item }) => {
  const { t, roleLabel } = useIdentityCells();
  const held = orgMemberships(item);
  const drift = idpDrift(item);
  return (
    <div>
      {item.status === 'platform_admin' && <Badge variant="info">{t('directory_platform_admin')}</Badge>}
      {held === null ? (
        // Studio could not be asked: the IdP's word, labelled as such.
        item.status === 'assigned' ? (
          <>
            <Badge variant="secondary">{item.home_tenant_name || t('directory_assigned')}</Badge>
            <div className={styles.sub}>
              {item.organization_role ? `${roleLabel(item.organization_role)} · ` : ''}
              {t('ids_per_keycloak')}
            </div>
          </>
        ) : item.status === 'unassigned' ? (
          <Badge variant="warning">{t('directory_unassigned')}</Badge>
        ) : null
      ) : held.length === 0 ? (
        item.status !== 'platform_admin' && <Badge variant="warning">{t('directory_unassigned')}</Badge>
      ) : (
        held.map((m) => (
          <div key={m.org_id}>
            <Badge variant={m.status === 'active' ? 'secondary' : 'warning'} title={m.org_id}>
              {m.org_name || m.org_id.slice(0, 8)}
            </Badge>
            <div className={styles.sub}>
              {roleLabel(m.role)}
              {m.status !== 'active' ? ` · ${t('standing_suspended').toLowerCase()}` : ''}
            </div>
          </div>
        ))
      )}
      {drift && (
        <div className={styles.sub} title={t('ids_drift_hint')}>
          {drift.kind === 'home'
            ? t('ids_drift_home', { name: drift.name || t('ids_another_org') })
            : t('ids_drift_role', { role: roleLabel(drift.name) })}
        </div>
      )}
    </div>
  );
};

const AssignmentCell: React.FC<{ item: PlatformIdentity }> = ({ item }) => {
  const { t, organizations, busyId, roleLabel, targetOf, roleOf, onTarget, onRole, onAssign } = useIdentityCells();
  if (item.status === 'platform_admin') return <span className={styles.sub}>{t('ids_admin_everywhere')}</span>;
  const name = nameOf(item);
  const target = targetOf(item);
  const role = roleOf(item);
  const standing = target ? roleIn(item, target) : undefined;
  const unchanged = standing !== undefined && standing === role;
  return (
    <div className={styles.inline}>
      <NativeSelect
        size="sm"
        aria-label={t('ids_org_for', { name })}
        value={target}
        onChange={(e) => onTarget(item, e.target.value)}
      >
        <NativeSelectOption value="" disabled>
          {organizations.length === 0 ? t('ids_no_orgs') : t('ids_choose_org')}
        </NativeSelectOption>
        {organizations.map((o) => (
          <NativeSelectOption key={o.id} value={o.id}>
            {o.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        size="sm"
        aria-label={t('ids_role_for', { name })}
        value={role}
        onChange={(e) => onRole(item, e.target.value as MembershipRole)}
      >
        <NativeSelectOption value="member">{t('role_member')}</NativeSelectOption>
        <NativeSelectOption value="admin">{t('role_admin')}</NativeSelectOption>
        <NativeSelectOption value="owner">{t('role_owner')}</NativeSelectOption>
      </NativeSelect>
      <Button
        size="sm"
        disabled={busyId !== null || !target || unchanged}
        title={unchanged ? t('ids_already', { role: roleLabel(role) }) : undefined}
        onClick={() => onAssign(item)}
        data-identity-assign
      >
        {busyId === item.id ? t('saving') : standing !== undefined ? t('ids_update') : t('ids_assign')}
      </Button>
    </div>
  );
};

const FirstSeenCell: React.FC<{ item: PlatformIdentity }> = ({ item }) => (
  <span className={styles.sub}>{when(item.first_seen_at_epoch_ms, useIdentityCells().language)}</span>
);

const IdentitiesEmpty: React.FC = () => {
  const { t } = useIdentityCells();
  return (
    <GridEmpty
      icon={<Fingerprint />}
      title={t('ids_empty')}
      noMatches={t('ids_no_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export interface IdentitiesGridProps extends IdentityCells {
  identities: readonly PlatformIdentity[];
}

export function IdentitiesGrid({ identities, ...cellProps }: IdentitiesGridProps) {
  const { t } = cellProps;
  const { load, reloadBridge } = useLocalGridLoad(identities, {
    search: (i) => [
      i.display_name,
      i.username,
      i.email,
      i.home_tenant_name,
      i.status,
      ...(i.memberships ?? []).map((m) => m.org_name),
    ],
    filter: (i, filters) => {
      const access = tagGroupChoice(filters[ACCESS_FILTER_KEY]);
      return !access || i.status === access;
    },
    compare: {
      identity: (a, b) => nameOf(a).localeCompare(nameOf(b)),
      provider: (a, b) => (a.identity_provider || 'local').localeCompare(b.identity_provider || 'local'),
      first_seen: (a, b) => (a.first_seen_at_epoch_ms ?? -Infinity) - (b.first_seen_at_epoch_ms ?? -Infinity),
    },
  });

  const columns = useMemo<DataGridTableColumn<PlatformIdentity>[]>(
    () => [
      { id: 'identity', label: t('ids_col_identity'), component: IdentityCell },
      { id: 'provider', label: t('ids_col_provider'), component: ProviderCell, width: 120 },
      { id: 'access', label: t('ids_col_access'), component: AccessCell },
      { id: 'assignment', label: t('ids_col_assignment'), component: AssignmentCell },
      { id: 'first_seen', label: t('ids_col_first_seen'), component: FirstSeenCell, width: 168 },
    ],
    [t]
  );
  const filters = useMemo(
    () => [
      filterTagGroup({
        id: ACCESS_FILTER_KEY,
        label: t('ids_col_access'),
        mode: 'radio',
        options: ACCESS.map((s) => ({ value: s, label: t(`directory_${s}`) })),
      }),
    ],
    [t]
  );
  const { language, organizations, busyId, roleLabel, targetOf, roleOf, onTarget, onRole, onAssign } = cellProps;
  const cells = useMemo<IdentityCells>(
    () => ({ t, language, organizations, busyId, roleLabel, targetOf, roleOf, onTarget, onRole, onAssign }),
    [t, language, organizations, busyId, roleLabel, targetOf, roleOf, onTarget, onRole, onAssign]
  );

  return (
    <IdentityCellsProvider value={cells}>
      <ListGrid<PlatformIdentity>
        name="identities"
        label={t('ids_title')}
        columns={columns}
        load={load}
        search={t('ids_search')}
        filters={filters}
        empty={IdentitiesEmpty}
        unsortable={['access', 'assignment']}
        defaultOrder={{ id: 'identity', direction: 'asc' }}
        minWidth="64rem"
      >
        {reloadBridge}
      </ListGrid>
    </IdentityCellsProvider>
  );
}
