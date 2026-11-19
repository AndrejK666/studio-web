import type { ProjectSource } from '@constructor-studio/mfe-shared';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { apiRegistry, useApiQuery, useQueryCache } from '@gears-frontx/react';
import { ArtifactIngestApiService, type NodesParams } from '../api/ArtifactIngestApiService';
import { ARTIFACT_NODE_TYPES, ARTIFACT_REPO_TYPE, type ArtifactKind } from '../api/artifactTypes';
import {
  artifactPage,
  buildArtifactRows,
  buildRepositories,
  studioDocumentRow,
  type ArtifactRepository,
  type ArtifactRow,
} from '../model/artifact';
import { useProjectConfig } from './useProjectConfig';
import { useProjectImport } from './useArtifactImport';
import { useProjectDocuments } from './useProjectDocuments';
import type { DocumentDto } from '../api/documentTypes';

const REPOSITORY_CEILING = 200;

export function repositoryNodesParams(projectId: string): NodesParams {
  return { scope: projectId, type: ARTIFACT_REPO_TYPE, limit: REPOSITORY_CEILING };
}

export interface ArtifactCountView {
  total: number;
  sources: ProjectSource[];
  loading: boolean;
  failed: boolean;
}

export function useArtifactCount(projectId: string): ArtifactCountView {
  const ingest = apiRegistry.getService(ArtifactIngestApiService);
  const { data, isLoading, isError } = useApiQuery(
    ingest.nodes({ scope: projectId, limit: 1 })
  );
  const { config, loading: configLoading, failed: configFailed } = useProjectConfig(projectId);
  const sources = useMemo(() => config?.sources ?? [], [config]);

  return {
    total: data?.total ?? 0,
    sources,
    loading: isLoading || configLoading,
    failed: isError || configFailed,
  };
}

/** What the Artifacts grid asks for: its repository and type filters and its search. */
export interface ArtifactsQuery {
  repo: string | null;
  kind: ArtifactKind | null;
  search: string;
}

/** One page of the list: the project's own Studio documents first, then the gear's nodes. */
export interface ArtifactsPage {
  rows: ArtifactRow[];
  total: number;
}

/**
 * The page of the list at `offset`, `limit` rows long (#1076: the grid's
 * `load`). The project's own Studio documents come first. They have no
 * repository and no kind, so either filter hides them; the search matches
 * their title. The gear sorts its nodes newest first; nothing else sorts.
 */
export async function readArtifactsPage(
  projectId: string,
  own: readonly DocumentDto[],
  repoNames: ReadonlyMap<string, string>,
  query: ArtifactsQuery,
  offset: number,
  limit: number,
  signal?: AbortSignal
): Promise<ArtifactsPage> {
  const search = query.search.trim();
  const needle = search.toLowerCase();
  const documents =
    query.repo || query.kind ? [] : own.filter((document) => document.title.toLowerCase().includes(needle));
  const split = artifactPage(documents, offset, limit);
  const page = await apiRegistry
    .getService(ArtifactIngestApiService)
    .nodes({
      scope: projectId,
      sort: 'updated',
      // At least one row, so a page of documents alone still learns the gear's total.
      limit: Math.max(1, split.graphLimit),
      offset: split.graphOffset,
      repo: query.repo ?? undefined,
      type: query.kind ? ARTIFACT_NODE_TYPES[query.kind] : undefined,
      q: search || undefined,
    })
    .fetch({ signal, staleTime: 0 });
  return {
    rows: [
      ...split.docRows.map(studioDocumentRow),
      ...buildArtifactRows(page.nodes, repoNames).slice(0, split.graphLimit),
    ],
    total: page.total + documents.length,
  };
}

export interface ArtifactsView {
  projectTotal: number;
  repositoryTotal: number | null;
  repositoryTotalFailed: boolean;
  repositories: ArtifactRepository[];
  /** Each repository's name by its id, for the rows' Repository column. */
  repoNames: ReadonlyMap<string, string>;
  /** The project's own Studio documents, listed before the gear's nodes. */
  own: DocumentDto[];
  sources: ProjectSource[];
  /** Nothing to show yet: the repositories, the count or the documents. */
  loading: boolean;
  failed: boolean;
  /** Reads the counts and the repositories again, and the list's page through `onRefresh`. */
  refetch: () => void;
}

/** The stored count grows once per flushed chunk; it re-reads the artifacts at most this often. */
const STORED_REFRESH_MS = 2_000;

// @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-11
/** Re-reads when a run starts, since the gear writes its repository's node then, when one settles, and when the stored count grows. */
function useImportRefresh(projectId: string, refetch: () => void): void {
  const importState = useProjectImport(projectId);
  const stored = importState.repos.reduce((sum, repo) => sum + repo.stored, 0);
  const statuses = importState.repos.map((repo) => repo.status).join();
  const watching = importState.phase === 'running';
  const seen = useRef<{ stored: number; statuses: string } | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(refetch);

  useEffect(() => {
    latest.current = refetch;
  }, [refetch]);

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    },
    []
  );

  useEffect(() => {
    const last = seen.current;
    if (last?.stored === stored && last.statuses === statuses) return;
    seen.current = { stored, statuses };
    if (!last && stored === 0 && !watching) return;
    if (last?.statuses === statuses) {
      pending.current ??= setTimeout(() => {
        pending.current = null;
        latest.current();
      }, STORED_REFRESH_MS);
      return;
    }
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    refetch();
  }, [stored, statuses, watching, refetch]);
}
// @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-11

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-counters:p1
// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-page:p1
/**
 * What the Artifacts tab shows beside its list: the counts, the repositories,
 * the project's own documents. The list's pages are the grid's to read
 * (`readArtifactsPage`); `onRefresh` asks it for its page again whenever the
 * counts are read again, so an import keeps both in step.
 */
export function useArtifacts(
  projectId: string,
  workspaceId: string | null,
  repo: string | null,
  onRefresh: () => void
): ArtifactsView {
  const ingest = apiRegistry.getService(ArtifactIngestApiService);
  const cache = useQueryCache();
  const studio = useProjectDocuments(workspaceId, projectId);

  const repositoryParams = useMemo(() => repositoryNodesParams(projectId), [projectId]);
  const repositoryNodes = useApiQuery(ingest.nodes(repositoryParams));
  const scope = useArtifactCount(projectId);

  const repositoryTotalParams = useMemo<NodesParams>(
    () => (repo ? { scope: projectId, repo, limit: 1 } : { scope: projectId, limit: 1 }),
    [projectId, repo]
  );
  const repositoryTotalNodes = useApiQuery(ingest.nodes(repositoryTotalParams));

  const repositories = useMemo(
    () => buildRepositories(repositoryNodes.data?.nodes ?? []),
    [repositoryNodes.data]
  );
  const repoNames = useMemo(
    () => new Map(repositories.map((repository) => [repository.id, repository.name])),
    [repositories]
  );

  const refresh = useRef(onRefresh);
  useEffect(() => {
    refresh.current = onRefresh;
  }, [onRefresh]);

  const refetch = useCallback(() => {
    void cache.invalidate(ingest.nodes(repositoryParams));
    void cache.invalidate(ingest.nodes({ scope: projectId, limit: 1 }));
    void cache.invalidate(ingest.nodes(repositoryTotalParams));
    refresh.current();
  }, [cache, ingest, repositoryParams, projectId, repositoryTotalParams]);

  useImportRefresh(projectId, refetch);

  return {
    projectTotal: scope.total + studio.own.length,
    repositoryTotal: repo && repositoryTotalNodes.data ? repositoryTotalNodes.data.total : null,
    repositoryTotalFailed: repo !== null && repositoryTotalNodes.isError,
    repositories,
    repoNames,
    own: studio.own,
    sources: scope.sources,
    loading: repositoryNodes.isLoading || scope.loading || studio.loading,
    failed: repositoryNodes.isError || scope.failed,
    refetch,
  };
}
