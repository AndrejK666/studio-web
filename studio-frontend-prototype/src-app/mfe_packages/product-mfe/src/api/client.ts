/**
 * The prototype's client calls this kit makes, with the prototype's own
 * signatures (src/api.ts at 00828880), over `ProductApiService`.
 *
 * `api` keeps the bearer as the first argument because three models moved
 * unchanged call it that way (`infra-store.ts`, `project-sources.ts`,
 * `declared-profiles.ts`) and their tests spy on it; the argument is ignored —
 * the bearer travels with `authShared()`. Screens call `productApi`, the same
 * calls without it. Both go through `api` at call time, so a spy on `api` is
 * seen by either.
 *
 * Every write to the product record fires `PRODUCT_CHANGED_EVENT` with the
 * project's id, as the prototype's did: the page's header, strip and map read
 * the record again.
 */

import { apiRegistry } from '@gears-frontx/react';
import { isNotFound, responseStatus } from '@constructor-studio/mfe-shared';
import {
  ProductApiService,
  type PreviewProductBody,
  type SaveProductBody,
  type SyncComponentsBody,
} from './ProductApiService';
import type {
  Capability,
  CatalogRepoSource,
  GearConfigSchema,
  ImageKind,
  InfraPlan,
  ImageState,
  InfraService,
  ProjectConfig,
  ProjectProduct,
  RunState,
} from './types';

import type { StrategyId } from '../model/assembly';

export * from './types';

/** Fired with the project's id after its product record was written. */
export const PRODUCT_CHANGED_EVENT = 'studio:product-changed';

const svc = (): ProductApiService => apiRegistry.getService(ProductApiService);

/** Every read here asks the server again: a page reads after a write. */
const FRESH = { staleTime: 0 };

/** For what no write on the page changes -- the engine's catalogue, read
 *  from the corpus -- one answer serves every screen of one open (the map,
 *  the match section and the configurator each asked for it). */
const CORPUS = { staleTime: 60_000 };

/** Gear config schemas by the gears asked for, as the corpus says them: the
 *  map asks for its gears again on every redraw, and two screens of one open
 *  ask for the same. One answer (or one request still running) serves them. */
const SCHEMA_TTL_MS = 60_000;
const schemaCache = new Map<string, { at: number; answer: Promise<{ items: GearConfigSchema[]; total: number }> }>();

function gearConfigSchemasCached(gears: string[]): Promise<{ items: GearConfigSchema[]; total: number }> {
  const key = [...new Set(gears)].sort().join('\n');
  const hit = schemaCache.get(key);
  if (hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.answer;
  // Through a promise, so a missing service is a refused ask, not a throw.
  const answer = Promise.resolve().then(() => svc().gearConfigSchemas().fetch({ gears }));
  schemaCache.set(key, { at: Date.now(), answer });
  // A failed ask is not kept: the next one tries again.
  answer.catch(() => {
    if (schemaCache.get(key)?.answer === answer) schemaCache.delete(key);
  });
  return answer;
}

/** Forget the kept schemas: for a test, or a corpus read again. */
export function forgetGearConfigSchemas(): void {
  schemaCache.clear();
}

function productChanged<T>(projectId: string, done: Promise<T>): Promise<T> {
  return done.then((v) => {
    window.dispatchEvent(new CustomEvent(PRODUCT_CHANGED_EVENT, { detail: projectId }));
    return v;
  });
}

/** How many more times a product save is sent after the gateway lost its answer. */
const SAVE_RETRIES = 2;

async function retryOnTimeout<T>(ask: () => Promise<T>, retries: number, statuses: readonly number[] = [504]): Promise<T> {
  for (let left = retries; ; left--) {
    try {
      return await ask();
    } catch (e) {
      const status = responseStatus(e);
      if (left === 0 || status === undefined || !statuses.includes(status)) throw e;
    }
  }
}

/** A source as the server takes it: without the marks it answers with. */
function bareSource(s: CatalogRepoSource): CatalogRepoSource {
  const out = { ...s };
  delete out.shadowed_by_platform;
  return out;
}

export const api = {
  projectConfig: async (_token: string, tenantId: string): Promise<ProjectConfig | null> => {
    try {
      return (await svc().projectConfig({ projectId: tenantId }).fetch(FRESH)).value;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  },
  putProjectConfig: (_token: string, tenantId: string, value: ProjectConfig) =>
    svc().putProjectConfig(tenantId).fetch(value),

  projectProduct: async (_token: string, projectId: string): Promise<ProjectProduct | null> => {
    const r = await svc().projectProduct({ projectId }).fetch(FRESH);
    return r.nodes?.[0]?.value ?? null;
  },
  saveProjectProduct: (_token: string, projectId: string, body: SaveProductBody) =>
    productChanged(projectId, svc().saveProjectProduct(projectId).fetch(body)),
  previewProduct: (_token: string, projectId: string, body: PreviewProductBody) => {
    const ask = () => svc().previewProduct(projectId).fetch(body);
    if (body.write) {
      const publishes = !!(body.publish || body.open_pr || body.onto_base);
      return productChanged(projectId, publishes ? ask() : retryOnTimeout(ask, SAVE_RETRIES, [502, 504]));
    }
    // Asked once: a check the gateway gave up on goes on on the server and
    // lands in the record (`checks.<profile>`); asking again only queued
    // another engine run behind it. A long check is queued instead
    // (`startProductCheck`).
    return productChanged(projectId, ask());
  },
  /** Queue the engine's check of the latest saved revision for `profile`; its
   *  verdict lands in the record's `checks`, its run in `check_runs`. */
  startProductCheck: (_token: string, projectId: string, profile: string, strictness?: string) =>
    productChanged(
      projectId,
      svc()
        .startProductCheck(projectId)
        .fetch({ profile, ...(strictness ? { strictness } : {}) })
    ),
  /** A studio-tasks run's state, for following a queued check. */
  taskRunState: (_token: string, runId: string) => svc().taskRun({ runId, tenant: null }).fetch(FRESH),
  productDescription: (_token: string, projectId: string) => svc().productDescription({ projectId }).fetch(FRESH),
  productDescriptionRevisions: (_token: string, projectId: string) =>
    svc().productDescriptionRevisions({ projectId }).fetch(FRESH),
  productDescriptionRevision: (_token: string, projectId: string, revision: number) =>
    svc().productDescriptionRevision({ projectId, revision }).fetch(FRESH),
  productInfra: (_token: string, projectId: string) => svc().productInfra({ projectId }).fetch(FRESH),
  putProductInfra: (_token: string, projectId: string, body: { base_revision?: number | null; items: InfraService[] }) =>
    svc().putProductInfra(projectId).fetch(body),
  outlineProductDescription: (_token: string, projectId: string, body: { text?: string; revision?: number }) =>
    svc().outlineProductDescription(projectId).fetch(body),
  productKind: (_token: string, projectId: string) => svc().productKind({ projectId }).fetch(FRESH),
  confirmProductKind: (_token: string, projectId: string, kind: string) =>
    svc().confirmProductKind(projectId).fetch({ kind }),
  saveProductDescription: (
    _token: string,
    projectId: string,
    body: { base_revision?: number | null; text: string; from_repository?: boolean }
  ) => svc().saveProductDescription(projectId).fetch(body),
  gdlFile: (_token: string, projectId: string, what: { gear: string } | { path: string }) =>
    svc().gdlFile({ projectId, what }).fetch(FRESH),
  gearConfigSchemas: (_token: string, gears: string[]) => gearConfigSchemasCached(gears),
  completeProduct: (_token: string, gears: string[], config?: ProjectProduct['config']) =>
    svc().completeProduct().fetch({ gears, config: config ?? {} }),
  gearboxStatus: (_token: string, refresh = false, organizationId?: string) =>
    svc().gearboxStatus({ refresh, organizationId }).fetch(FRESH),
  gearboxCatalogue: (_token: string) => svc().gearboxCatalogue({}).fetch(CORPUS),
  gearExplanations: (_token: string) => svc().gearExplanations({}).fetch(FRESH),
  gearBrings: (_token: string, gears: string[], candidate: string, config?: ProjectProduct['config']) =>
    svc().gearBrings().fetch({ gears, candidate, config: config ?? {} }),
  /** The project's name (account-management), for a product that has none yet. */
  tenant: (_token: string, tenantId: string) => svc().tenant({ tenantId }).fetch(FRESH),
  generateGearExplanation: (_token: string, gearId: string, force = false) =>
    svc().generateGearExplanation(gearId).fetch({ force }),
  updateGearExplanation: (_token: string, gearId: string, text: string) =>
    svc().updateGearExplanation(gearId).fetch({ text }),
  getProjectGearRepo: (_token: string, projectId: string) => svc().projectGearRepo({ projectId }).fetch(FRESH),

  projectTargets: (_token: string, projectId: string) => svc().projectTargets({ projectId }).fetch(FRESH),
  /** The project's path from its product to running, as every tab draws it. */
  projectPath: (_token: string, projectId: string) => svc().projectPath({ projectId }).fetch(FRESH),
  infraPlan: (_token: string, projectId: string, environmentId: string) =>
    svc().infraPlan({ projectId, environmentId }).fetch(FRESH),
  /** Every environment's plan in one call, not one call per environment. */
  infraPlans: async (_token: string, projectId: string): Promise<InfraPlan[]> =>
    (await svc().infraPlans({ projectId }).fetch(FRESH)).items,
  infraServices: (_token: string, projectId: string) => svc().infraServices({ projectId }).fetch(FRESH),
  putInfraServices: (_token: string, projectId: string, items: InfraService[]) =>
    svc().putInfraServices(projectId).fetch({ items }),
  deployments: (_token: string, params: { org?: string; project?: string; environment?: string }) =>
    svc().deployments(params).fetch(FRESH),
  projectImages: (
    _token: string,
    projectId: string,
    filter: {
      environment_id?: string;
      app?: string;
      kind?: ImageKind;
      state?: ImageState;
      build_id?: string;
      offset?: number;
      limit?: number;
    } = {}
  ) => svc().projectImages({ projectId, filter }).fetch(FRESH),
  importImage: (
    _token: string,
    projectId: string,
    body: { environment_id: string; source: string; name?: string; kind?: 'image' | 'chart' }
  ) => svc().importImage(projectId).fetch(body),

  listComponents: (_token: string, projectId?: string) => svc().listComponents({ projectId }).fetch(FRESH),
  listComponentProfiles: (_token: string, projectId?: string) => svc().listComponentProfiles({ projectId }).fetch(FRESH),
  screenPreviews: (_token: string, component: string) => svc().screenPreviews({ component }).fetch(FRESH),
  catalogSources: (_token: string) => svc().catalogSources({}).fetch(FRESH),
  saveCatalogSources: (_token: string, items: CatalogRepoSource[]) =>
    svc().saveCatalogSources().fetch({ items: items.map(bareSource) }),
  syncComponents: (_token: string, body?: SyncComponentsBody) => svc().syncComponents().fetch(body),
  /** A catalogue sync's run, as the prototype's poller read it. */
  componentsCatalogTask: async (_token: string, taskId: string, tenant: string | null = null) => {
    const run = await svc().taskRun({ runId: taskId, tenant }).fetch(FRESH);
    const n = (key: string) => {
      const v = run.result?.[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    return {
      task_id: run.id,
      status: run.state as RunState,
      message: run.summary ?? run.last_error ?? run.progress ?? null,
      gears: n('gears'),
      versions: n('versions'),
      stored: n('stored'),
    };
  },
  projectComponents: (_token: string, projectId: string) => svc().projectComponents({ projectId }).fetch(FRESH),
  refreshProjectComponents: (_token: string, projectId: string) =>
    svc().refreshProjectComponents(projectId).fetch(undefined),
  componentRegistry: (_token: string, params: { state?: string; project_id?: string; q?: string } = {}) =>
    svc().componentRegistry(params).fetch(FRESH),
  registryEntry: (_token: string, name: string) => svc().registryEntry({ name }).fetch(FRESH),
  declareRegistry: (_token: string, name: string, input: import('./types').RegistryDeclareInput = {}) =>
    svc().declareRegistry(name).fetch(input),
  scaffoldGearToRepo: (_token: string, projectId: string, body: import('./types').ScaffoldBody) =>
    svc().scaffoldGear(projectId).fetch(body),

  declaredCapabilities: (_token: string, projectId: string) => svc().declaredCapabilities({ projectId }).fetch(FRESH),
  declaredRequirements: (_token: string, projectId: string) => svc().declaredRequirements({ projectId }).fetch(FRESH),
  projectPlan: (_token: string, projectId: string) => svc().projectPlan({ projectId }).fetch(FRESH),

  startGearMatch: (
    _token: string,
    projectId: string,
    body: { paths?: string[]; glob?: string; extract_max_calls?: number; idempotency_key?: string } = {},
    strategy?: string
  ) => svc().startGearMatch(projectId, strategy).fetch(body),
  gearMatches: (_token: string, projectId: string, strategy?: string) =>
    svc().gearMatches({ projectId, strategy }).fetch(FRESH),
  gearMatch: (_token: string, projectId: string, matchId = 'latest', strategy?: string) =>
    svc().gearMatch({ projectId, matchId, strategy }).fetch(FRESH),
  connectStrategyService: (
    _token: string,
    organizationId: string,
    strategy: string,
    baseUrl: string,
    secret: string,
    label: string
  ) =>
    svc()
      .connectStrategyService()
      .fetch({
        provider: 'assembly-service',
        label,
        base_url: baseUrl,
        token: secret,
        options: { strategy },
        scope: 'organization',
        owner_tenant_id: organizationId,
      }),
  gearMatchDiff: (_token: string, projectId: string, matchId: string, base?: string) =>
    svc().gearMatchDiff({ projectId, matchId, base }).fetch(FRESH),
  cancelGearMatch: (_token: string, projectId: string, matchId: string) =>
    svc().cancelGearMatch(projectId, matchId).fetch({}),
  putGearMatchDecision: (
    _token: string,
    projectId: string,
    body: { requirement_id: string; gear_id: string; decision: 'accepted' | 'rejected' | 'undecided'; match_id?: string }
  ) => svc().putGearMatchDecision(projectId).fetch(body),
  putGearMatchAnswer: (
    _token: string,
    projectId: string,
    body: { question_id: string; text: string; topic?: string; match_id?: string }
  ) => svc().putGearMatchAnswer(projectId).fetch(body),
  assemblyStrategy: (_token: string, projectId: string) => svc().assemblyStrategy({ projectId }).fetch(FRESH),
  setAssemblyStrategy: (_token: string, projectId: string, strategy: StrategyId | null) =>
    svc().setAssemblyStrategy(projectId).fetch({ strategy }),
  organizationAssemblyStrategy: (_token: string, organizationId: string) =>
    svc().organizationAssemblyStrategy({ organizationId }).fetch(FRESH),
  gearMatchUsage: (_token: string, organizationId: string, periodDays: number) =>
    svc().gearMatchUsage({ organizationId, periodDays }).fetch(FRESH),
  setOrganizationAssemblyStrategy: (
    _token: string,
    organizationId: string,
    strategy: StrategyId | null
  ) => svc().setOrganizationAssemblyStrategy(organizationId).fetch({ strategy }),
  conformance: (
    _token: string,
    projectId: string,
    capabilities: string[],
    vocabulary: readonly Capability[],
    refresh = false
  ) => {
    const terms: Record<string, string[]> = {};
    const contracts: Record<string, string[]> = {};
    for (const cap of vocabulary) {
      if (cap.terms?.length) terms[cap.key] = cap.terms;
      if (cap.contracts?.length) contracts[cap.key] = cap.contracts;
    }
    return svc().conformance().fetch({ project_id: projectId, capabilities, terms, contracts, refresh });
  },
  capabilities: (_token: string, workspaceId: string) => svc().capabilities({ workspaceId }).fetch(FRESH),
  connections: (_token: string, tenant: string) => svc().connections({ tenant }).fetch(FRESH),
  glossary: (_token: string, projectId: string) => svc().glossary({ projectId }).fetch(FRESH),
  specModel: (_token: string, projectId: string) => svc().specModel({ projectId }).fetch(FRESH),
  /** The project's sources whose last clone or fetch failed: why a product built from them cannot resolve. */
  cloneFailures: async (_token: string, projectId: string) =>
    (await svc().cloneStatus({ projectId }).fetch(FRESH)).items.filter((s) => s.state === 'failed'),

  listArtifactNodes: (
    _token: string,
    type?: string,
    scope?: string,
    cursor?: string,
    limit?: number,
    opts?: { repo?: string; sort?: 'updated'; offset?: number; q?: string }
  ) => {
    const qs = new URLSearchParams();
    if (type) qs.set('type', type);
    if (scope) qs.set('scope', scope);
    if (opts?.repo) qs.set('repo', opts.repo);
    if (opts?.sort) qs.set('sort', opts.sort);
    if (opts?.q) qs.set('q', opts.q);
    if (opts?.offset != null) qs.set('offset', String(opts.offset));
    else if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    return svc().artifactNodes({ query: qs.toString() }).fetch(FRESH);
  },
};

type Api = typeof api;
type WithoutBearer<F> = F extends (token: string, ...rest: infer A) => infer R ? (...rest: A) => R : never;

/** The same calls without the bearer: what the screens use. */
export type ProductApi = { [K in keyof Api]: WithoutBearer<Api[K]> };

export const productApi: ProductApi = Object.fromEntries(
  (Object.keys(api) as (keyof Api)[]).map((k) => [
    k,
    (...rest: unknown[]) => (api[k] as (token: string, ...a: unknown[]) => unknown)('', ...rest),
  ])
) as ProductApi;
