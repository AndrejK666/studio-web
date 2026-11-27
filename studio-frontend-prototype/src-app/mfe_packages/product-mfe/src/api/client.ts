/**
 * The prototype's client calls this kit makes, with the prototype's own
 * signatures (src/api.ts at 00828880), over `ProductApiService`.
 *
 * `api`'s first argument is the organization on screen (the prototype's ignored
 * bearer took that place; the bearer travels with `authShared()`). The routes
 * that name the organization (`orgScoped`) get it from there, and nowhere
 * else: no organization is kept in a module, so switching organizations cannot
 * send a request, or serve a cached answer, under the one before. Screens call
 * `productApiFor(orgId)` — through `useProductApi()`, from their scope — the
 * same calls with the organization bound. Both go through `api` at call time,
 * so a spy on `api` is seen by either.
 *
 * Every write to the product record fires `PRODUCT_CHANGED_EVENT` with the
 * project's id, as the prototype's did: the page's header, strip and map read
 * the record again.
 */

import { apiRegistry } from '@gears-frontx/react';
import { fetchProjectArtifacts, isNotFound, responseStatus, type ArtifactKind } from '@constructor-studio/mfe-shared';
import {
  ProductApiService,
  type PreviewProductBody,
  type SaveProductBody,
  type SyncComponentsBody,
} from './ProductApiService';
import type {
  ArtifactNodePage,
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
import type { MatcherSettingsUpdate } from '../model/matcher-settings';

export * from './types';

/** Fired with the project's id after its product record was written. */
export const PRODUCT_CHANGED_EVENT = 'studio:product-changed';

const svc = (): ProductApiService => apiRegistry.getService(ProductApiService);

/** The organization on screen; null when the shell has not said. */
export type Org = string | null;

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

function gearConfigSchemasCached(org: Org, gears: string[]): Promise<{ items: GearConfigSchema[]; total: number }> {
  // Each organization's corpus is its own: one's answer never serves another.
  const key = [org ?? '', ...[...new Set(gears)].sort()].join('\n');
  const hit = schemaCache.get(key);
  if (hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.answer;
  // Through a promise, so a missing service is a refused ask, not a throw.
  const answer = Promise.resolve().then(() => svc().gearConfigSchemas(org).fetch({ gears }));
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

/** The artifact kinds the project screens list through the query. */
const PROJECT_KINDS: readonly string[] = ['repo', 'workflow_run', 'build'];

export const api = {
  projectConfig: async (_org: Org, tenantId: string): Promise<ProjectConfig | null> => {
    try {
      return (await svc().projectConfig({ projectId: tenantId }).fetch(FRESH)).value;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  },
  putProjectConfig: (_org: Org, tenantId: string, value: ProjectConfig) =>
    svc().putProjectConfig(tenantId).fetch(value),

  projectProduct: async (org: Org, projectId: string): Promise<ProjectProduct | null> => {
    const r = await svc().projectProduct({ projectId, org }).fetch(FRESH);
    return r.nodes?.[0]?.value ?? null;
  },
  saveProjectProduct: (org: Org, projectId: string, body: SaveProductBody) =>
    productChanged(projectId, svc().saveProjectProduct(org, projectId).fetch(body)),
  previewProduct: (org: Org, projectId: string, body: PreviewProductBody) => {
    const ask = () => svc().previewProduct(org, projectId).fetch(body);
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
  startProductCheck: (org: Org, projectId: string, profile: string, strictness?: string) =>
    productChanged(
      projectId,
      svc().startProductCheck(org, projectId)
        .fetch({ profile, ...(strictness ? { strictness } : {}) })
    ),
  /** A studio-tasks run's state, for following a queued check. */
  taskRunState: (_org: Org, runId: string) => svc().taskRun({ runId, tenant: null }).fetch(FRESH),
  productDescription: (org: Org, projectId: string) => svc().productDescription({ projectId, org }).fetch(FRESH),
  productDescriptionRevisions: (org: Org, projectId: string) =>
    svc().productDescriptionRevisions({ projectId, org }).fetch(FRESH),
  productDescriptionRevision: (org: Org, projectId: string, revision: number) =>
    svc().productDescriptionRevision({ projectId, revision, org }).fetch(FRESH),
  productInfra: (org: Org, projectId: string) => svc().productInfra({ projectId, org }).fetch(FRESH),
  putProductInfra: (org: Org, projectId: string, body: { base_revision?: number | null; items: InfraService[] }) =>
    svc().putProductInfra(org, projectId).fetch(body),
  outlineProductDescription: (org: Org, projectId: string, body: { text?: string; revision?: number }) =>
    svc().outlineProductDescription(org, projectId).fetch(body),
  productKind: (org: Org, projectId: string) => svc().productKind({ projectId, org }).fetch(FRESH),
  confirmProductKind: (org: Org, projectId: string, kind: string) =>
    svc().confirmProductKind(org, projectId).fetch({ kind }),
  saveProductDescription: (
    org: Org,
    projectId: string,
    body: { base_revision?: number | null; text: string; from_repository?: boolean }
  ) => svc().saveProductDescription(org, projectId).fetch(body),
  gdlFile: (org: Org, projectId: string, what: { gear: string } | { path: string }) =>
    svc().gdlFile({ projectId, what, org }).fetch(FRESH),
  gearConfigSchemas: (org: Org, gears: string[]) => gearConfigSchemasCached(org, gears),
  completeProduct: (org: Org, gears: string[], config?: ProjectProduct['config']) =>
    svc().completeProduct(org).fetch({ gears, config: config ?? {} }),
  gearboxStatus: (org: Org, refresh = false, organizationId?: string) =>
    svc().gearboxStatus({ refresh, organizationId, org }).fetch(FRESH),
  gearboxCatalogue: (org: Org) => svc().gearboxCatalogue({ org }).fetch(CORPUS),
  gearExplanations: (org: Org) => svc().gearExplanations({ org }).fetch(FRESH),
  gearBrings: (org: Org, gears: string[], candidate: string, config?: ProjectProduct['config']) =>
    svc().gearBrings(org).fetch({ gears, candidate, config: config ?? {} }),
  /** The project's name (account-management), for a product that has none yet. */
  tenant: (_org: Org, tenantId: string) => svc().tenant({ tenantId }).fetch(FRESH),
  generateGearExplanation: (org: Org, gearId: string, force = false) =>
    svc().generateGearExplanation(org, gearId).fetch({ force }),
  updateGearExplanation: (org: Org, gearId: string, text: string) =>
    svc().updateGearExplanation(org, gearId).fetch({ text }),
  getProjectGearRepo: (org: Org, projectId: string) => svc().projectGearRepo({ projectId, org }).fetch(FRESH),

  projectTargets: (_org: Org, projectId: string) => svc().projectTargets({ projectId }).fetch(FRESH),
  /** The project's path from its product to running, as every tab draws it. */
  projectPath: (_org: Org, projectId: string) => svc().projectPath({ projectId }).fetch(FRESH),
  infraPlan: (_org: Org, projectId: string, environmentId: string) =>
    svc().infraPlan({ projectId, environmentId }).fetch(FRESH),
  /** Every environment's plan in one call, not one call per environment. */
  infraPlans: async (_org: Org, projectId: string): Promise<InfraPlan[]> =>
    (await svc().infraPlans({ projectId }).fetch(FRESH)).items,
  infraServices: (_org: Org, projectId: string) => svc().infraServices({ projectId }).fetch(FRESH),
  putInfraServices: (_org: Org, projectId: string, items: InfraService[]) =>
    svc().putInfraServices(projectId).fetch({ items }),
  deployments: (_org: Org, params: { org?: string; project?: string; environment?: string }) =>
    svc().deployments(params).fetch(FRESH),
  projectImages: (
    _org: Org,
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
    _org: Org,
    projectId: string,
    body: { environment_id: string; source: string; name?: string; kind?: 'image' | 'chart' }
  ) => svc().importImage(projectId).fetch(body),

  listComponents: (org: Org, projectId?: string) => svc().listComponents({ projectId, org }).fetch(FRESH),
  listComponentProfiles: (org: Org, projectId?: string) => svc().listComponentProfiles({ projectId, org }).fetch(FRESH),
  screenPreviews: (org: Org, component: string) => svc().screenPreviews({ component, org }).fetch(FRESH),
  catalogSources: (org: Org) => svc().catalogSources({ org }).fetch(FRESH),
  saveCatalogSources: (org: Org, items: CatalogRepoSource[]) =>
    svc().saveCatalogSources(org).fetch({ items: items.map(bareSource) }),
  syncComponents: (org: Org, body?: SyncComponentsBody) => svc().syncComponents(org).fetch(body),
  /** A catalogue sync's run, as the prototype's poller read it. */
  componentsCatalogTask: async (_org: Org, taskId: string, tenant: string | null = null) => {
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
  projectComponents: (org: Org, projectId: string) => svc().projectComponents({ projectId, org }).fetch(FRESH),
  refreshProjectComponents: (org: Org, projectId: string) =>
    svc().refreshProjectComponents(org, projectId).fetch(undefined),
  componentRegistry: (org: Org, params: { state?: string; project_id?: string; q?: string } = {}) =>
    svc().componentRegistry({ ...params, org }).fetch(FRESH),
  registryEntry: (org: Org, name: string) => svc().registryEntry({ name, org }).fetch(FRESH),
  declareRegistry: (org: Org, name: string, input: import('./types').RegistryDeclareInput = {}) =>
    svc().declareRegistry(org, name).fetch(input),
  scaffoldGearToRepo: (org: Org, projectId: string, body: import('./types').ScaffoldBody) =>
    svc().scaffoldGear(org, projectId).fetch(body),

  declaredCapabilities: (org: Org, projectId: string) => svc().declaredCapabilities({ projectId, org }).fetch(FRESH),
  declaredRequirements: (org: Org, projectId: string) => svc().declaredRequirements({ projectId, org }).fetch(FRESH),
  projectPlan: (org: Org, projectId: string) => svc().projectPlan({ projectId, org }).fetch(FRESH),

  startGearMatch: (
    org: Org,
    projectId: string,
    body: { paths?: string[]; glob?: string; extract_max_calls?: number; idempotency_key?: string } = {},
    strategy?: string
  ) => svc().startGearMatch(org, projectId, strategy).fetch(body),
  gearMatches: (org: Org, projectId: string, strategy?: string) =>
    svc().gearMatches({ projectId, strategy, org }).fetch(FRESH),
  gearMatch: (org: Org, projectId: string, matchId = 'latest', strategy?: string) =>
    svc().gearMatch({ projectId, matchId, strategy, org }).fetch(FRESH),
  connectStrategyService: (
    _org: Org,
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
  gearMatchDiff: (org: Org, projectId: string, matchId: string, base?: string) =>
    svc().gearMatchDiff({ projectId, matchId, base, org }).fetch(FRESH),
  cancelGearMatch: (org: Org, projectId: string, matchId: string) =>
    svc().cancelGearMatch(org, projectId, matchId).fetch({}),
  putGearMatchDecision: (
    org: Org,
    projectId: string,
    body: { requirement_id: string; gear_id: string; decision: 'accepted' | 'rejected' | 'undecided'; match_id?: string }
  ) => svc().putGearMatchDecision(org, projectId).fetch(body),
  putGearMatchAnswer: (
    org: Org,
    projectId: string,
    body: { question_id: string; text: string; topic?: string; match_id?: string }
  ) => svc().putGearMatchAnswer(org, projectId).fetch(body),
  assemblyStrategy: (org: Org, projectId: string) => svc().assemblyStrategy({ projectId, org }).fetch(FRESH),
  setAssemblyStrategy: (org: Org, projectId: string, strategy: StrategyId | null) =>
    svc().setAssemblyStrategy(org, projectId).fetch({ strategy }),
  organizationAssemblyStrategy: (_org: Org, organizationId: string) =>
    svc().organizationAssemblyStrategy({ organizationId }).fetch(FRESH),
  gearMatchUsage: (_org: Org, organizationId: string, periodDays: number) =>
    svc().gearMatchUsage({ organizationId, periodDays }).fetch(FRESH),
  setOrganizationAssemblyStrategy: (
    _org: Org,
    organizationId: string,
    strategy: StrategyId | null
  ) => svc().setOrganizationAssemblyStrategy(organizationId).fetch({ strategy }),
  matcherSettings: (_org: Org, organizationId: string, strategy = 'gears_matcher') =>
    svc().matcherSettings({ organizationId, strategy }).fetch(FRESH),
  putMatcherSettings: (_org: Org, organizationId: string, strategy: string, body: MatcherSettingsUpdate) =>
    svc().putMatcherSettings(organizationId, strategy).fetch(body),
  conformance: (
    org: Org,
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
    return svc().conformance(org).fetch({ project_id: projectId, capabilities, terms, contracts, refresh });
  },
  capabilities: (_org: Org, workspaceId: string) => svc().capabilities({ workspaceId }).fetch(FRESH),
  connections: (_org: Org, tenant: string) => svc().connections({ tenant }).fetch(FRESH),
  glossary: (_org: Org, projectId: string) => svc().glossary({ projectId }).fetch(FRESH),
  specModel: (_org: Org, projectId: string) => svc().specModel({ projectId }).fetch(FRESH),
  /** The project's sources whose last clone or fetch failed: why a product built from them cannot resolve. */
  cloneFailures: async (_org: Org, projectId: string) =>
    (await svc().cloneStatus({ projectId }).fetch(FRESH)).items.filter((s) => s.state === 'failed'),

  /**
   * Artifact nodes. A project's repositories, CI runs or builds, as one
   * page, searched or not (`q`), read through
   * `POST /studio-domain-model/v1/query` where the organization's artifacts
   * are answered from the model (`fetchProjectArtifacts`). A cursor, an
   * offset or a repository stays on `GET /studio-artifact-ingest/v1/nodes`:
   * that is the gear's own paging, which no screen of this kit asks for.
   */
  listArtifactNodes: (
    org: Org,
    type?: string,
    scope?: string,
    cursor?: string,
    limit?: number,
    opts?: { repo?: string; sort?: 'updated'; offset?: number; q?: string }
  ): Promise<ArtifactNodePage> => {
    if (type && PROJECT_KINDS.includes(type) && scope && !cursor && !opts?.repo && opts?.offset == null) {
      return fetchProjectArtifacts(org, scope, type as ArtifactKind, {
        limit,
        sort: opts?.sort,
        q: opts?.q,
      }) as Promise<ArtifactNodePage>;
    }
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
type WithoutOrg<F> = F extends (org: Org, ...rest: infer A) => infer R ? (...rest: A) => R : never;

/** The same calls with the organization bound: what the screens use. */
export type ProductApi = { [K in keyof Api]: WithoutOrg<Api[K]> };

/** `api` with `org` bound: every call names that organization, whatever is on screen by the time it runs. */
export function productApiFor(org: Org): ProductApi {
  return Object.fromEntries(
    (Object.keys(api) as (keyof Api)[]).map((k) => [
      k,
      (...rest: unknown[]) => (api[k] as (org: Org, ...a: unknown[]) => unknown)(org, ...rest),
    ])
  ) as ProductApi;
}
