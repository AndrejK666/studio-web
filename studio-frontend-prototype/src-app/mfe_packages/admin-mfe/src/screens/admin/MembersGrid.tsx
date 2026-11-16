/**
 * Admin › People's member list on the kit's DataGrid, the way Specs draws its
 * list (#1076): person, position, role, standing, last seen, how they joined;
 * a search over names, addresses, role, standing and position; the standing as
 * a quick filter; header sort, by name at first. A role is changed in its
 * cell; Suspend or Resume and Remove sit in the row's actions, kept from the
 * only active owner. The ▸ of a person opens what they are known by — below
 * the list, not under the row.
 */

import React, { useMemo } from 'react';
import { Users } from 'lucide-react';
import {
  Badge,
  Button,
  DataGridRowActionsPlugin,
  NativeSelect,
  NativeSelectOption,
  filterTagGroup,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import type { ScreenText } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  tagGroupChoice,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { MembershipRole, OrgMember } from '../../api/types';
import { directoryLine, initials, memberName, otherEmails, primaryEmail } from '../../model/members';
import { shortId, when } from './common';
import styles from './Admin.module.css';

export const ROLES: MembershipRole[] = ['owner', 'admin', 'member'];

/** A row of the grid: a member, by their user id. */
export type MemberRow = OrgMember & { id: string };

/** The standing filter's key in the grid's filters. */
export const STANDING_FILTER_KEY = 'standing';

/** What a cell needs beyond its row. */
interface MemberCells {
  t: ScreenText;
  language: string;
  /** A write in flight: every control waits. */
  busy: boolean;
  activeOwners: number;
  open: string | null;
  nameOfId: (userId: string) => string | undefined;
  onToggle: (m: OrgMember) => void;
  onStanding: (m: OrgMember, role: MembershipRole, status: 'active' | 'suspended') => void;
  onRemove: (m: OrgMember) => void;
}

const [MemberCellsProvider, useMemberCells] = createGridCells<MemberCells>('Members');

/** The only active owner can be neither demoted, suspended nor removed. */
const onlyOwnerOf = (m: OrgMember, activeOwners: number) =>
  m.role === 'owner' && m.status !== 'suspended' && activeOwners <= 1;

const PersonCell: React.FC<{ item: MemberRow }> = ({ item }) => {
  const { t, open, onToggle } = useMemberCells();
  const name = memberName(item);
  const others = otherEmails(item);
  const first = primaryEmail(item);
  return (
    <div className={styles.person} data-member={item.user_id}>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open === item.user_id}
        aria-label={t('people_details', { name })}
        onClick={() => onToggle(item)}
      >
        {open === item.user_id ? '▾' : '▸'}
      </Button>
      {item.avatar_url ? (
        <img className={styles.avatar} src={item.avatar_url} alt="" />
      ) : (
        <span className={styles.avatar}>{initials(name)}</span>
      )}
      <div>
        <div className={styles.name}>{name}</div>
        <div className={styles.sub}>
          {first && first !== name ? first : shortId(item.user_id)}
          {others.length > 0 && <span title={others.map((x) => x.address).join(', ')}> +{others.length}</span>}
        </div>
      </div>
    </div>
  );
};

const PositionCell: React.FC<{ item: MemberRow }> = ({ item }) => {
  const line = directoryLine(item.directory, useMemberCells().nameOfId);
  return <span>{line || <span className={styles.sub}>—</span>}</span>;
};

const RoleCell: React.FC<{ item: MemberRow }> = ({ item }) => {
  const { t, busy, activeOwners, onStanding } = useMemberCells();
  const onlyOwner = onlyOwnerOf(item, activeOwners);
  return (
    <NativeSelect
      size="sm"
      aria-label={t('people_role_of', { name: memberName(item) })}
      value={item.role}
      disabled={busy || onlyOwner}
      title={onlyOwner ? t('people_only_owner') : undefined}
      onChange={(e) => onStanding(item, e.target.value as MembershipRole, item.status)}
    >
      {ROLES.map((r) => (
        <NativeSelectOption key={r} value={r} title={t(`role_${r}_hint`)}>
          {t(`role_${r}`)}
        </NativeSelectOption>
      ))}
      {!ROLES.includes(item.role as MembershipRole) && <NativeSelectOption value={item.role}>{item.role}</NativeSelectOption>}
    </NativeSelect>
  );
};

const StandingCell: React.FC<{ item: MemberRow }> = ({ item }) => {
  const { t } = useMemberCells();
  const suspended = item.status === 'suspended';
  return (
    <Badge variant={suspended ? 'warning' : 'success'}>
      {suspended ? t('standing_suspended') : t('standing_active')}
    </Badge>
  );
};

const SeenCell: React.FC<{ item: MemberRow }> = ({ item }) => (
  <span className={styles.sub}>{when(item.last_seen_at_epoch_ms, useMemberCells().language)}</span>
);

const JoinedCell: React.FC<{ item: MemberRow }> = ({ item }) => {
  const { t, language } = useMemberCells();
  const source = ['creation', 'assignment', 'invitation', 'bootstrap', 'first_login', 'manual'].includes(item.source)
    ? t(`joined_${item.source}`)
    : item.source;
  return (
    <span className={styles.sub}>
      {source} · {when(item.created_at_epoch_ms, language)}
    </span>
  );
};

const RowActions: React.FC<{ item: MemberRow }> = ({ item }) => {
  const { t, busy, activeOwners, onStanding, onRemove } = useMemberCells();
  const suspended = item.status === 'suspended';
  const onlyOwner = onlyOwnerOf(item, activeOwners);
  return (
    <div className={styles.inline}>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || (onlyOwner && !suspended)}
        onClick={() => onStanding(item, item.role as MembershipRole, suspended ? 'active' : 'suspended')}
        data-member-standing
      >
        {suspended ? t('people_resume') : t('people_suspend')}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy || onlyOwner} onClick={() => onRemove(item)} data-member-remove>
        {t('people_remove')}
      </Button>
    </div>
  );
};

const MembersEmpty: React.FC = () => {
  const { t } = useMemberCells();
  return (
    <GridEmpty
      icon={<Users />}
      title={t('people_empty')}
      note={t('people_empty_hint')}
      noMatches={t('people_no_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

const byNumber = (pick: (m: MemberRow) => number | null | undefined) => (a: MemberRow, b: MemberRow) =>
  (pick(a) ?? -Infinity) - (pick(b) ?? -Infinity);

export interface MembersGridProps extends MemberCells {
  members: readonly OrgMember[];
}

export function MembersGrid({ members, ...cellProps }: MembersGridProps) {
  const { t, nameOfId } = cellProps;
  const rows = useMemo<MemberRow[]>(() => members.map((m) => ({ ...m, id: m.user_id })), [members]);
  const { load, reloadBridge } = useLocalGridLoad(rows, {
    search: (m) => [
      m.display_name,
      ...(m.emails?.map((x) => x.address) ?? [m.email]),
      m.role,
      m.status,
      directoryLine(m.directory, nameOfId),
    ],
    filter: (m, filters) => {
      const standing = tagGroupChoice(filters[STANDING_FILTER_KEY]);
      return !standing || m.status === standing;
    },
    compare: {
      person: (a, b) => memberName(a).localeCompare(memberName(b)),
      role: (a, b) => a.role.localeCompare(b.role),
      standing: (a, b) => a.status.localeCompare(b.status),
      seen: byNumber((m) => m.last_seen_at_epoch_ms),
      joined: byNumber((m) => m.created_at_epoch_ms),
    },
  });

  const columns = useMemo<DataGridTableColumn<MemberRow>[]>(
    () => [
      { id: 'person', label: t('people_col_person'), component: PersonCell },
      { id: 'position', label: t('people_col_position'), component: PositionCell },
      { id: 'role', label: t('people_col_role'), component: RoleCell, width: 140 },
      { id: 'standing', label: t('people_col_standing'), component: StandingCell, width: 120 },
      { id: 'seen', label: t('people_col_seen'), component: SeenCell, width: 168 },
      { id: 'joined', label: t('people_col_joined'), component: JoinedCell },
    ],
    [t]
  );
  const filters = useMemo(
    () => [
      filterTagGroup({
        id: STANDING_FILTER_KEY,
        label: t('people_col_standing'),
        mode: 'radio',
        options: [
          { value: 'active', label: t('standing_active') },
          { value: 'suspended', label: t('standing_suspended') },
        ],
      }),
    ],
    [t]
  );
  const { language, busy, activeOwners, open, onToggle, onStanding, onRemove } = cellProps;
  const cells = useMemo<MemberCells>(
    () => ({ t, language, busy, activeOwners, open, nameOfId, onToggle, onStanding, onRemove }),
    [t, language, busy, activeOwners, open, nameOfId, onToggle, onStanding, onRemove]
  );

  return (
    <MemberCellsProvider value={cells}>
      <ListGrid<MemberRow>
        name="members"
        label={t('people_col_person')}
        columns={columns}
        load={load}
        search={t('people_search')}
        filters={filters}
        empty={MembersEmpty}
        unsortable={['position']}
        defaultOrder={{ id: 'person', direction: 'asc' }}
        minWidth="64rem"
      >
        <DataGridRowActionsPlugin<MemberRow> component={RowActions} />
        {reloadBridge}
      </ListGrid>
    </MemberCellsProvider>
  );
}
