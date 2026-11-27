/**
 * What `studio-kits` answers under `/mna/*` (the `mna` kit, ADR-0073): the
 * deal — a project of the kit's project type — its evidence, and its three
 * ledgers. Times are RFC 3339; `ic_date` is `YYYY-MM-DD`.
 */

export interface MnaDeal {
  project_id: string;
  /** False: the kit does not apply to this project. */
  installed: boolean;
  target: string | null;
  thesis: string | null;
  deal_phase: string | null;
  ic_date: string | null;
  recommendation: string | null;
  conditions: string[];
  /** A subject id. */
  signed_off_by: string | null;
  signed_off_at: string | null;
  /** The project's owner (a subject id): the one who signs off. */
  deal_lead: string | null;
  /** Whether the caller is the deal lead. */
  may_sign_off: boolean;
  /** The phases, in order: screening, confirmatory_dd, signing, integration. */
  phases: string[];
  /** proceed, proceed_with_conditions, stop. */
  recommendations: string[];
}

/** Every field optional: a field present replaces, an empty string clears; `conditions` replaces the list. */
export interface MnaDealPatch {
  target?: string;
  thesis?: string;
  deal_phase?: string;
  ic_date?: string;
  recommendation?: string;
  conditions?: string[];
}

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const FINDING_STATUSES = ['open', 'accepted', 'resolved'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export interface MnaFinding {
  id: string;
  title: string;
  severity: Severity;
  /** The repository or part of the target it is about. */
  source: string | null;
  evidence: string | null;
  /** Where it came from: manual, spec_check, ci, git, interview, … */
  origin: string;
  status: FindingStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MnaFindingBody {
  title: string;
  severity: Severity;
  source?: string;
  evidence?: string;
  origin?: string;
  status?: FindingStatus;
}

export const LIKELIHOODS = ['low', 'medium', 'high'] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];
export const IMPACTS = ['low', 'medium', 'high', 'critical'] as const;
export type Impact = (typeof IMPACTS)[number];
export const RISK_STATUSES = ['open', 'mitigating', 'accepted', 'closed'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export interface MnaRisk {
  id: string;
  title: string;
  likelihood: Likelihood;
  impact: Impact;
  owner: string | null;
  mitigation: string | null;
  /** The finding it comes from. */
  finding_id: string | null;
  status: RiskStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MnaRiskBody {
  title: string;
  likelihood: Likelihood;
  impact: Impact;
  owner?: string;
  mitigation?: string;
  finding_id?: string;
  status?: RiskStatus;
}

export const QUESTION_STATUSES = ['open', 'answered', 'closed'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export interface MnaQuestion {
  id: string;
  what: string;
  who: string | null;
  answer: string | null;
  status: QuestionStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MnaQuestionBody {
  what: string;
  who?: string;
  answer?: string;
  status?: QuestionStatus;
}

export interface MnaList<T> {
  items: T[];
  total: number;
}

export interface MnaEvidenceRepository {
  full_path: string;
  branch: string | null;
  synced_at: string | null;
  contributors: number | null;
  truck_factor: number | null;
}

export interface MnaFact {
  key: string;
  value: number | null;
  total: number | null;
  /** False: the server could not read it; `detail` says why, and there is no number. */
  available: boolean;
  /** Where the number came from. */
  source: string;
  detail: string | null;
}

export interface MnaEvidence {
  project_id: string;
  read_at: string;
  repositories: MnaEvidenceRepository[];
  facts: MnaFact[];
}

/** The three ledgers, by the path segment each lives under. */
export interface MnaLedgers {
  findings: { row: MnaFinding; body: MnaFindingBody };
  risks: { row: MnaRisk; body: MnaRiskBody };
  'open-questions': { row: MnaQuestion; body: MnaQuestionBody };
}

export type MnaLedger = keyof MnaLedgers;
