/**
 * A project's synced artifacts of one kind (repositories, CI runs, IDE
 * builds), read through `POST /studio-domain-model/v1/query` (ADR-0066 §8a):
 * the model's `repository`, `ci-run` and `product-build` objects, whose value
 * is the payload `GET /studio-artifact-ingest/v1/nodes` returns.
 *
 * Only where the organization's artifacts are answered from the model: the
 * artifact gear moves each organization once, in the background, and marks
 * it moved (a `sync-state` object); until then, and in a deployment that
 * keeps them in the graph (`storage.artifacts: graph`), the model holds none
 * or only part of them and `/nodes` is what answers. Both ask the same
 * `domain.view`, so the fallback shows nobody more than the query would.
 */

import type { DomainQueryOf, DomainQueryResult, DomainQueryRow } from '../domain/domainQuery';
import { domainQuerySend } from '../data/domain';
import { gateway, withQuery } from '../data/gateway';
import type { ArtifactNode } from './artifactNode';

/** The kinds the project screens list, by the artifact gear's leaf. */
export type ArtifactKind = 'repo' | 'workflow_run' | 'build';

/** Each kind's type in the domain model. */
export const ARTIFACT_MODEL_TYPE: Record<ArtifactKind, string> = {
  repo: 'repository',
  workflow_run: 'ci-run',
  build: 'product-build',
};

const GTS_TYPE: Record<ArtifactKind, string> = {
  repo: 'gts.cf.studio.artifact.repo.v1~',
  workflow_run: 'gts.cf.studio.artifact.workflow_run.v1~',
  build: 'gts.cf.studio.artifact.build.v1~',
};

/** What an artifact's id gets in front of it as a domain object's id. */
const ID_PREFIX = 'art-';

/** The marker the artifact gear leaves once an organization has moved. */
export const ARTIFACTS_MOVED_MARKER = 'art-store-moved-v1';

const NODES_PATH = '/studio-artifact-ingest/v1/nodes';

/** How long "moved" (or "not yet") answers for an organization. */
const MOVED_FOR_MS = 60_000;

export interface ProjectArtifactsOptions {
  /** 1..=200. */
  limit?: number;
  /** `updated`: newest first. */
  sort?: 'updated';
}

/** The query that lists `kind` in `projectId`: what `/nodes?type=&scope=` lists. */
export function projectArtifactsQuery(
  kind: ArtifactKind,
  projectId: string,
  { limit = 50, sort }: ProjectArtifactsOptions = {}
): DomainQueryOf<string> {
  const q: DomainQueryOf<string> = {
    type: ARTIFACT_MODEL_TYPE[kind],
    project_id: projectId,
    limit: Math.min(Math.max(1, limit), 200),
  };
  if (sort === 'updated') q.order_by = [{ field: 'updated_at', direction: 'desc' }];
  return q;
}

/** A query row as the node `/nodes` returns for it. */
export function artifactNodeOf(kind: ArtifactKind, row: DomainQueryRow): ArtifactNode {
  return {
    type_id: GTS_TYPE[kind],
    instance_id: row.id.startsWith(ID_PREFIX) ? row.id.slice(ID_PREFIX.length) : row.id,
    value: row.value as ArtifactNode['value'],
  };
}

/** Whether the marker rows say the model answers for the organization. */
export function movedByMarker(rows: readonly DomainQueryRow[]): boolean {
  const marker = rows[0];
  return !!marker && marker.value.status !== 'returned';
}

const moved = new Map<string, { at: number; answer: Promise<boolean> }>();

/**
 * Whether `orgId`'s artifacts are answered from the model. A marker the
 * caller cannot read (no grant reaches it, the query failed) is "not yet":
 * `/nodes` then answers, with its own refusal when there is one.
 */
export function artifactsInModel(orgId: string): Promise<boolean> {
  const kept = moved.get(orgId);
  if (kept && Date.now() - kept.at < MOVED_FOR_MS) return kept.answer;
  const answer = domainQuerySend<DomainQueryResult>(orgId)
    .fetch({ type: 'sync-state', where: { id: { _eq: ARTIFACTS_MOVED_MARKER } }, limit: 1 })
    .then((r) => movedByMarker(r.items ?? []))
    .catch(() => false);
  moved.set(orgId, { at: Date.now(), answer });
  return answer;
}

/** Forget what was learnt about the organizations (tests). */
export function forgetArtifactsInModel(): void {
  moved.clear();
}

/** A page of nodes, as `/nodes` answers it. */
export interface ProjectArtifactPage {
  nodes: ArtifactNode[];
  total: number;
}

/**
 * `kind` in `projectId`: through the query where the model answers for
 * `orgId`, else through `/nodes`. Without an organization (not known yet),
 * `/nodes`.
 */
export async function fetchProjectArtifacts(
  orgId: string | null | undefined,
  projectId: string,
  kind: ArtifactKind,
  options: ProjectArtifactsOptions = {}
): Promise<ProjectArtifactPage> {
  if (orgId && (await artifactsInModel(orgId))) {
    const r = await domainQuerySend<DomainQueryResult>(orgId).fetch(projectArtifactsQuery(kind, projectId, options));
    const items = r.items ?? [];
    return { nodes: items.map((row) => artifactNodeOf(kind, row)), total: r.total ?? items.length };
  }
  const path = withQuery(NODES_PATH, {
    type: kind,
    scope: projectId,
    sort: options.sort,
    limit: Math.min(Math.max(1, options.limit ?? 50), 200),
  });
  const page = await gateway().get<ProjectArtifactPage>(path, { staleTime: 0 }).fetch({ staleTime: 0 });
  return { nodes: page.nodes ?? [], total: page.total ?? 0 };
}
