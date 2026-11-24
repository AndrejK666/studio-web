/**
 * A project's ONE path, from its sources to its running product, as the
 * server decides it (studio-backend `project_path.rs`): nine stages, each
 * numbered by its place on the whole path, so Product is 5 on Overview,
 * Product and Releases alike.
 *
 *   `GET /studio-organizations/v1/project-status` → `stages`: the whole path.
 *   `GET /studio-environments/v1/project-path`    → `stages`: 5-9.
 *
 * A server from before `stages` answered only its own steps (status.rs'
 * `path`, path.rs' `steps`): `stagesFromStatus` and `stagesFromDelivery` say
 * those as stages, by the same rules, so the strip draws the same either way
 * until the server is deployed. The rules themselves are the server's.
 */

export type StageId =
  | 'sources'
  | 'documents'
  | 'model'
  | 'findings'
  | 'product'
  | 'build'
  | 'images'
  | 'environment'
  | 'deploy';

/** The stages, in the order a project goes through them. */
export const STAGE_IDS: readonly StageId[] = [
  'sources',
  'documents',
  'model',
  'findings',
  'product',
  'build',
  'images',
  'environment',
  'deploy',
];

/** Product to Deploy: what the Product tab shows. */
export const PRODUCT_STAGES: readonly StageId[] = ['product', 'build', 'images', 'environment', 'deploy'];
/** Build to Deploy: what Releases shows. */
export const RELEASE_STAGES: readonly StageId[] = ['build', 'images', 'environment', 'deploy'];

export type StageState = 'done' | 'current' | 'blocked' | 'todo' | 'running' | 'failed' | 'unknown';

export interface StageAction {
  /** `open` (the stage's tab), `open_product`, `save_product`, `build`, `deploy`, and path.rs' own. */
  kind: string;
  /** The server's English label; the strip words it by `kind` where it can. */
  label: string;
}

/** One stage, as the server answers it (`ProjectStageDto`). */
export interface PathStage {
  id: StageId;
  /** Its place on the whole path, from 1. */
  number: number;
  title?: string;
  state: StageState;
  /** Why it is where it is, in one line. */
  cause: string;
  /** The project tab that holds the evidence: `sources`, `specs`, `model`, `issues`, `product`, `releases`. */
  tab: string;
  /** The object there: a build id, a deploy or an environment id. */
  object?: string | null;
  action?: StageAction | null;
  /** The kit whose tab that is; null for Sources. */
  kit?: string | null;
  /** The stage to look at now. */
  focus: boolean;
}

/** Where each evidence tab is in this portal. */
export const STAGE_TAB_ROUTE: Record<string, string> = {
  sources: '/projects/sources',
  specs: '/projects/specs',
  model: '/domain-model',
  issues: '/issues',
  product: '/product',
  releases: '/releases',
};

const SHAPE: Record<StageId, { tab: string; kit: string | null }> = {
  sources: { tab: 'sources', kit: null },
  documents: { tab: 'specs', kit: 'project-specs' },
  model: { tab: 'model', kit: 'project-domain-model' },
  findings: { tab: 'issues', kit: 'project-domain-model' },
  product: { tab: 'product', kit: 'project-product' },
  build: { tab: 'releases', kit: 'delivery' },
  images: { tab: 'releases', kit: 'delivery' },
  environment: { tab: 'releases', kit: 'delivery' },
  deploy: { tab: 'releases', kit: 'delivery' },
};

export function isStageId(v: unknown): v is StageId {
  return typeof v === 'string' && (STAGE_IDS as readonly string[]).includes(v);
}

/** A stage's place on the whole path, from 1. */
export function stageNumber(id: StageId): number {
  return STAGE_IDS.indexOf(id) + 1;
}

/** A stage with its number, tab and kit as the server gives them. */
export function stageOf(id: StageId, state: StageState, cause: string, more: Partial<PathStage> = {}): PathStage {
  return { id, number: stageNumber(id), state, cause, tab: SHAPE[id].tab, kit: SHAPE[id].kit, focus: false, ...more };
}

/**
 * The focus: the first stage neither done nor unknown, `current` when it is
 * merely to do (`project_path.rs` `focus`).
 */
export function withFocus(stages: readonly PathStage[]): PathStage[] {
  const out: PathStage[] = stages.map((s) => ({ ...s, focus: false, state: s.state === 'current' ? 'todo' : s.state }));
  const at = out.findIndex((s) => s.state !== 'done' && s.state !== 'unknown');
  if (at >= 0) out[at] = { ...out[at], focus: true, state: out[at].state === 'todo' ? 'current' : out[at].state };
  return out;
}

/** Lists of stages as one path: a later list's stage replaces an earlier one's, in path order, the focus marked. */
export function joinStages(...lists: ReadonlyArray<readonly PathStage[]>): PathStage[] {
  const byId = new Map<StageId, PathStage>();
  for (const list of lists) for (const s of list) byId.set(s.id, s);
  return withFocus([...byId.values()].sort((a, b) => a.number - b.number));
}

/** The server's stages, as sent: anything that is not a stage is left out. */
export function stagesOf(value: unknown): PathStage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const stages = value.filter((s): s is PathStage => !!s && isStageId((s as PathStage).id));
  return stages.length > 0 ? stages : null;
}

/** A step of the status path as an older server answers it (`ProjectPathStepDto`). */
export interface StatusPathStep {
  step: string;
  state: string;
  flow?: string;
  status: string;
  action?: string;
}

const STATUS_STAGE: Record<string, StageId> = {
  repos: 'sources',
  types: 'documents',
  model: 'model',
  findings: 'findings',
  product: 'product',
  build: 'build',
};

/** The status path's steps as stages: done is done, unknown unknown, a failed build or product failed, high findings blocked. */
export function stagesFromStatus(path: readonly StatusPathStep[] | null | undefined): PathStage[] {
  return (path ?? []).flatMap((s) => {
    const id = STATUS_STAGE[s.step];
    if (!id) return [];
    const state: StageState =
      s.state === 'unknown'
        ? 'unknown'
        : s.state === 'done'
          ? 'done'
          : s.flow === 'failed'
            ? 'failed'
            : s.flow === 'warn'
              ? 'blocked'
              : 'todo';
    return [stageOf(id, state, s.status, state === 'done' || !s.action ? {} : { action: { kind: 'open', label: s.action } })];
  });
}

/** A step of the delivery path as an older server answers it (`PathStepDto`). */
export interface DeliveryPathStep {
  id: string;
  state: string;
  reason: string;
  action?: { kind: string; label: string } | null;
  build_id?: string | null;
  environment_id?: string | null;
  deployment_id?: string | null;
}

const DELIVERY_STAGE: Record<string, StageId> = {
  product: 'product',
  build: 'build',
  image: 'images',
  environment: 'environment',
  running: 'deploy',
};

const DELIVERY_STATE: Record<string, StageState> = {
  done: 'done',
  active: 'running',
  failed: 'failed',
  blocked: 'blocked',
  next: 'todo',
  later: 'todo',
};

/** The delivery path's steps as stages 5-9. */
export function stagesFromDelivery(steps: readonly DeliveryPathStep[] | null | undefined): PathStage[] {
  return (steps ?? []).flatMap((s) => {
    const id = DELIVERY_STAGE[s.id];
    if (!id) return [];
    return [
      stageOf(id, DELIVERY_STATE[s.state] ?? 'todo', s.reason, {
        object: s.deployment_id ?? s.build_id ?? s.environment_id ?? null,
        action: s.action ? { kind: s.action.kind, label: s.action.label } : null,
      }),
    ];
  });
}
