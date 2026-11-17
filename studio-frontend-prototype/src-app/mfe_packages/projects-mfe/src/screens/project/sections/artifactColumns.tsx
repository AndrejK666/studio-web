import React from 'react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import {
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  UserRound,
} from 'lucide-react';
import type { ArtifactKind } from '../../../api/artifactTypes';
import { opensInEditor, type ArtifactRow } from '../../../model/artifact';
import { NameCell, NoData, createGridCells } from '@constructor-studio/mfe-shared/grid';
import styles from './ArtifactsSection.module.css';

const KIND_ICON: Record<ArtifactKind | 'document', React.ReactNode> = {
  document: <FileText size={16} strokeWidth={1.3} />,
  repo: <GitBranch size={16} strokeWidth={1.3} />,
  file: <FileText size={16} strokeWidth={1.3} />,
  issue: <MessageSquare size={16} strokeWidth={1.3} />,
  pullRequest: <GitMerge size={16} strokeWidth={1.3} />,
  commit: <GitCommitHorizontal size={16} strokeWidth={1.3} />,
  comment: <MessageCircle size={16} strokeWidth={1.3} />,
  user: <UserRound size={16} strokeWidth={1.3} />,
};

export interface ArtifactColumnLabels {
  name: string;
  repository: string;
  path: string;
  sync: string;
  updated: string;
  ingested: string;
  provenance: Record<string, string>;
  actions: (name: string) => string;
  open: string;
  openInEditor: string;
  copyLink: string;
  /** What an empty cell says on hover. */
  none: string;
}

/** Which control asked: the name button or the row menu's Open in editor. */
export type ArtifactOpenVia = 'name' | 'menu';
export type ArtifactOpen = (row: ArtifactRow, via: ArtifactOpenVia) => void;

/** What a cell needs beyond its row. */
export interface ArtifactCells {
  labels: ArtifactColumnLabels;
  formatRelative: (value: number) => string;
  container?: HTMLElement | null;
  onOpen?: ArtifactOpen;
}

const [ArtifactCellsProvider, useArtifactCells] = createGridCells<ArtifactCells>('Artifacts');
export { ArtifactCellsProvider };

const NameOfRow: React.FC<{ item: ArtifactRow }> = ({ item }) => {
  const { onOpen } = useArtifactCells();
  return (
    <NameCell
      name={item.name}
      icon={item.kind !== null && KIND_ICON[item.kind]}
      onOpen={onOpen !== undefined && opensInEditor(item) ? () => onOpen(item, 'name') : undefined}
    />
  );
};

const RepositoryCell: React.FC<{ item: ArtifactRow }> = ({ item }) => {
  const { labels } = useArtifactCells();
  if (item.kind === 'document' || !item.repository) return <NoData label={labels.none} />;
  return (
    <span className={`${styles.truncate} ${styles.muted}`} title={item.repository}>
      {item.repository}
    </span>
  );
};

const PathCell: React.FC<{ item: ArtifactRow }> = ({ item }) => (
  <span className={`${styles.truncate} ${styles.muted}`} title={item.path}>
    {item.path}
  </span>
);

// TODO: plain text until ui-kit carries a plain status badge again (0.4
// dropped Badge's `shape="plain"`/`dot`).
const SyncCell: React.FC<{ item: ArtifactRow }> = ({ item }) => {
  const { labels } = useArtifactCells();
  return <span className={styles.muted}>{item.sync === 'uploaded' ? labels.provenance.upload : labels.ingested}</span>;
};

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-updated:p1
const UpdatedCell: React.FC<{ item: ArtifactRow }> = ({ item }) => {
  const { labels, formatRelative } = useArtifactCells();
  return (
    <span className={styles.muted}>
      {item.updatedAt !== null
        ? formatRelative(item.updatedAt)
        : item.provenance
          ? labels.provenance[item.provenance]
          : ''}
    </span>
  );
};

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-open-request:p1
/** The row's menu: Open in editor for what the editor opens, else Open on the forge; Copy link with a url. */
export const ArtifactRowMenu: React.FC<{ item: ArtifactRow }> = ({ item: row }) => {
  const { labels, container, onOpen } = useArtifactCells();
  const editor = onOpen !== undefined && opensInEditor(row);
  return (
    <div className={styles.actionsCell}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className={styles.actionsButton}
              aria-label={labels.actions(row.name)}
              disabled={!editor && row.url === null}
              icon={<MoreHorizontal size={16} strokeWidth={1.5} />}
            />
          }
        />
        <DropdownMenuContent align="end" container={container ?? undefined}>
          {editor ? (
            <DropdownMenuItem onClick={() => onOpen(row, 'menu')}>{labels.openInEditor}</DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() => {
                if (row.url) window.open(row.url, '_blank', 'noopener,noreferrer');
              }}
            >
              {labels.open}
            </DropdownMenuItem>
          )}
          {row.url !== null && (
            <DropdownMenuItem
              onClick={() => {
                if (row.url) void navigator.clipboard?.writeText(row.url);
              }}
            >
              {labels.copyLink}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

ArtifactRowMenu.displayName = 'ArtifactRowMenu';

/** The cells the Artifacts grid draws, by column id. */
export const ARTIFACT_CELLS = {
  name: NameOfRow,
  repository: RepositoryCell,
  path: PathCell,
  sync: SyncCell,
  updated: UpdatedCell,
} as const;

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-table:p1
/** The grid's columns; nothing sorts but the gear, newest first, so every header is plain. */
export function artifactColumns(labels: ArtifactColumnLabels): DataGridTableColumn<ArtifactRow>[] {
  return [
    { id: 'name', label: labels.name, component: ARTIFACT_CELLS.name },
    { id: 'repository', label: labels.repository, component: ARTIFACT_CELLS.repository, width: 160 },
    { id: 'path', label: labels.path, component: ARTIFACT_CELLS.path, width: 200 },
    { id: 'sync', label: labels.sync, component: ARTIFACT_CELLS.sync, width: 150 },
    { id: 'updated', label: labels.updated, component: ARTIFACT_CELLS.updated, width: 170 },
  ];
}

/** Every column id: the gear sorts the list, so none has a sort in its header. */
export const ARTIFACT_COLUMN_IDS = Object.keys(ARTIFACT_CELLS);
