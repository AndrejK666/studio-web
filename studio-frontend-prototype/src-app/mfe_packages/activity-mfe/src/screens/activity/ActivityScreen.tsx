/**
 * Project › Activity, the prototype's `activity-view.tsx`: a header (what is
 * kept is its "about" line; how many comments and checks are its chips), the
 * kinds as a one-choice filter — Comments first when there are any, since a
 * check is a machine's and a comment a person's — and the list of Event /
 * Document / By / Recorded. A run of the same check one after another (a
 * sync that checked every document) is one row, "220 documents", which opens
 * to its events under the list.
 *
 * The By column writes the detector that made a check — `leak`, `purpose`,
 * `bloat` — where the product writes "Studio". One read
 * (`GET /studio-artifact-ingest/v1/activity`): the ordering, the naming and
 * the two kinds are the gear's (`artifact_ingest/activity.rs`). It needs no
 * other kit: nothing here is project-lifecycle's.
 *
 * The list is the kit's DataGrid, the way Specs draws its list (#1076):
 * search, the kind filter, header sort, pages, its own empty states. The
 * search, the kind and the sort live in the address (`act.`), as the
 * prototype's lists did (the shared list state).
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import {
  Badge,
  filterTagGroup,
  useDataGrid,
  type DataGridFiltersPluginApi,
  type DataGridLoadContext,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import { errorMessage, readListState, refusalText, type ScreenText } from '@constructor-studio/mfe-shared';
import {
  GridAddress,
  GridClearFilters,
  GridEmpty,
  GridFailed,
  ListGrid,
  createGridCells,
  pageOfRows,
  shownRows,
  tagGroupChoice,
  useLocalGridReload,
  writeGridAddress,
} from '@constructor-studio/mfe-shared/grid';
import { ActivityApiService } from '../../api/ActivityApiService';
import type { ActivityEvent } from '../../api/types';
import {
  KIND_CHOICES,
  RUN_SHOWN,
  countOf,
  isKindChoice,
  recordedAt,
  rowsFor,
  searchText,
  shownKind,
  type ActivityRow,
  type KindChoice,
} from '../../model/activity';
import { PageLoading, ProjectPage } from '@constructor-studio/mfe-shared/page';
import styles from '../Screen.module.css';

const errText = (e: unknown) => refusalText(e) ?? errorMessage(e);

/** Where the list keeps its search, kind and sort in the address. */
const ADDRESS_PREFIX = 'act.';
/** The kind filter's key, in the grid and in the address (`act.f.kind`). */
const KIND_FILTER = 'kind';
const ADDRESS_FILTERS = [KIND_FILTER] as const;

/** "3 h ago", in the screen's language; the full instant is on hover. */
export function relTime(iso: string | null | undefined, language: string, now = Date.now()): string {
  const at = Date.parse(iso ?? '');
  if (Number.isNaN(at)) return '—';
  const seconds = Math.round((at - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400) return rtf.format(Math.round(seconds / 86_400), 'day');
  return new Date(at).toLocaleDateString(language);
}

function When({ iso, language }: { iso: string | null | undefined; language: string }) {
  const at = Date.parse(iso ?? '');
  return (
    <span className={styles.sub} title={Number.isNaN(at) ? undefined : new Date(at).toLocaleString(language)}>
      {relTime(iso, language)}
    </span>
  );
}

const LOCAL_OPTIONS = {
  search: searchText,
  compare: {
    event: (a: ActivityRow, b: ActivityRow) => a.event.localeCompare(b.event),
    by: (a: ActivityRow, b: ActivityRow) => a.by.localeCompare(b.by),
    recorded: (a: ActivityRow, b: ActivityRow) => recordedAt(a) - recordedAt(b),
  },
};

/** The kind the grid's filter holds; none chosen is everything. */
export function kindOf(filters: DataGridLoadContext['filters']): KindChoice {
  const chosen = tagGroupChoice(filters?.[KIND_FILTER]);
  return isKindChoice(chosen) ? chosen : 'all';
}

interface ActivityCells {
  t: ScreenText;
  language: string;
  /** The run opened to its events, under the list. */
  opened: string | null;
  toggle: (id: string) => void;
}

const [ActivityCellsProvider, useActivityCells] = createGridCells<ActivityCells>('Activity');

const EventCell: React.FC<{ item: ActivityRow }> = ({ item }) => {
  const { t, opened, toggle } = useActivityCells();
  const open = opened === item.id;
  return (
    <span data-activity-row={item.id}>
      {item.event}
      {item.items && (
        <Badge
          variant="outline"
          className={styles.runToggle}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          title={open ? t('run_fold') : t('run_open')}
          onClick={() => toggle(item.id)}
          onKeyDown={(k: React.KeyboardEvent) => {
            if (k.key === 'Enter' || k.key === ' ') {
              k.preventDefault();
              toggle(item.id);
            }
          }}
          data-activity-run-toggle
        >
          ×{item.items.length} {open ? '▴' : '▾'}
        </Badge>
      )}
      {item.severity === 'high' && (
        <Badge variant="danger" className={styles.runToggle}>
          {item.severity}
        </Badge>
      )}
    </span>
  );
};

const DocumentCell: React.FC<{ item: ActivityRow }> = ({ item }) => {
  const { t } = useActivityCells();
  return <span>{item.items ? t.count('run_documents', item.items.length) : item.subject}</span>;
};

const ByCell: React.FC<{ item: ActivityRow }> = ({ item }) => <span className={styles.sub}>{item.by}</span>;

const RecordedCell: React.FC<{ item: ActivityRow }> = ({ item }) => {
  const { language } = useActivityCells();
  return <When iso={item.recorded} language={language} />;
};

const ActivityEmpty: React.FC = () => {
  const { t } = useActivityCells();
  return (
    <div data-activity-empty>
      <GridEmpty
        title={t('empty_title')}
        note={t('empty_body')}
        noMatches={t('no_matches')}
        noMatchesActions={<GridClearFilters label={t('clear_search')} />}
      />
    </div>
  );
};

/**
 * Chooses the kind a visit opens on — Comments when there are any — unless the
 * address already names one (`GridAddress` seeds that). Everything needs no
 * choice: it is what no filter shows.
 */
const DefaultKind: React.FC<{ kind: KindChoice }> = ({ kind }) => {
  const grid = useDataGrid();
  useEffect(() => {
    if (kind === 'all' || readListState(window.location.search, ADDRESS_PREFIX).filters[KIND_FILTER]) return;
    grid.getPlugin<DataGridFiltersPluginApi>('filters')?.setState(KIND_FILTER, { value: [kind] });
    // Once, on mount: later choices are the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
};

const ActivityGrid: React.FC<{ events: ActivityEvent[]; t: ScreenText; language: string }> = ({
  events,
  t,
  language,
}) => {
  const [opened, setOpened] = useState<string | null>(null);
  const [shown, setShown] = useState<ActivityRow[]>([]);
  const current = useRef(events);
  useLayoutEffect(() => {
    current.current = events;
  });
  // The rows depend on the kind (a run folds within it), so `load` makes them from the events each time.
  const load = useCallback(async (context: DataGridLoadContext) => {
    writeGridAddress(context, ADDRESS_PREFIX, ADDRESS_FILTERS);
    const kept = shownRows(rowsFor(current.current, kindOf(context.filters)), context, LOCAL_OPTIONS);
    context.signal?.throwIfAborted();
    setShown(kept);
    return pageOfRows(kept, context);
  }, []);
  const reloadBridge = useLocalGridReload(events);

  const columns = useMemo<DataGridTableColumn<ActivityRow>[]>(
    () => [
      { id: 'event', label: t('col_event'), component: EventCell },
      { id: 'document', label: t('col_document'), component: DocumentCell },
      { id: 'by', label: t('col_by'), component: ByCell, width: 160 },
      { id: 'recorded', label: t('col_recorded'), component: RecordedCell, width: 160 },
    ],
    [t]
  );
  const comments = countOf(events, 'comment');
  const checks = countOf(events, 'check');
  const filters = useMemo(
    () => [
      filterTagGroup({
        id: KIND_FILTER,
        label: t('which_events'),
        mode: 'radio',
        options: KIND_CHOICES.map((k) => ({
          value: k,
          label:
            k === 'all'
              ? t('kind_all')
              : t('kind_with_count', { label: t(`kind_${k}`), count: k === 'comment' ? comments : checks }),
        })),
      }),
    ],
    [t, comments, checks]
  );
  const cells = useMemo<ActivityCells>(
    () => ({ t, language, opened, toggle: (id) => setOpened((was) => (was === id ? null : id)) }),
    [t, language, opened]
  );
  // A run opens under the list, while it is on the page the grid shows.
  const run = opened ? shown.find((row) => row.id === opened && row.items) : undefined;

  return (
    <ActivityCellsProvider value={cells}>
      <ListGrid<ActivityRow>
        name="activity"
        label={t('activity_title')}
        columns={columns}
        load={load}
        search={t('search')}
        filters={filters}
        empty={ActivityEmpty}
        unsortable={['document']}
        minWidth="48rem"
      >
        <GridAddress prefix={ADDRESS_PREFIX} filterKeys={ADDRESS_FILTERS} />
        <DefaultKind kind={shownKind(undefined, events)} />
        {reloadBridge}
      </ListGrid>
      {run?.items && (
        <section aria-label={run.event}>
          <p className={styles.muted}>
            <b>{run.event}</b> · {t.count('run_documents', run.items.length)}
          </p>
          <ul className={styles.runList} data-activity-run>
            {run.items.slice(0, RUN_SHOWN).map((i) => (
              <li key={i.id}>
                <b>{i.subject}</b> <span className={styles.sub}>{i.by}</span> <When iso={i.recorded} language={language} />
              </li>
            ))}
            {run.items.length > RUN_SHOWN && (
              <li className={styles.sub}>{t('run_more', { count: run.items.length - RUN_SHOWN })}</li>
            )}
          </ul>
        </section>
      )}
    </ActivityCellsProvider>
  );
};

ActivityGrid.displayName = 'ActivityGrid';

export const ActivityScreen: React.FC<{ projectId: string; t: ScreenText; language: string }> = ({
  projectId,
  t,
  language,
}) => {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped by Try again: the same read, once more.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    apiRegistry
      .getService(ActivityApiService)
      .activity({ projectId })
      .fetch()
      .then((feed) => {
        if (!alive) return;
        setError(null);
        setEvents(feed.items ?? []);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(errText(e));
        setEvents([]);
      });
    return () => {
      alive = false;
    };
  }, [projectId, attempt]);

  return (
    <ProjectPage
      title={t('activity_title')}
      help={t('activity_about')}
      helpLabel={t('help_label')}
      chips={
        events &&
        !error && (
          <>
            <Badge variant="secondary" data-activity-count="comment">
              {t.count('comments', countOf(events, 'comment'))}
            </Badge>
            <Badge variant="secondary" data-activity-count="check">
              {t.count('checks', countOf(events, 'check'))}
            </Badge>
          </>
        )
      }
    >
      {error ? (
        <GridFailed message={t('activity_failed', { error })} retry={t('retry')} onRetry={() => setAttempt((n) => n + 1)} />
      ) : events === null ? (
        <PageLoading label={t('loading')} />
      ) : (
        <ActivityGrid events={events} t={t} language={language} />
      )}
    </ProjectPage>
  );
};

ActivityScreen.displayName = 'ActivityScreen';
