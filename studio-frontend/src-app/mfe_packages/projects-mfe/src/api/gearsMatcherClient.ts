/**
 * The gears-matcher service's runs (ADR-0071, `gears-matcher/schemas/service/matcher-service.openapi.yaml`).
 *
 * Stand-in: the browser reaches the service through the dev server's `/gears-matcher` proxy, which
 * adds the shared secret. The deployed route is a backend one, and this client is what it replaces.
 */

export const GEARS_MATCHER_BASE = '/gears-matcher/v1';

export type RunState =
  'queued' | 'running' | 'cancelling' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface MatcherRun {
  id: string;
  state: RunState;
  progress?: { requirements_total: number; requirements_done: number };
  usage: { calls: number; cache_hits: number };
  outcome?: { requirements: number; not_assessed: number };
  error?: { kind: 'input' | 'internal'; message: string };
}

export type Coverage = 'covered' | 'partial' | 'gap' | 'clarification_needed' | 'not_assessed';

export interface GearMatch {
  gear_id: string;
  confidence?: number | null;
  verdict?: string | null;
}

export interface RequirementCoverage {
  requirement_id: string;
  coverage: Coverage;
  confidence: number | null;
  reason?: string | null;
  gears: GearMatch[];
}

export interface RecommendedGear {
  gear_id: string;
  name?: string | null;
  confidence?: number | null;
  requirement_ids: string[];
}

export interface CoverageReport {
  requirements: RequirementCoverage[];
  recommended_gears: RecommendedGear[];
}

export interface RunRequestBody {
  product: string;
  documents: { path: string; sha256: string; content: string }[];
  options: Record<string, unknown>;
}

/** The service refused, or could not be reached. `message` is one line for a person. */
export class MatcherError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'MatcherError';
  }
}

type Fetch = typeof fetch;

async function read<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  let code = 'unavailable';
  let detail = `the matcher answered ${response.status}`;
  try {
    const problem = (await response.json()) as {
      code?: string;
      detail?: string;
    };
    code = problem.code ?? code;
    detail = problem.detail ?? detail;
  } catch {
    // Not a problem document: a proxy's own page, or nothing. The status says enough.
  }
  throw new MatcherError(detail, code, response.status);
}

export interface MatcherClient {
  submit(body: RunRequestBody, idempotencyKey: string): Promise<MatcherRun>;
  run(id: string): Promise<MatcherRun>;
  report(id: string): Promise<CoverageReport>;
}

export function createMatcherClient(fetchImpl: Fetch = (...args) => fetch(...args)): MatcherClient {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    try {
      return await read<T>(await fetchImpl(`${GEARS_MATCHER_BASE}${path}`, init));
    } catch (error) {
      if (error instanceof MatcherError) throw error;
      throw new MatcherError('the matcher could not be reached', 'unreachable', 0);
    }
  };
  return {
    submit: (body, idempotencyKey) =>
      call<MatcherRun>('/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
    run: (id) => call<MatcherRun>(`/runs/${encodeURIComponent(id)}`),
    report: (id) => call<CoverageReport>(`/runs/${encodeURIComponent(id)}/report`),
  };
}

export const matcherClient = createMatcherClient();
