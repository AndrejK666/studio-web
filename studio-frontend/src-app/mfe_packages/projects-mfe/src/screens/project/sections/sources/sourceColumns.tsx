import React from 'react';
import { Cloud, Upload } from 'lucide-react';
import { useFormatters } from '@gears-frontx/react';
import {
  Button,
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  VisuallyHidden,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import {
  repositoryHost,
  sourceWebUrls,
  supportsPullRequests,
  type ShareMode,
} from '../../../../model/projectSources';
import type { ShareSave } from '../../../../slices/sourceShareSlice';
import type { Refusal, ScreenText } from '@constructor-studio/mfe-shared';
import { useProjectText, useSourcesText } from '../../../../i18n';
import type { SourceRow, SourcesTableRow, UploadsRow } from '../../../../model/sourceRows';
import type { SourceRowActions } from '../../../../shared/useSourceRowActions';
import { syncSettled, syncTook, type SourceSyncRun } from '../../../../model/sourceSyncRun';
import { useDayTime } from '../../../../shared/dayTime';
import { useDaysAgo } from '../../../../shared/daysAgo';
import { LazyActivitySparkline } from './LazyActivitySparkline';
import { PROVIDER_ICONS } from '../../../../components/providerIcons';
import { SourceRowMenu } from './SourceRowMenu';
import styles from './SourcesSection.module.css';

const MISSING = '—';

export interface SourceColumnDeps {
  t: ScreenText;
  windowDays: number | null;
  actions: SourceRowActions;
  scale: number;
  container?: HTMLElement | null;
  /** The "Changes" saves out or failed, by row id. */
  shareSaves?: Readonly<Record<string, ShareSave>>;
}

/** A link to the provider's site: a new tab, and no click reaching the row beneath. */
const ExternalTextLink: React.FC<{ href: string; label: string; children: React.ReactNode }> = ({
  href,
  label,
  children,
}) => (
  <a
    className={styles.sourceLink}
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={label}
    title={label}
    onClick={(event) => event.stopPropagation()}
  >
    {children}
  </a>
);

ExternalTextLink.displayName = 'ExternalTextLink';

const SourceCell: React.FC<{ row: SourceRow; actions: SourceRowActions }> = ({
  row,
  actions,
}) => {
  const t = useSourcesText();
  const Icon = (row.provider && PROVIDER_ICONS[row.provider]) || Cloud;
  const provider = row.provider === null ? null : actions.providerName(row.provider);
  const path = row.branch ? `${row.fullPath} · ${row.branch}` : row.fullPath;
  const urls = sourceWebUrls(row);
  const site = provider ?? (urls && repositoryHost(urls.repository)) ?? '';
  return (
    <div className={styles.source}>
      <span
        className={styles.providerTile}
        {...(provider === null
          ? { 'aria-hidden': true }
          : { role: 'img', 'aria-label': provider, title: provider })}
      >
        <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <span className={styles.sourceText}>
        <span className={styles.sourceName} title={row.name}>
          {row.name}
        </span>
        {urls === null ? (
          <span className={styles.sourcePath} title={path}>
            {path}
          </span>
        ) : (
          <span className={styles.sourcePath} title={path}>
            <ExternalTextLink
              href={urls.repository}
              label={t('open_repository', { path: row.fullPath, provider: site })}
            >
              {row.fullPath}
            </ExternalTextLink>
            {row.branch && (
              <>
                {' · '}
                {urls.branch === null ? (
                  row.branch
                ) : (
                  <ExternalTextLink
                    href={urls.branch}
                    label={t('open_branch', {
                      branch: row.branch,
                      path: row.fullPath,
                      provider: site,
                    })}
                  >
                    {row.branch}
                  </ExternalTextLink>
                )}
              </>
            )}
          </span>
        )}
      </span>
    </div>
  );
};

SourceCell.displayName = 'SourceCell';

const UploadsCell: React.FC = () => {
  const t = useSourcesText();
  return (
    <div className={styles.source}>
      <span className={styles.providerTile} aria-hidden="true">
        <Upload size={16} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <span className={styles.sourceText}>
        <span className={styles.sourceName}>{t('uploads_name')}</span>
        <span className={styles.sourcePath}>{t('uploads_note')}</span>
      </span>
    </div>
  );
};

UploadsCell.displayName = 'UploadsCell';

const RoleCell: React.FC<{ row: SourceRow; actions: SourceRowActions }> = ({ row, actions }) =>
  row.provider === null ? (
    <span className={styles.muted}>{MISSING}</span>
  ) : (
    <span className={styles.role}>
      <span className={styles.roleDot} aria-hidden="true" />
      {actions.providerName(row.provider)}
    </span>
  );

RoleCell.displayName = 'RoleCell';

/**
 * The prototype's `SourceShareMode`: how "Share with the team" in the IDE
 * lands edits in this repository, changed in place and saved on change. A
 * pull request is offered only where the source's provider can open one (a
 * source already set to it keeps the choice).
 */
const ShareModeCell: React.FC<{
  row: SourceRow;
  actions: SourceRowActions;
  save: ShareSave | undefined;
}> = ({ row, actions, save }) => {
  const t = useSourcesText();
  const pullRequests = supportsPullRequests(row.provider);
  const saving = !!save && !save.failed;
  return (
    <span className={styles.share}>
      <NativeSelect
        size="sm"
        aria-label={t('share_label', { name: row.name })}
        title={t('share_title')}
        value={saving ? save.mode : row.shareMode}
        disabled={saving}
        onChange={(event) => actions.changeShareMode(row, event.target.value as ShareMode)}
      >
        <NativeSelectOption value="branch">{t('share_branch')}</NativeSelectOption>
        <NativeSelectOption
          value="pull_request"
          disabled={!pullRequests && row.shareMode !== 'pull_request'}
        >
          {pullRequests ? t('share_pull_request') : t('share_pull_request_github_only')}
        </NativeSelectOption>
      </NativeSelect>
      {saving && <span className={styles.syncLine}>{t('share_saving')}</span>}
      {save?.failed && (
        <span className={styles.syncLine} role="status">
          {t('share_not_saved')}
        </span>
      )}
    </span>
  );
};

ShareModeCell.displayName = 'ShareModeCell';

const SpecsCell: React.FC<{ row: SourcesTableRow; actions: SourceRowActions }> = ({
  row,
  actions,
}) => {
  const t = useSourcesText();
  // With the doc files known the count is a share, so both are words: "23 specs · 154 doc files",
  // and "0 specs · 68 doc files" says the writing is there and none of it is bound yet.
  const docFiles = row.kind === 'repository' && row.specs !== null ? row.docFiles : null;
  const specs = docFiles === null ? row.specs : t.count('cell_specs', row.specs ?? 0);
  const of =
    docFiles === null ? null : (
      <span className={styles.muted}>{` · ${t.count('cell_doc_files', docFiles)}`}</span>
    );
  if (row.specs === null || row.specs === 0) {
    return (
      <span className={styles.specsCount}>
        <span className={styles.muted}>{specs ?? MISSING}</span>
        {of}
      </span>
    );
  }
  const uploads = row.kind === 'uploads';
  return (
    <span className={styles.specsCount}>
      <Button
        variant="link"
        className={styles.specsLink}
        title={t(uploads ? 'menu_open_uploads' : 'menu_open_specs')}
        onClick={() => (uploads ? actions.openUploads() : actions.openSpecs(row))}
      >
        {specs}
      </Button>
      {of}
    </span>
  );
};

SpecsCell.displayName = 'SpecsCell';

const PullRequestsCell: React.FC<{
  row: SourceRow;
  scale: number;
  container?: HTMLElement | null;
}> = ({ row, scale, container }) => {
  const t = useSourcesText();
  const daysAgo = useDaysAgo();
  if (row.activity === null) {
    return <span className={styles.prsUnavailable}>{t('prs_unavailable')}</span>;
  }

  const { open, merged, days } = row.activity;
  return (
    <div className={styles.pullRequests}>
      <span className={styles.prCounts}>
        <span className={styles.prOpen}>{t('prs_open', { count: open })}</span>
        <span className={styles.prMerged}>{t('prs_merged', { count: merged })}</span>
      </span>
      <LazyActivitySparkline
        days={days}
        max={scale}
        series={t('chart_series')}
        label={t('chart_label', { counts: days.join(', ') })}
        dayLabel={daysAgo}
        container={container}
      />
    </div>
  );
};

PullRequestsCell.displayName = 'PullRequestsCell';

function reasonText(projectText: ScreenText, reason: Refusal | null): string | undefined {
  if (reason === null) return undefined;
  return reason.kind === 'i18n' ? projectText(reason.key) : reason.text;
}

/** The status's words: with its attempt while one beyond the first runs. */
export function syncStatusLabel(t: ScreenText, run: SourceSyncRun, cancelling: boolean): string {
  if (cancelling) return t('sync_cancelling');
  const label = t(`sync_status_${run.status}`);
  return run.status === 'running' && run.attempts !== null && run.attempts > 1
    ? t('sync_status_attempt', { status: label, count: run.attempts })
    : label;
}

/**
 * The last sync's status under its date, opening its details: everything the
 * run said, its tries and times, and the way to the run in Background work.
 */
const SyncStatus: React.FC<{
  row: SourceRow;
  run: SourceSyncRun;
  actions: SourceRowActions;
  container?: HTMLElement | null;
}> = ({ row, run, actions, container }) => {
  const t = useSourcesText();
  const dayTime = useDayTime();
  const { formatRelative } = useFormatters();
  const cancelling = row.sync.kind === 'in_flight' && row.sync.cancelling;
  const label = syncStatusLabel(t, run, cancelling);
  // "Running for" counts to when the details were opened.
  const [openedAt, setOpenedAt] = React.useState<number | null>(null);
  const took = syncTook(run, openedAt ?? Number.NaN);
  return (
    <Popover onOpenChange={(open) => open && setOpenedAt(Date.now())}>
      <PopoverTrigger
        className={styles.syncStatus}
        data-sync-status={run.status}
        aria-label={t('sync_details', { name: row.fullPath, status: label })}
        onClick={(event) => event.stopPropagation()}
      >
        <span className={styles.syncState}>
          <span className={styles.syncDot} aria-hidden="true" />
          {label}
        </span>
        {run.detail && <span className={styles.syncDetail}>{run.detail}</span>}
      </PopoverTrigger>
      <PopoverContent
        container={container ?? undefined}
        align="start"
        className={styles.syncPopover}
        data-sync-details={run.runId}
      >
        <PopoverTitle className={styles.syncPopoverTitle} data-sync-status={run.status}>
          <span className={styles.syncDot} aria-hidden="true" />
          {label}
        </PopoverTitle>
        <p className={styles.syncPopoverText}>{run.detail ?? t('sync_said_nothing')}</p>
        <dl className={styles.syncFacts}>
          {run.attempts !== null && (
            <>
              <dt>{t('sync_fact_tries')}</dt>
              <dd>{run.attempts}</dd>
            </>
          )}
          {run.startedAt && (
            <>
              <dt>{t('sync_fact_started')}</dt>
              <dd title={formatRelative(run.startedAt)}>{dayTime(run.startedAt)}</dd>
            </>
          )}
          {took && (
            <>
              <dt>{t(syncSettled(run.status) ? 'sync_fact_took' : 'sync_fact_running_for')}</dt>
              <dd>{took}</dd>
            </>
          )}
          {run.finishedAt && (
            <>
              <dt>{t('sync_fact_finished')}</dt>
              <dd title={formatRelative(run.finishedAt)}>{dayTime(run.finishedAt)}</dd>
            </>
          )}
        </dl>
        <Button
          variant="link"
          size="sm"
          className={styles.syncOpenTask}
          onClick={() => actions.openSyncRun(run.runId)}
        >
          {t('sync_open_task')}
        </Button>
      </PopoverContent>
    </Popover>
  );
};

SyncStatus.displayName = 'SyncStatus';

const LastSyncCell: React.FC<{
  row: SourceRow;
  actions: SourceRowActions;
  container?: HTMLElement | null;
}> = ({ row, actions, container }) => {
  const t = useSourcesText();
  const projectText = useProjectText();
  const { formatRelative } = useFormatters();
  const dayTime = useDayTime();
  const { lastSync, sync } = row;

  const first = (): React.ReactNode => {
    switch (lastSync.kind) {
      case 'synced':
        return (
          <span title={formatRelative(lastSync.at)}>{dayTime(lastSync.at)}</span>
        );
      case 'not_synced':
        return <span>{t('last_sync_not_synced')}</span>;
      case 'not_connected':
        return <span>{t('last_sync_not_connected')}</span>;
      case 'unavailable':
        return (
          <span>{t('sync_unavailable', { provider: actions.providerName(lastSync.provider) })}</span>
        );
    }
  };

  const second = (): React.ReactNode => {
    // The run, once there is one: its status, what it said, and the way to it.
    if (row.syncRun) {
      return <SyncStatus row={row} run={row.syncRun} actions={actions} container={container} />;
    }
    switch (sync.kind) {
      case 'none':
        return null;
      case 'in_flight':
        return (
          <span className={styles.syncLine}>
            {t(sync.cancelling ? 'sync_cancelling' : 'sync_syncing')}
          </span>
        );
      case 'stopped':
        return (
          <span className={styles.syncLine} title={reasonText(projectText, sync.reason)}>
            {t(sync.status === 'cancelled' ? 'sync_cancelled' : 'sync_failed')}
          </span>
        );
    }
  };

  return (
    <div className={styles.lastSync}>
      {first()}
      {second()}
    </div>
  );
};

LastSyncCell.displayName = 'LastSyncCell';

/**
 * Whether the source could be cloned, and why not (#1071): the last clone or
 * fetch by a desktop or an IDE session, beside the server's own sync. A
 * failure names its cause and the action that fixes it.
 */
const CloneCell: React.FC<{ row: SourceRow }> = ({ row }) => {
  const t = useSourcesText();
  const { formatRelative } = useFormatters();
  const dayTime = useDayTime();
  const { clone } = row;

  if (clone.kind === 'unknown') return <span className={styles.muted}>{MISSING}</span>;
  if (clone.kind === 'never') return <div className={styles.lastSync}>{t('clone_never')}</div>;

  const when =
    clone.at === null ? null : (
      <span className={styles.syncLine} title={formatRelative(clone.at)}>
        {clone.by === null
          ? dayTime(clone.at)
          : t(`clone_when_by_${clone.by}`, { when: dayTime(clone.at) })}
      </span>
    );

  if (clone.kind === 'cloned') {
    return (
      <div className={styles.lastSync}>
        <span>{t('clone_cloned')}</span>
        {when}
      </div>
    );
  }

  const cause = clone.cause === null ? clone.causeText : t(`clone_cause_${clone.cause}`);
  const action = clone.action === null ? clone.actionText : t(`clone_action_${clone.action}`);
  return (
    <div className={styles.lastSync} title={clone.detail ?? undefined}>
      <span className={styles.cloneFailed}>{t('clone_failed')}</span>
      {when}
      {cause && <span className={styles.syncLine}>{cause}</span>}
      {action && <span className={styles.cloneAction}>{action}</span>}
    </div>
  );
};

CloneCell.displayName = 'CloneCell';

const UploadedAtCell: React.FC<{ row: UploadsRow }> = ({ row }) => {
  const { formatRelative } = useFormatters();
  const dayTime = useDayTime();
  if (row.lastAt === null) return <span className={styles.muted}>{MISSING}</span>;
  return (
    <div className={styles.lastSync}>
      <span title={formatRelative(row.lastAt)}>{dayTime(row.lastAt)}</span>
    </div>
  );
};

UploadedAtCell.displayName = 'UploadedAtCell';

const HiddenHeader: React.FC<{ column: DataGridTableColumn<SourcesTableRow> }> = ({ column }) => (
  <VisuallyHidden>
    {/* The kit types a label as `string | (() => string)`. */}
    {typeof column.label === 'function' ? column.label() : column.label}
  </VisuallyHidden>
);

HiddenHeader.displayName = 'HiddenHeader';

export function sourceColumns({
  t,
  windowDays,
  actions,
  scale,
  container,
  shareSaves,
}: SourceColumnDeps): DataGridTableColumn<SourcesTableRow>[] {
  const windowed = (key: string) =>
    windowDays === null ? t(key) : t.count(`${key}_window`, windowDays);
  return [
    {
      id: 'source',
      label: t('col_source'),
      width: '22.5rem',
      render: (row) =>
        row.kind === 'uploads' ? <UploadsCell /> : <SourceCell row={row} actions={actions} />,
    },
    {
      id: 'role',
      label: t('col_role'),
      width: '12rem',
      render: (row) =>
        row.kind === 'uploads' ? (
          <span className={styles.muted}>{MISSING}</span>
        ) : (
          <RoleCell row={row} actions={actions} />
        ),
    },
    {
      id: 'share',
      label: t('col_share'),
      width: '14rem',
      render: (row) =>
        row.kind === 'uploads' ? (
          <span className={styles.muted}>{MISSING}</span>
        ) : (
          <ShareModeCell row={row} actions={actions} save={shareSaves?.[row.id]} />
        ),
    },
    {
      id: 'specs',
      label: t('col_specs'),
      // "23 specs · 154 doc files" on one line; a longer one wraps at its words.
      width: '12rem',
      render: (row) => <SpecsCell row={row} actions={actions} />,
    },
    {
      id: 'pull_requests',
      label: windowed('col_pull_requests'),
      // Every other column has a width: under the fixed layout this one took
      // what was left, nothing on a narrow pane, and wrapped a letter a line. Its header, the longest, fits 11rem.
      width: '11rem',
      render: (row) =>
        row.kind === 'uploads' ? (
          <span className={styles.prsUnavailable}>{t('not_applicable')}</span>
        ) : (
          <PullRequestsCell row={row} scale={scale} container={container} />
        ),
    },
    {
      id: 'commits',
      label: windowed('col_commits'),
      width: '8.5rem',
      render: (row) =>
        row.kind === 'uploads' || row.activity === null ? (
          <span className={styles.muted}>{MISSING}</span>
        ) : (
          row.activity.commits
        ),
    },
    {
      id: 'last_sync',
      label: t('col_last_sync'),
      // The date, and under it the sync's status and what it said.
      width: '14rem',
      render: (row) =>
        row.kind === 'uploads' ? (
          <UploadedAtCell row={row} />
        ) : (
          <LastSyncCell row={row} actions={actions} container={container} />
        ),
    },
    {
      id: 'clone',
      label: t('col_clone'),
      width: '14rem',
      render: (row) =>
        row.kind === 'uploads' ? (
          <span className={styles.muted}>{MISSING}</span>
        ) : (
          <CloneCell row={row} />
        ),
    },
    {
      id: 'actions',
      label: t('col_actions'),
      width: '3rem',
      headerComponent: HiddenHeader,
      render: (row) => (
        <div className={styles.actionsCell}>
          <SourceRowMenu row={row} actions={actions} container={container} />
        </div>
      ),
    },
  ];
}
