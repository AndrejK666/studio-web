/**
 * Admin › Organizations' list on the kit's DataGrid, the way Specs draws its
 * list (#1076): every organization the caller sees, with what tells two of the
 * same name apart (id, workspaces, owners, members); a search by name, id and
 * workspace; sorted by name. The organization the path bar picked is marked;
 * the rows do not switch it.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Building2 } from 'lucide-react';
import { apiRegistry } from '@gears-frontx/react';
import { Badge, Card, CardContent, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import type { ScreenText, Tenant } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import { AdminApiService } from '../../api/AdminApiService';
import type { OrgMember } from '../../api/types';
import { duplicateNames, memberName } from '../../model/members';
import { shortId, useAdmin } from './common';
import styles from './Admin.module.css';

type Room = OrgMember[] | 'denied';

/** What a cell needs beyond its row. */
interface OrganizationCells {
  t: ScreenText;
  members: Record<string, Room>;
  workspaces: Record<string, Tenant[]>;
  duplicates: Set<string>;
  selectedId: string | null;
}

const [OrganizationCellsProvider, useOrganizationCells] = createGridCells<OrganizationCells>('Organizations');

const NameCell: React.FC<{ item: Tenant }> = ({ item }) => {
  const { t, duplicates, selectedId } = useOrganizationCells();
  return (
    <div className={selectedId === item.id ? styles.selected : undefined} data-org-row={item.id}>
      <div className={styles.name}>
        {item.name}{' '}
        {duplicates.has(item.name.trim().toLowerCase()) && (
          <Badge variant="warning" title={t('org_same_name_hint')}>
            {t('org_same_name')}
          </Badge>
        )}
      </div>
      <div className={`${styles.sub} ${styles.mono}`} title={item.id}>
        {shortId(item.id)}
      </div>
    </div>
  );
};

const WorkspacesCell: React.FC<{ item: Tenant }> = ({ item }) => {
  const ws = useOrganizationCells().workspaces[item.id] ?? [];
  return <span className={styles.sub}>{ws.length ? ws.map((w) => w.name).join(', ') : '—'}</span>;
};

const OwnersCell: React.FC<{ item: Tenant }> = ({ item }) => {
  const { t, members } = useOrganizationCells();
  const room = members[item.id];
  if (room === undefined) return <span className={styles.sub}>…</span>;
  if (room === 'denied') return <span className={styles.sub}>{t('org_not_yours')}</span>;
  const owners = room.filter((m) => m.role === 'owner' && m.status === 'active');
  return owners.length ? (
    <span className={styles.sub}>{owners.map(memberName).join(', ')}</span>
  ) : (
    <Badge variant="warning">{t('no_owner')}</Badge>
  );
};

const MembersCell: React.FC<{ item: Tenant }> = ({ item }) => {
  const room = useOrganizationCells().members[item.id];
  return (
    <div className={`${styles.sub} ${styles.num}`}>
      {room && room !== 'denied' ? room.length : room === 'denied' ? '—' : '…'}
    </div>
  );
};

const OrganizationsEmpty: React.FC = () => {
  const { t } = useOrganizationCells();
  return (
    <GridEmpty
      icon={<Building2 />}
      title={t('org_none')}
      noMatches={t('org_no_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export function OrganizationsGrid({
  orgs,
  workspaces,
  selectedId,
}: {
  orgs: Tenant[];
  workspaces: Record<string, Tenant[]>;
  selectedId: string | null;
}) {
  const { t } = useAdmin();
  const [members, setMembers] = useState<Record<string, Room>>({});

  useEffect(() => {
    let live = true;
    const api = apiRegistry.getService(AdminApiService);
    void Promise.all(
      orgs.map(async (org) => {
        try {
          return [org.id, await api.orgMembers(org.id)] as const;
        } catch {
          // Not an owner of this one: its room is not ours to see.
          return [org.id, 'denied' as const] as const;
        }
      })
    ).then((pairs) => live && setMembers(Object.fromEntries(pairs)));
    return () => {
      live = false;
    };
  }, [orgs]);

  // Same-named organizations are the reason this list exists; flag them.
  const duplicates = useMemo(() => duplicateNames(orgs), [orgs]);
  const { load, reloadBridge } = useLocalGridLoad(orgs, {
    search: (o) => [o.name, o.id, ...(workspaces[o.id] ?? []).map((w) => w.name)],
    compare: { organization: (a, b) => a.name.localeCompare(b.name) },
  });

  const columns = useMemo<DataGridTableColumn<Tenant>[]>(
    () => [
      { id: 'organization', label: t('org_col_name'), component: NameCell },
      { id: 'workspaces', label: t('org_col_workspaces'), component: WorkspacesCell },
      { id: 'owners', label: t('org_col_owners'), component: OwnersCell },
      { id: 'members', label: t('org_col_members'), component: MembersCell, width: 104 },
    ],
    [t]
  );
  const cells = useMemo<OrganizationCells>(
    () => ({ t, members, workspaces, duplicates, selectedId }),
    [t, members, workspaces, duplicates, selectedId]
  );

  return (
    <Card data-org-table>
      <CardContent className={styles.cardBody}>
        <h3 className={styles.subtitle}>{t('org_all')}</h3>
        <OrganizationCellsProvider value={cells}>
          <ListGrid<Tenant>
            name="organizations"
            label={t('org_all')}
            columns={columns}
            load={load}
            search={t('org_search')}
            empty={OrganizationsEmpty}
            unsortable={['workspaces', 'owners', 'members']}
            defaultOrder={{ id: 'organization', direction: 'asc' }}
            minWidth="40rem"
          >
            {reloadBridge}
          </ListGrid>
        </OrganizationCellsProvider>
      </CardContent>
    </Card>
  );
}
