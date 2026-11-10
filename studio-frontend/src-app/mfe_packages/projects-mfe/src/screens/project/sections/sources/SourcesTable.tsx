import React from 'react';
import { Plug } from 'lucide-react';
import { useAppSelector, useMfeBridge } from '@gears-frontx/react';
import {
  Button,
  DataGridEmptyStatePlugin,
  DataGridPaginationPlugin,
  DataGridTextSearchPlugin,
  Empty,
  EmptyActions,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  useDataGrid,
} from '@gears-frontx/ui-kit';
import {
  LIST_PAGE_LIMITS,
  ListGrid,
  ListNoMatch,
  useThemedRoot,
} from '@constructor-studio/mfe-shared';
import { useSourcesText } from '../../../../i18n';
import { openSourcesConnect } from '../../../../actions/sourcesConnectActions';
import { ReadFailed, SectionSkeleton } from '../../../../components/SectionStates';
import { activityScale, type SourcesTableRow } from '../../../../model/sourceRows';
import { useSourcesLoad } from '../../../../shared/useSourcesLoad';
import { useSourceRowActions } from '../../../../shared/useSourceRowActions';
import { NAV_SLICE_KEY } from '../../../../slices/navSlice';
import { UploadDocumentsButton } from '../../upload/UploadDocumentsButton';
import { UploadPanel } from '../../upload/UploadPanel';
import { sourceColumns } from './sourceColumns';
import { SourcesFooter } from './SourcesFooter';
import styles from './SourcesSection.module.css';
import empty from '../../../../components/EmptyState.module.css';

const SourcesEmpty: React.FC = () => {
  const t = useSourcesText();
  const bridge = useMfeBridge();
  const grid = useDataGrid<SourcesTableRow>();
  const filtered = grid.useStore((state) => state.hasActiveFilters);
  const projectId = useAppSelector((state) => state[NAV_SLICE_KEY].projectId);

  if (filtered) {
    return <ListNoMatch message={t('no_match')} clearLabel={t('clear_search')} />;
  }
  return (
    <Empty className={styles.empty}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className={empty.media}>
          <Plug strokeWidth={1.5} />
        </EmptyMedia>
        <EmptyTitle className={empty.title}>{t('empty_title')}</EmptyTitle>
      </EmptyHeader>
      <EmptyActions>
        {projectId && <UploadDocumentsButton projectId={projectId} />}
        <Button size="sm" icon={<Plug />} onClick={() => openSourcesConnect(bridge)}>
          {t('connect_source')}
        </Button>
      </EmptyActions>
    </Empty>
  );
};

SourcesEmpty.displayName = 'SourcesEmpty';

interface SourcesTableProps {
  projectId: string;
  projectName: string;
  orgId: string;
  workspaceId: string | null;
}

export const SourcesTable: React.FC<SourcesTableProps> = ({
  projectId,
  projectName,
  orgId,
  workspaceId,
}) => {
  const t = useSourcesText();
  const sources = useSourcesLoad(projectId, workspaceId, orgId, t('uploads_name'));
  const actions = useSourceRowActions(projectId, workspaceId, orgId);
  const [container, findThemedRoot] = useThemedRoot();

  const scale = React.useMemo(() => activityScale(sources.rows), [sources.rows]);
  const columns = React.useMemo(
    () => sourceColumns({ t, windowDays: sources.windowDays, actions, scale, container }),
    [t, sources.windowDays, actions, scale, container]
  );

  if (!sources.ready) return <SectionSkeleton />;

  if (sources.failed) {
    return (
      <ReadFailed message={t('read_failed')} retryLabel={t('retry')} onRetry={sources.retry} />
    );
  }

  return (
    <div ref={findThemedRoot} className={styles.section}>
      <UploadPanel projectId={projectId} projectName={projectName} className={styles.upload} />
      <div className={styles.grid}>
        <ListGrid<SourcesTableRow>
          key={projectId}
          name="project-sources"
          persistent="memory"
          load={sources.load}
          columns={columns}
          footer={<SourcesFooter footer={sources.footer} />}
        >
          <DataGridTextSearchPlugin placeholder={t('search')} />
          <DataGridPaginationPlugin defaultLimit={LIST_PAGE_LIMITS[0]} limits={LIST_PAGE_LIMITS} autoHide />
          <DataGridEmptyStatePlugin component={SourcesEmpty} />
          {sources.rowsBridge}
        </ListGrid>
      </div>
    </div>
  );
};

SourcesTable.displayName = 'SourcesTable';
