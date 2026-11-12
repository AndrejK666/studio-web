/** The Sources table's rows */
// @cpt-algo:cpt-studiofrontend-algo-project-sources-rows:p2
// @cpt-algo:cpt-studiofrontend-algo-project-sources-footer:p2
// @cpt-dod:cpt-studiofrontend-dod-project-sources-rows:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-last-sync:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-row-sync:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-gaps:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-search:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-footer:p1
import type { ConnectionDto, ProjectSource, Refusal } from '@constructor-studio/mfe-shared';
import type {
  ArtifactNodeDto,
  RepoActivityDto,
  SourceActivityListDto,
  SourceCloneStatusDto,
} from '../api/artifactTypes';
import type { DocumentDto, SpecsPerSourceListDto } from '../api/documentTypes';
import { canCancel, canRetry, inFlight, type RepoImportStatus } from './repoImport';
import { SYNCABLE_PROVIDERS, pathKey, repoNodeOf } from './syncRequest';

export type SourceLastSync =
  | { kind: 'synced'; at: string }
  | { kind: 'not_synced' }
  | { kind: 'not_connected' }
  | { kind: 'unavailable'; provider: string };

export type SourceSync =
  | { kind: 'none' }
  | { kind: 'in_flight'; cancelling: boolean; canCancel: boolean }
  | {
      kind: 'stopped';
      status: 'failed' | 'cancelled' | 'lost';
      reason: Refusal | null;
      canRetry: boolean;
    };

/** The causes a failed clone names; anything else is shown by the backend's own sentence. */
export const CLONE_CAUSES = [
  'no_connection',
  'connection_not_found',
  'connection_personal',
  'held_outside',
  'token_unreadable',
  'provider_refused',
  'repository_not_found',
  'unreachable',
  'provider_error',
  'not_http',
] as const;
export type CloneCause = (typeof CLONE_CAUSES)[number];

/** What fixes a failed clone. */
export const CLONE_ACTIONS = ['connect', 'reconnect', 'ask_admin', 'check_repository', 'retry'] as const;
export type CloneAction = (typeof CLONE_ACTIONS)[number];

/** Who cloned: a desktop through Studio's Git remote, or an IDE session's launch. */
export type CloneChannel = 'desktop' | 'ide_session' | null;

/**
 * The last clone or fetch of a source (#1071). `unknown` when the clone
 * status could not be read: it says nothing about the source.
 */
export type SourceClone =
  | { kind: 'unknown' }
  | { kind: 'never' }
  | { kind: 'cloned'; at: string | null; by: CloneChannel }
  | {
      kind: 'failed';
      at: string | null;
      by: CloneChannel;
      cause: CloneCause | null;
      /** The backend's sentence, for a cause this screen has no words for. */
      causeText: string | null;
      action: CloneAction | null;
      actionText: string | null;
      detail: string | null;
    };

export interface SourceActivity {
  open: number;
  merged: number;
  commits: number;
  days: number[];
}

export interface SourceRow {
  kind: 'repository';
  id: string;
  connectionId: string;
  provider: string | null;
  name: string;
  fullPath: string;
  cloneUrl: string;
  branch: string | null;
  /** How "Share with the team" in the IDE lands edits here; `branch` when the config says nothing. */
  shareMode: 'branch' | 'pull_request';
  nodeId: string | null;
  specs: number | null;
  activity: SourceActivity | null;
  lastSync: SourceLastSync;
  sync: SourceSync;
  clone: SourceClone;
}

/** The project's own Studio documents (#693), as the design's "Uploaded files" row. */
export interface UploadsRow {
  kind: 'uploads';
  id: 'uploads';
  specs: number;
  /** The newest `created_at`. */
  lastAt: string | null;
}

export type SourcesTableRow = SourceRow | UploadsRow;

export interface SourceImportLine {
  repo: string;
  runId: string | null;
  status: RepoImportStatus;
  reason: Refusal | null;
  cancelling: boolean;
}

export interface SourcesAnswers {
  sources: readonly ProjectSource[];
  nodes: readonly ArtifactNodeDto[];
  connections: readonly ConnectionDto[] | null;
  activity: SourceActivityListDto | null;
  specs: SpecsPerSourceListDto | null;
  lines: readonly SourceImportLine[];
  /** The project's own Studio documents; `null` when they could not be read. */
  uploads: readonly Pick<DocumentDto, 'created_at'>[] | null;
  /** The last clone of each source; `null` when it could not be read. */
  clones?: readonly SourceCloneStatusDto[] | null;
}

export interface SourcesFooter {
  sources: number;
  specs: number | null;
  openPullRequests: number | null;
}

const NO_SYNC: SourceSync = { kind: 'none' };

function nameOf(fullPath: string): string {
  return fullPath.slice(fullPath.lastIndexOf('/') + 1);
}

function activityOf(listed: RepoActivityDto | undefined, window: number): SourceActivity {
  if (!listed) {
    return {
      open: 0,
      merged: 0,
      commits: 0,
      days: new Array<number>(window).fill(0),
    };
  }
  return {
    open: listed.open,
    merged: listed.merged,
    commits: listed.commits,
    days: listed.days,
  };
}

function lastSyncOf(
  node: ArtifactNodeDto | null,
  connected: boolean,
  provider: string | null
): SourceLastSync {
  if (!connected) return { kind: 'not_connected' };
  if (provider !== null && !SYNCABLE_PROVIDERS.includes(provider)) {
    return { kind: 'unavailable', provider };
  }
  const at = node?.value.synced_at;
  return at ? { kind: 'synced', at } : { kind: 'not_synced' };
}

function syncOf(line: SourceImportLine | undefined): SourceSync {
  if (!line) return NO_SYNC;
  if (inFlight(line.status)) {
    return {
      kind: 'in_flight',
      cancelling: line.cancelling,
      canCancel: canCancel(line) && !line.cancelling,
    };
  }
  if (line.status === 'failed' || line.status === 'cancelled' || line.status === 'lost') {
    return { kind: 'stopped', status: line.status, reason: line.reason, canRetry: canRetry(line) };
  }
  return NO_SYNC;
}

function oneOf<T extends string>(known: readonly T[], value: string | null | undefined): T | null {
  return value != null && (known as readonly string[]).includes(value) ? (value as T) : null;
}

function channelOf(by: string | null | undefined): CloneChannel {
  return by === 'desktop' || by === 'ide_session' ? by : null;
}

/** A source's clone as the clone status reports it, matched by clone URL, else by path. */
export function cloneOf(
  clones: SourcesAnswers['clones'],
  source: Pick<ProjectSource, 'clone_url' | 'full_path'>
): SourceClone {
  if (!clones) return { kind: 'unknown' };
  const status =
    clones.find((item) => item.clone_url === source.clone_url) ??
    clones.find((item) => pathKey(item.full_path) === pathKey(source.full_path));
  if (!status || status.state === 'never') return { kind: 'never' };
  const at = status.at ?? null;
  const by = channelOf(status.by);
  if (status.state === 'cloned') return { kind: 'cloned', at, by };
  return {
    kind: 'failed',
    at,
    by,
    cause: oneOf(CLONE_CAUSES, status.cause),
    causeText: status.cause_text ?? null,
    action: oneOf(CLONE_ACTIONS, status.action),
    actionText: status.action_text ?? null,
    detail: status.detail ?? null,
  };
}

function uploadsRow(uploads: SourcesAnswers['uploads']): UploadsRow | null {
  if (!uploads?.length) return null;
  const lastAt = uploads.reduce<string | null>(
    (newest, document) =>
      newest === null || Date.parse(document.created_at) > Date.parse(newest)
        ? document.created_at
        : newest,
    null
  );
  return { kind: 'uploads', id: 'uploads', specs: uploads.length, lastAt };
}

export function buildSourceRows(answers: SourcesAnswers): SourcesTableRow[] {
  const connections = answers.connections && new Map(answers.connections.map((c) => [c.id, c]));
  const specsKnown = answers.specs?.files_known === true;
  const specsByNode = new Map(answers.specs?.items.map((item) => [item.repo, item.specs]));
  const activityByNode = new Map(answers.activity?.items.map((item) => [item.repo, item]));
  const lines = new Map(answers.lines.map((line) => [pathKey(line.repo), line]));

  const rows: SourcesTableRow[] = [];
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-1
  for (const source of answers.sources) {
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-2
    const node = repoNodeOf(answers.nodes, source, connections);
    // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-2
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-3
    const connection = connections?.get(source.connection_id) ?? null;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-3
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-4
    const provider = node?.value.provider ?? connection?.provider ?? null;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-4
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-6
    const specs = specsKnown && node ? (specsByNode.get(node.instance_id) ?? 0) : null;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-6
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-7
    const activity =
      answers.activity && node
        ? activityOf(activityByNode.get(node.instance_id), answers.activity.days)
        : null;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-7
    rows.push({
      kind: 'repository',
      id: `${source.connection_id}:${source.full_path}`,
      connectionId: source.connection_id,
      provider,
      // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-5
      name: nameOf(source.full_path),
      fullPath: source.full_path,
      cloneUrl: source.clone_url,
      branch: source.branch ?? null,
      // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-5
      shareMode: source.share_mode === 'pull_request' ? 'pull_request' : 'branch',
      nodeId: node?.instance_id ?? null,
      specs,
      activity,
      // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-8
      // Connections that could not be read say nothing about this one.
      lastSync: lastSyncOf(node, connections === null || connection !== null, provider),
      // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-8
      // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-9
      sync: syncOf(lines.get(pathKey(source.full_path))),
      // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-9
      clone: cloneOf(answers.clones, source),
    });
  }
  // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-1
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-10
  const uploads = uploadsRow(answers.uploads);
  if (uploads) rows.push(uploads);
  return rows;
  // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-10
}

export function filterSourceRows(
  rows: readonly SourcesTableRow[],
  search: string,
  uploadsName: string
): SourcesTableRow[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    (row.kind === 'uploads' ? uploadsName : row.fullPath).toLowerCase().includes(needle)
  );
}

const MIN_ACTIVITY_SCALE = 3;

/** The top of every row's sparkline: one scale for the table, whatever page shows. */
export function activityScale(rows: readonly SourcesTableRow[]): number {
  return rows.reduce(
    (top, row) => (row.kind === 'uploads' ? top : Math.max(top, ...(row.activity?.days ?? []))),
    MIN_ACTIVITY_SCALE
  );
}

export function sourcesFooter(
  rows: readonly SourcesTableRow[],
  answers: Pick<SourcesAnswers, 'specs' | 'activity' | 'uploads'>
): SourcesFooter {
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-footer:p2:inst-2
  let specs = answers.specs?.files_known
    ? rows.reduce((sum, row) => sum + (row.specs ?? 0), 0)
    : null;
  // @cpt-end:cpt-studiofrontend-algo-project-sources-footer:p2:inst-2
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-footer:p2:inst-3
  // The uploads row counts among them: unread, the sum would be short.
  if (answers.uploads === null) specs = null;
  // @cpt-end:cpt-studiofrontend-algo-project-sources-footer:p2:inst-3
  const footer: SourcesFooter = {
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-footer:p2:inst-1
    sources: rows.length,
    // @cpt-end:cpt-studiofrontend-algo-project-sources-footer:p2:inst-1
    specs,
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-footer:p2:inst-4
    openPullRequests: answers.activity
      ? rows.reduce((sum, row) => sum + (row.kind === 'uploads' ? 0 : (row.activity?.open ?? 0)), 0)
      : null,
    // @cpt-end:cpt-studiofrontend-algo-project-sources-footer:p2:inst-4
  };
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-footer:p2:inst-5
  return footer;
  // @cpt-end:cpt-studiofrontend-algo-project-sources-footer:p2:inst-5
}

/**
 * The repositories that could sync and never have — the prototype's "N never
 * synced" beside the sources. A source whose connection is gone or whose
 * provider cannot sync is not counted: Sync would not help it.
 */
export function neverSynced(rows: readonly SourcesTableRow[]): number {
  return rows.filter((row) => row.kind === 'repository' && row.lastSync.kind === 'not_synced').length;
}
