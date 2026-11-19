/**
 * How the organization's projects use the gears matcher
 * (`GET /studio-product/v1/gear-match-usage?organization_id=&period_days=`,
 * docs/design/product-gear-match.md §9), and the pure helpers the
 * Organization › Gears matcher page draws it with: the period kept in the
 * address, the grid's rows, search and order. Pure.
 */

import type { LocalGridOptions } from '@constructor-studio/mfe-shared/grid';

export interface RunCounts {
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  cancelled: number;
  running: number;
}

export interface ModelUsage {
  calls: number;
  cache_hits: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageCount {
  key: string;
  projects: number;
}

export interface UsageTotals {
  requirements: number;
  covered: number;
  partial: number;
  gap: number;
  clarification_needed: number;
  not_assessed: number;
}

export interface UsageItem {
  project_id: string;
  project_name: string;
  workspace_id: string;
  workspace_name: string;
  /** `spec_mapping`, `gears_matcher` or `manual`. */
  strategy: string;
  chosen: string;
  source: 'project' | 'organization' | 'studio';
  fallback?: { code: string; reason: string } | null;
  last_run?: {
    match_id: string;
    state: string;
    created_at: string;
    finished_at?: string | null;
    totals?: UsageTotals | null;
  } | null;
  runs: RunCounts;
  usage: ModelUsage;
  accepted: number;
  rejected: number;
  questions_open: number;
  questions_answered: number;
}

export interface MatcherService {
  /** The strategy it runs (`gears_matcher`, or an organization kit's); absent from an older server. */
  strategy?: string;
  /** The strategy's name, as its kit says it. */
  name?: string;
  kit?: string;
  /** `MATCHER_NOT_CONFIGURED` or `STRATEGY_NOT_CONNECTED`; null when it can run. */
  code?: string | null;
  /** Runs it started in the period, and what they spent. */
  runs?: number;
  usage?: ModelUsage;
  configured: boolean;
  missing?: string | null;
  /** Null when nothing was asked (not configured). */
  answers?: boolean | null;
  checked_at?: string | null;
  error?: string | null;
  service_version?: string | null;
  matcher_version?: string | null;
  catalogue_source?: string | null;
  catalogue_commit?: string | null;
  models: string[];
  limits?: { max_documents?: number | null; max_document_bytes?: number | null; max_request_bytes?: number | null } | null;
}

export interface GearMatchUsage {
  organization_id: string;
  period_days: number;
  since: string;
  summary: {
    projects: number;
    projects_matched: number;
    strategies: UsageCount[];
    sources: UsageCount[];
    fallbacks: UsageCount[];
    runs: RunCounts;
    usage: ModelUsage;
    accepted: number;
    rejected: number;
    questions_open: number;
    questions_answered: number;
    median_run_ms?: number | null;
  };
  /** The shipped strategy's service. */
  service: MatcherService;
  /** Every service strategy the organization's kits provide, the shipped one first. */
  services?: MatcherService[];
  items: UsageItem[];
  total: number;
}

/** The periods the page offers, in days; the first that is not the default is the shortest. */
export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = 30;

/** The period an address value names; the default for anything else. */
export function periodOf(value: unknown): Period {
  const n = typeof value === 'string' ? Number(value) : value;
  return (PERIODS as readonly unknown[]).includes(n) ? (n as Period) : DEFAULT_PERIOD;
}

/** How the service stands: answering, configured but silent, or not configured. */
export type ServiceState = 'answers' | 'silent' | 'unknown' | 'missing' | 'unconnected';

/** The service blocks to show: every service strategy's, else (an older server) the shipped one's. */
export function servicesOf(u: GearMatchUsage): MatcherService[] {
  return u.services?.length ? u.services : [u.service];
}

/** Projects assembled by a service strategy (every strategy but `spec_mapping` and `manual`). */
export function serviceProjects(list: readonly UsageCount[]): number {
  return list.filter((c) => c.key !== 'spec_mapping' && c.key !== 'manual').reduce((n, c) => n + c.projects, 0);
}

export function serviceState(s: MatcherService): ServiceState {
  if (s.code === 'STRATEGY_NOT_CONNECTED') return 'unconnected';
  if (!s.configured) return 'missing';
  if (s.answers === true) return 'answers';
  if (s.answers === false) return 'silent';
  return 'unknown';
}

/** The count of one key (a strategy, a source, a fallback). */
export function countOf(list: readonly UsageCount[], key: string): number {
  return list.find((c) => c.key === key)?.projects ?? 0;
}

/** A large number in a short form: 651 649 → "652k", 1 200 000 → "1.2M". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** A duration in milliseconds as minutes and seconds: 360000 → "6 min", 95000 → "1 min 35 s". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/** A row of the projects grid. */
export interface UsageRow extends UsageItem {
  id: string;
}

export function usageRows(items: readonly UsageItem[]): UsageRow[] {
  return items.map((i) => ({ ...i, id: i.project_id }));
}

const tokens = (r: UsageItem) => r.usage.input_tokens + r.usage.output_tokens;
const coverage = (r: UsageItem) => {
  const t = r.last_run?.totals;
  return t && t.requirements > 0 ? (t.covered + t.partial / 2) / t.requirements : -1;
};

/** The order a strategy sorts in: the matcher first, as the page is its kit's. */
const STRATEGY_RANK: Record<string, number> = { gears_matcher: 0, spec_mapping: 1, manual: 2 };

export const USAGE_OPTIONS: LocalGridOptions<UsageRow> = {
  search: (r) => [r.project_name, r.workspace_name, r.strategy, r.last_run?.state],
  compare: {
    project: (a, b) => a.project_name.localeCompare(b.project_name) || a.workspace_name.localeCompare(b.workspace_name),
    strategy: (a, b) => (STRATEGY_RANK[a.strategy] ?? 9) - (STRATEGY_RANK[b.strategy] ?? 9),
    last_run: (a, b) => (a.last_run?.created_at ?? '').localeCompare(b.last_run?.created_at ?? ''),
    coverage: (a, b) => coverage(a) - coverage(b),
    runs: (a, b) => a.runs.total - b.runs.total,
    tokens: (a, b) => tokens(a) - tokens(b),
    decisions: (a, b) => a.accepted + a.rejected - (b.accepted + b.rejected),
    questions: (a, b) => a.questions_open - b.questions_open,
  },
};
