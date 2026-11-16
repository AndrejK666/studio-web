/**
 * The project's issues on the kit's DataGrid, the way Specs draws its list
 * (#1076): the verdict line over it, then search by title, kind and place,
 * filters for the group, the kind and the document, header sort by kind and
 * status, pages, the list's empty state, the portal theme. A click on a row
 * opens what there is to decide about it under its title; Create issue sits in
 * its actions and opens the issue's form there too.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  DataGridRowActionsPlugin,
  DataGridRowClickPlugin,
  filterTagGroup,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import {
  GridEmpty,
  ListGrid,
  NoData,
  createGridCells,
  listChoices,
  tagGroupChoice,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { NewIssue, SpecModelReadiness } from '../../api/types';
import { GROUP_ORDER, type IssueRow, type RowGroup } from '../../model/issue-rows';
import { DocItem, IssueForm, Prose, QueueItem, type Text } from './IssueItems';
import styles from './IssuesScreen.module.css';

type Person = { name: string; login: string };

/** A row of the grid: an issue, by its key. */
export type IssueGridRow = IssueRow & { id: string };

/** The filter keys the grid hands `load`. */
export const ISSUE_FILTERS = { group: 'group', kind: 'kind', document: 'document' } as const;

type Filters = Record<string, { value?: unknown } | undefined>;

/** Whether `row` passes the grid's filters: the group chosen, any kind chosen, any document chosen. */
export function keepsIssue(row: IssueRow, filters: Filters): boolean {
  const group = tagGroupChoice(filters[ISSUE_FILTERS.group]);
  if (group && row.group !== group) return false;
  const kinds = listChoices(filters[ISSUE_FILTERS.kind]);
  if (kinds.length > 0 && !kinds.includes(row.kindId)) return false;
  const documents = listChoices(filters[ISSUE_FILTERS.document]);
  return documents.length === 0 || (!!row.side && documents.includes(row.side.path));
}

const distinct = (values: (string | null | undefined)[]) =>
  [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));

/** What a cell needs beyond its row. */
interface IssueCells {
  t: Text;
  built: boolean;
  people: Person[];
  /** The issue already opened for a row, if any. */
  issueOf: (r: IssueRow) => string | null;
  /** The row opened to decide about it, and the row whose issue form is open. */
  expanded: string | null;
  opening: string | null;
  toggleOpening: (key: string) => void;
  closeOpening: () => void;
  onDecide: React.ComponentProps<typeof QueueItem>['onDecide'];
  onPropose: React.ComponentProps<typeof QueueItem>['onPropose'];
  onSave: React.ComponentProps<typeof DocItem>['onSave'];
  onSameThing: React.ComponentProps<typeof DocItem>['onSameThing'];
  onProposeSentence: React.ComponentProps<typeof DocItem>['onProposeSentence'];
  onCreateIssue: (key: string, issue: NewIssue) => Promise<unknown>;
  onOpenFile: (path: string) => void;
}

const [IssueCellsProvider, useIssueCells] = createGridCells<IssueCells>('Issues');

/** Whether a row offers Create issue: none opened yet, and the server's row says it may. */
const canCreate = (row: IssueRow, issueOf: IssueCells['issueOf']) =>
  !issueOf(row) && (row.queue ? row.queue.actions.includes('create_issue') : true);

const KindCell: React.FC<{ item: IssueGridRow }> = ({ item }) => {
  const { t } = useIssueCells();
  return <Badge variant={item.tone === 'bad' ? 'danger' : 'warning'}>{t(`kind_${item.kindId}`)}</Badge>;
};

/** The title, and under it the issue's form and what to decide, while they are open. */
const IssueCell: React.FC<{ item: IssueGridRow }> = ({ item }) => {
  const cells = useIssueCells();
  const { t, expanded, opening } = cells;
  const kindLabel = t(`kind_${item.kindId}`);
  return (
    <div className={styles.titleCell} data-issue-row={item.key} data-expanded={expanded === item.key}>
      <Prose text={item.title} />
      {opening === item.key && canCreate(item, cells.issueOf) && (
        <div className={styles.detail} data-grid-row-ignore-click>
          <IssueForm
            row={item}
            people={cells.people}
            t={t}
            onCancel={cells.closeOpening}
            onCreate={(issue) => cells.onCreateIssue(item.key, issue).then((x) => (cells.closeOpening(), x))}
          />
        </div>
      )}
      {expanded === item.key && (item.queue || item.doc) && (
        <div className={styles.detail} data-grid-row-ignore-click>
          {item.queue ? (
            <QueueItem
              item={item.queue}
              kindLabel={kindLabel}
              onDecide={cells.onDecide}
              onPropose={cells.onPropose}
              onOpenFile={cells.onOpenFile}
              t={t}
            />
          ) : item.doc ? (
            <DocItem
              item={item.doc}
              kindLabel={kindLabel}
              onSave={cells.onSave}
              onSameThing={cells.onSameThing}
              onProposeSentence={cells.onProposeSentence}
              onOpenFile={cells.onOpenFile}
              t={t}
            />
          ) : null}
        </div>
      )}
    </div>
  );
};

const WhereCell: React.FC<{ item: IssueGridRow }> = ({ item }) => {
  const { t } = useIssueCells();
  if (!item.side) return <NoData label={t('no_where')} />;
  return (
    <code className={styles.where} title={item.side.path}>
      {item.side.path.split('/').pop()}
      {item.side.line_start ? `:${item.side.line_start}` : ''}
    </code>
  );
};

const StatusCell: React.FC<{ item: IssueGridRow }> = ({ item }) => {
  const { t, issueOf } = useIssueCells();
  const url = issueOf(item);
  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className={styles.issueLink} data-grid-row-ignore-click>
        {t('issue_number', { number: url.split('/').pop() ?? '' })}
      </a>
    );
  }
  return <span className={`${styles.muted} ${styles[`status_${item.group}`] ?? ''}`}>{t(`status_${item.group}`)}</span>;
};

const RowActions: React.FC<{ item: IssueGridRow }> = ({ item }) => {
  const { t, issueOf, toggleOpening } = useIssueCells();
  if (!canCreate(item, issueOf)) return null;
  return (
    <Button size="sm" variant="ghost" onClick={() => toggleOpening(item.key)} data-issue-create={item.key}>
      {t('create_issue')}
    </Button>
  );
};

const IssuesEmpty: React.FC = () => {
  const { t, built } = useIssueCells();
  return (
    <GridEmpty
      title={built ? t('empty_built') : t('empty_unbuilt')}
      note={built ? undefined : t('empty_unbuilt_body')}
      noMatches={t('nothing_matches')}
    />
  );
};

export interface IssuesGridProps {
  rows: IssueRow[];
  readiness: SpecModelReadiness;
  built: boolean;
  people: Person[];
  issueOf: (r: IssueRow) => string | null;
  t: Text;
  onDecide: IssueCells['onDecide'];
  onPropose: IssueCells['onPropose'];
  onSave: IssueCells['onSave'];
  onSameThing: IssueCells['onSameThing'];
  onProposeSentence: IssueCells['onProposeSentence'];
  onCreateIssue: IssueCells['onCreateIssue'];
  onOpenFile: (path: string) => void;
}

export const IssuesGrid: React.FC<IssuesGridProps> = ({
  rows,
  readiness,
  built,
  people,
  issueOf,
  t,
  onDecide,
  onPropose,
  onSave,
  onSameThing,
  onProposeSentence,
  onCreateIssue,
  onOpenFile,
}) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const gridRows = useMemo<IssueGridRow[]>(() => rows.map((r) => ({ ...r, id: r.key })), [rows]);
  const { load, reloadBridge } = useLocalGridLoad(gridRows, {
    search: (r) => [r.title, t(`kind_${r.kindId}`), r.side?.path],
    filter: keepsIssue,
    compare: {
      kind: (a, b) => t(`kind_${a.kindId}`).localeCompare(t(`kind_${b.kindId}`)),
      status: (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
    },
  });

  const n = (g: RowGroup) => rows.filter((r) => r.group === g).length;
  const columns = useMemo<DataGridTableColumn<IssueGridRow>[]>(
    () => [
      { id: 'kind', label: t('col_kind'), component: KindCell, width: 180 },
      { id: 'issue', label: t('col_issue'), component: IssueCell },
      { id: 'where', label: t('col_where'), component: WhereCell, width: 180 },
      { id: 'status', label: t('col_status'), component: StatusCell, width: 160 },
    ],
    [t]
  );
  // The options a filter offers are the ones the rows have: one entity list per set of them.
  const groups = GROUP_ORDER.map((g) => `${g}:${n(g)}`).join(',');
  const kinds = distinct(rows.map((r) => r.kindId)).join(',');
  const documents = distinct(rows.map((r) => r.side?.path)).join('\n');
  const filters = useMemo(() => {
    const counted = groups.split(',').map((entry) => entry.split(':') as [RowGroup, string]);
    return [
      filterTagGroup({
        id: ISSUE_FILTERS.group,
        label: t('filter_group'),
        mode: 'radio',
        options: counted
          .filter(([, count]) => count !== '0')
          .map(([g, count]) => ({ value: g, label: `${t(`filter_${g}`)} (${count})` })),
      }),
      filterTagGroup({
        id: ISSUE_FILTERS.kind,
        label: t('col_kind'),
        options: (kinds ? kinds.split(',') : []).map((value) => ({ value, label: t(`kind_${value}`) })),
      }),
      filterTagGroup({
        id: ISSUE_FILTERS.document,
        label: t('filter_document'),
        options: (documents ? documents.split('\n') : []).map((value) => ({ value, label: value })),
      }),
    ];
  }, [t, groups, kinds, documents]);

  const toggle = useCallback((row: IssueGridRow) => setExpanded((open) => (open === row.key ? null : row.key)), []);
  const cells = useMemo<IssueCells>(
    () => ({
      t,
      built,
      people,
      issueOf,
      expanded,
      opening,
      toggleOpening: (key) => setOpening((open) => (open === key ? null : key)),
      closeOpening: () => setOpening(null),
      onDecide,
      onPropose,
      onSave,
      onSameThing,
      onProposeSentence,
      onCreateIssue,
      onOpenFile,
    }),
    [
      t,
      built,
      people,
      issueOf,
      expanded,
      opening,
      onDecide,
      onPropose,
      onSave,
      onSameThing,
      onProposeSentence,
      onCreateIssue,
      onOpenFile,
    ]
  );

  return (
    <div className={styles.resolve}>
      <div className={styles.verdict} data-verdict>
        <b className={readiness.ready ? styles.ok : styles.bad}>
          {readiness.ready ? t('verdict_ready') : t.count('verdict_blocking', readiness.blocking)}
        </b>
        <span className={styles.muted}>
          {' · '}
          {t('verdict_rest', { look: n('look'), improve: n('improve') })}
          {readiness.total > 0 ? ` · ${t('verdict_cited', { cited: readiness.cited, total: readiness.total })}` : ''}
        </span>
        {!built && <span className={styles.muted}> · {t('verdict_not_built')}</span>}
      </div>

      <IssueCellsProvider value={cells}>
        <ListGrid<IssueGridRow>
          name="issues"
          columns={columns}
          load={load}
          search={t('search')}
          filters={filters}
          empty={IssuesEmpty}
          unsortable={['issue', 'where']}
          minWidth="56rem"
        >
          <DataGridRowClickPlugin<IssueGridRow> click={toggle} />
          <DataGridRowActionsPlugin<IssueGridRow> component={RowActions} />
          {reloadBridge}
        </ListGrid>
      </IssueCellsProvider>
    </div>
  );
};

IssuesGrid.displayName = 'IssuesGrid';
