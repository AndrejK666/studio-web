import type { ProjectSource } from '@constructor-studio/mfe-shared';
import React from 'react';
import {
  Button,
  DataGridRowActionsPlugin,
  Empty,
  EmptyActions,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Skeleton,
  filterTagGroup,
  useDataGrid,
  type DataGridLoadContext,
  type DataGridLoadResult,
} from '@gears-frontx/ui-kit';
import { useFormatters, useMfeBridge } from '@gears-frontx/react';
import { useOrganization, useWorkspace } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  GridFailed,
  ListGrid,
  searchQuery,
  tagGroupChoice,
  useLocalGridReload,
  useThemedRoot,
} from '@constructor-studio/mfe-shared/grid';
import { Files } from 'lucide-react';
import { useProjectText } from '../../../i18n';
import { readArtifactsPage, useArtifacts } from '../../../shared/useArtifacts';
import { useArtifactImport, useProjectImport } from '../../../shared/useArtifactImport';
import { ReadFailed, SectionSkeleton } from '../../../components/SectionStates';
import { requestOpenArtifact, requestOpenDocument } from '../../../actions/artifactActions';
import type { ArtifactRow } from '../../../model/artifact';
import type { ArtifactKind } from '../../../api/artifactTypes';
import type { DocumentDto } from '../../../api/documentTypes';
import { UploadPanel } from '../upload/UploadPanel';
import {
  ARTIFACT_COLUMN_IDS,
  ArtifactCellsProvider,
  ArtifactRowMenu,
  artifactColumns,
  type ArtifactCells,
} from './artifactColumns';
import { notComeThrough, repoImportLine } from './repoImportText';
import styles from './ArtifactsSection.module.css';
import frame from '../ProjectScreen.module.css';

// In the filter's order. A `Record`, so a new kind does not compile without a label.
const KIND_LABEL_KEY: Record<ArtifactKind, string> = {
  file: 'artifacts_kind_file',
  issue: 'artifacts_kind_issue',
  pullRequest: 'artifacts_kind_pull_request',
  repo: 'artifacts_kind_repo',
  commit: 'artifacts_kind_commit',
  comment: 'artifacts_kind_comment',
  user: 'artifacts_kind_user',
};
const KINDS = Object.keys(KIND_LABEL_KEY) as ArtifactKind[];
const isKind = (value: string | null): value is ArtifactKind => value !== null && value in KIND_LABEL_KEY;

/** The filter keys the grid hands `load`. */
export const ARTIFACT_FILTERS = { repository: 'repository', kind: 'kind' } as const;

const SyncNow: React.FC<{
  projectId: string;
  orgId: string;
  workspaceId: string | null;
  sources: readonly ProjectSource[];
}> = ({ projectId, orgId, workspaceId, sources }) => {
  const t = useProjectText();
  const { canSync, start } = useArtifactImport({
    projectId,
    orgId,
    workspaceId,
    sources,
    artifactCount: 0,
    artifactsRead: true,
  });
  if (!canSync) return null;
  return (
    <EmptyActions>
      <Button variant="outline" size="sm" onClick={start}>
        {t('artifacts_sync_now')}
      </Button>
    </EmptyActions>
  );
};

SyncNow.displayName = 'SyncNow';

const ArtifactsEmpty: React.FC = () => {
  const t = useProjectText();
  return (
    <GridEmpty
      icon={<Files />}
      title={t('artifacts_empty_title')}
      noMatches={t('artifacts_no_matches')}
      noMatchesActions={<GridClearFilters label={t('artifacts_clear_filters')} />}
    />
  );
};

/** The grid's page, as far as the clamp needs it: the kit does not export its pagination API's type. */
interface PaginationLike {
  usePaginationStore: <T>(select: (state: { page: number; limit: number; total: number }) => T) => T;
  setPage: (page: number) => void;
}

/**
 * The page on screen stays a page that exists: when a re-read (an import, a
 * removed document) shrinks the list under it, it moves back to the last one.
 */
const ClampPage: React.FC = () => {
  const pagination = useDataGrid().getPlugin<PaginationLike>('pagination');
  if (!pagination) throw new Error('ClampPage must come after DataGridPaginationPlugin');
  const page = pagination.usePaginationStore((state) => state.page);
  const limit = pagination.usePaginationStore((state) => state.limit);
  const total = pagination.usePaginationStore((state) => state.total);
  React.useEffect(() => {
    const last = Math.max(1, Math.ceil(total / limit));
    if (total > 0 && page > last) pagination.setPage(last);
  }, [pagination, page, limit, total]);
  return null;
};

/** Hands the grid's `triggerLoad` to the section, for a re-read from outside the grid (an import). */
const TriggerBridge: React.FC<{ triggerRef: React.RefObject<(() => void) | null> }> = ({ triggerRef }) => {
  const grid = useDataGrid();
  React.useEffect(() => {
    triggerRef.current = () => void grid.triggerLoad();
    return () => {
      triggerRef.current = null;
    };
  }, [grid, triggerRef]);
  return null;
};

interface ArtifactsSectionProps {
  projectId: string;
  projectName: string;
}

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-page:p1
export const ArtifactsSection: React.FC<ArtifactsSectionProps> = ({ projectId, projectName }) => {
  const t = useProjectText();
  const { formatRelative } = useFormatters();
  const importState = useProjectImport(projectId);
  const { org } = useOrganization();
  const { workspace } = useWorkspace();
  const bridge = useMfeBridge();
  const [container, findThemedRoot] = useThemedRoot();

  /** The repository the grid's filter holds, for the header's count. */
  const [repository, setRepository] = React.useState<string | null>(null);
  /** The list's last page did not load; Retry starts the grid over. */
  const [listFailed, setListFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  const triggerRef = React.useRef<(() => void) | null>(null);
  const reloadList = React.useCallback(() => triggerRef.current?.(), []);

  const { projectTotal, repositoryTotal, repositoryTotalFailed, repositories, repoNames, own, sources, loading, failed, refetch } =
    useArtifacts(projectId, workspace?.id ?? null, repository, reloadList);

  // `load` stays one function for the grid's life: it reads the documents and the names from here.
  const current = React.useRef<{ own: readonly DocumentDto[]; repoNames: ReadonlyMap<string, string> }>({
    own,
    repoNames,
  });
  React.useLayoutEffect(() => {
    current.current = { own, repoNames };
  });
  const sourceRows = React.useMemo(() => ({ own, repoNames }), [own, repoNames]);
  const reloadOnSource = useLocalGridReload(sourceRows);

  const load = React.useCallback(
    async (context: DataGridLoadContext): Promise<DataGridLoadResult<ArtifactRow>> => {
      const kind = tagGroupChoice(context.filters?.[ARTIFACT_FILTERS.kind]);
      const query = {
        repo: tagGroupChoice(context.filters?.[ARTIFACT_FILTERS.repository]),
        kind: isKind(kind) ? kind : null,
        search: searchQuery(context.filters),
      };
      setRepository(query.repo);
      const { page, limit } = context.pagination ?? { page: 1, limit: 25 };
      try {
        const answer = await readArtifactsPage(
          projectId,
          current.current.own,
          current.current.repoNames,
          query,
          (page - 1) * limit,
          limit,
          context.signal
        );
        context.signal?.throwIfAborted();
        setListFailed(false);
        return { results: answer.rows, total: answer.total };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        // The kit's error view is English and has no retry: the section draws GridFailed instead.
        setListFailed(true);
        return { results: [], total: 0 };
      }
    },
    [projectId]
  );

  // The shell opens it, not this screen — see `requestOpenArtifact`.
  const onOpen = React.useCallback(
    (row: ArtifactRow) =>
      row.kind === 'document'
        ? requestOpenDocument(bridge, projectId, { id: row.id, title: row.name })
        : requestOpenArtifact(bridge, projectId, row),
    [bridge, projectId]
  );

  const labels = React.useMemo(
    () => ({
      actions: (name: string) => t('artifacts_row_actions', { name }),
      open: t('artifacts_row_open'),
      openInEditor: t('artifacts_row_open_in_editor'),
      copyLink: t('artifacts_row_copy_link'),
      name: t('artifacts_col_name'),
      repository: t('artifacts_col_repository'),
      path: t('artifacts_col_path'),
      sync: t('artifacts_col_sync'),
      updated: t('artifacts_col_updated'),
      ingested: t('artifacts_sync_ingested'),
      none: t('none'),
      provenance: {
        checkout: t('artifacts_from_checkout'),
        tree: t('artifacts_from_tree'),
        upload: t('artifacts_from_upload'),
        repository: t('artifacts_from_repository'),
      },
    }),
    [t]
  );
  const columns = React.useMemo(() => artifactColumns(labels), [labels]);
  const cells = React.useMemo<ArtifactCells>(
    () => ({ labels, formatRelative, container, onOpen }),
    [labels, formatRelative, container, onOpen]
  );

  // The options a filter offers: one entity list per set of repositories.
  const repositoryChoices = repositories.map((entry) => `${entry.id}\u0000${entry.name}`).join('\n');
  const filters = React.useMemo(() => {
    const choices = repositoryChoices
      ? repositoryChoices.split('\n').map((entry) => {
          const [value, label] = entry.split('\u0000');
          return { value, label };
        })
      : [];
    return [
      ...(choices.length > 0
        ? [
            filterTagGroup({
              id: ARTIFACT_FILTERS.repository,
              label: t('artifacts_col_repository'),
              mode: 'radio',
              options: choices,
            }),
          ]
        : []),
      filterTagGroup({
        id: ARTIFACT_FILTERS.kind,
        label: t('artifacts_kind'),
        mode: 'radio',
        options: KINDS.map((value) => ({ value, label: t(KIND_LABEL_KEY[value]) })),
      }),
    ];
  }, [t, repositoryChoices]);

  if (loading) return <SectionSkeleton />;

  if (failed) {
    return (
      <ReadFailed
        message={t('artifacts_read_failed')}
        retryLabel={t('artifacts_retry')}
        onRetry={refetch}
      />
    );
  }
  if (projectTotal === 0) {
    const running = importState.phase === 'running';
    const failedImport = importState.phase === 'failed';
    const messageKey =
      sources.length === 0
        ? 'artifacts_no_sources'
        : running
          ? 'artifacts_importing'
          : failedImport
            ? 'artifacts_import_failed'
            : 'artifacts_not_synced';
    const notThrough = importState.repos.filter(notComeThrough);
    return (
      <div className={`${styles.section} ${styles.stateBlock}`}>
        <UploadPanel projectId={projectId} projectName={projectName} className={styles.upload} />
        <Empty className={styles.empty}>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Files />
            </EmptyMedia>
            <EmptyTitle>{t('artifacts_empty_title')}</EmptyTitle>
            <EmptyDescription className={failedImport ? styles.emptyFailed : undefined}>
              {t(messageKey)}
            </EmptyDescription>
          </EmptyHeader>
          {org && !running && (
            <SyncNow
              projectId={projectId}
              orgId={org.id}
              workspaceId={workspace?.id ?? null}
              sources={sources}
            />
          )}
          {notThrough.length > 0 && (
            <EmptyContent>
              {notThrough.map((repo) => (
                <p key={repo.repo} className={frame.repoFailure}>
                  {repoImportLine(t, repo)}
                </p>
              ))}
            </EmptyContent>
          )}
        </Empty>
      </div>
    );
  }

  const chosen = repositories.find((entry) => entry.id === repository) ?? null;
  return (
    <div ref={findThemedRoot} className={styles.section}>
      <UploadPanel projectId={projectId} projectName={projectName} className={styles.upload} />
      <header className={styles.strip}>
        <p className={styles.totals}>
          {chosen === null ? (
            t.count('artifacts_count', projectTotal)
          ) : repositoryTotalFailed ? (
            chosen.name
          ) : repositoryTotal === null ? (
            <Skeleton className={styles.rangeSkeleton} />
          ) : (
            t.count('artifacts_in_repository', repositoryTotal, { repo: chosen.name })
          )}
          {importState.phase === 'running' && (
            <>
              <span className={styles.totalsDivider}>·</span>
              <span className={styles.importing}>{t('artifacts_importing_short')}</span>
            </>
          )}
        </p>
        <span className={styles.importing}>{t('artifacts_sorted_newest')}</span>
      </header>
      {listFailed ? (
        <GridFailed
          message={t('artifacts_read_failed')}
          retry={t('artifacts_retry')}
          onRetry={() => {
            setListFailed(false);
            setAttempt((n) => n + 1);
            refetch();
          }}
        />
      ) : (
        <ArtifactCellsProvider value={cells}>
          <ListGrid<ArtifactRow>
            key={attempt}
            name="artifacts"
            label={t('section_artifacts')}
            columns={columns}
            load={load}
            search={t('artifacts_search')}
            filters={filters}
            empty={ArtifactsEmpty}
            unsortable={ARTIFACT_COLUMN_IDS}
            minWidth="52rem"
          >
            <DataGridRowActionsPlugin<ArtifactRow> component={ArtifactRowMenu} />
            <ClampPage />
            <TriggerBridge triggerRef={triggerRef} />
            {reloadOnSource}
          </ListGrid>
        </ArtifactCellsProvider>
      )}
    </div>
  );
};

ArtifactsSection.displayName = 'ArtifactsSection';
