/**
 * The organization's people on the kit's DataGrid, the way Specs draws its
 * list (#1076): search by name, address and directory line, header sort by
 * name or last seen, pages, the list's empty state, the portal theme. A click
 * on a row opens the person's panel; a project mark opens that project's Team.
 */

import React, { useMemo } from 'react';
import { Badge, Button, DataGridRowClickPlugin, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import type { AccessModel, OrgProject, PersonProject, PersonRow, ScreenText } from '@constructor-studio/mfe-shared';
import { GridEmpty, ListGrid, createGridCells, useLocalGridLoad } from '@constructor-studio/mfe-shared/grid';
import { PersonPhoto, ProjectStackCell } from './ProjectMarks';
import { fullTime, membershipLabel, relTime } from './words';
import styles from './PeopleScreen.module.css';

/** A person in the list, with what the screen worked out for them. */
export type PersonGridRow = PersonRow & {
  /** When they were last seen, from any source; none when no source has it. */
  seen: number | undefined;
  /** Who they report to and their title, from the directory; `''` without one. */
  line: string;
};

/** Unknown instants sort as the oldest. */
const bySeen = (a: PersonGridRow, b: PersonGridRow) => (a.seen ?? 0) - (b.seen ?? 0);

const LOCAL_OPTIONS = {
  search: (row: PersonGridRow) => [row.name, row.email, row.line],
  compare: {
    person: (a: PersonGridRow, b: PersonGridRow) => a.name.localeCompare(b.name),
    seen: bySeen,
  },
};

/** What a cell needs beyond its row. */
export interface PeopleCells {
  t: ScreenText;
  language: string;
  /** The instant "3 h ago" counts from, kept by the screen. */
  now: number;
  model: AccessModel;
  /** How many projects the organization has, for "of N". */
  projectCount: number;
  /** Whether the activity sources are still being read. */
  loading: boolean;
  online: ReadonlySet<string>;
  stackOf: (person: PersonRow) => { shown: PersonProject[]; more: number; total: number };
  hasHandle: (person: PersonRow) => boolean;
  openPerson: (person: PersonRow) => void;
  openProject: (project: OrgProject) => void;
  invite: () => void;
}

const [PeopleCellsProvider, usePeopleCells] = createGridCells<PeopleCells>('People');

const PersonCell: React.FC<{ item: PersonGridRow }> = ({ item }) => {
  const { openPerson } = usePeopleCells();
  return (
    <div className={styles.pcell} data-person={item.id}>
      <PersonPhoto name={item.name} url={item.avatarUrl} />
      <div>
        <button type="button" className={styles.pname} data-grid-row-ignore-click onClick={() => openPerson(item)}>
          {item.name}
        </button>
        <div className={styles.muted}>{[item.email, item.line].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  );
};

const MembershipCell: React.FC<{ item: PersonGridRow }> = ({ item }) => {
  const { t } = usePeopleCells();
  return <span className={styles.muted}>{membershipLabel(item.role, t)}</span>;
};

const ProjectsCell: React.FC<{ item: PersonGridRow }> = ({ item }) => {
  const { t, model, projectCount, loading, stackOf, hasHandle, openPerson, openProject } = usePeopleCells();
  // The marks stop their clicks themselves: a click beside them opens the person, as the row does.
  return (
    <ProjectStackCell
      stack={stackOf(item)}
      model={model}
      projectCount={projectCount}
      hasHandle={hasHandle(item)}
      loading={loading}
      t={t}
      onOpen={(r) => openProject(r.project)}
      onMore={() => openPerson(item)}
    />
  );
};

const SeenCell: React.FC<{ item: PersonGridRow }> = ({ item }) => {
  const { t, language, now, online } = usePeopleCells();
  if (online.has(item.id)) return <Badge variant="success">{t('online')}</Badge>;
  return (
    <span className={styles.muted} title={fullTime(item.seen, language)}>
      {relTime(item.seen, language, now)}
    </span>
  );
};

const PeopleEmpty: React.FC = () => {
  const { t, invite } = usePeopleCells();
  return (
    <GridEmpty
      title={t('empty_title')}
      noMatches={t('no_matches')}
      actions={
        <Button onClick={invite} data-people-empty>
          {t('invite')}
        </Button>
      }
    />
  );
};

export const PeopleGrid: React.FC<{
  rows: PersonGridRow[];
  /** Whether some source has a last-seen instant for somebody: the column shows only then. */
  anySeen: boolean;
  cells: PeopleCells;
}> = ({ rows, anySeen, cells }) => {
  const { t, model } = cells;
  const { load, reloadBridge } = useLocalGridLoad(rows, LOCAL_OPTIONS);
  const columns = useMemo<DataGridTableColumn<PersonGridRow>[]>(() => {
    const list: DataGridTableColumn<PersonGridRow>[] = [
      { id: 'person', label: t('col_person'), component: PersonCell },
      { id: 'membership', label: t('col_membership'), component: MembershipCell, width: 140 },
      {
        id: 'projects',
        label: model === 'roles' ? t('col_projects_roles') : t('col_projects_tenant'),
        component: ProjectsCell,
      },
    ];
    if (anySeen) list.push({ id: 'seen', label: t('col_seen'), component: SeenCell, width: 140 });
    return list;
  }, [t, model, anySeen]);
  return (
    <PeopleCellsProvider value={cells}>
      <ListGrid<PersonGridRow>
        name="people"
        columns={columns}
        load={load}
        search={t('search')}
        empty={PeopleEmpty}
        unsortable={['membership', 'projects']}
        defaultOrder={{ id: 'person', direction: 'asc' }}
        minWidth="48rem"
      >
        <DataGridRowClickPlugin<PersonGridRow> click={cells.openPerson} />
        {reloadBridge}
      </ListGrid>
    </PeopleCellsProvider>
  );
};

PeopleGrid.displayName = 'PeopleGrid';
