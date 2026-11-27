/** What studio-spec-graph answers (its gear's DTOs; findings in Studio's spec_finding shape). */

export interface Anchor {
  section: string | null;
  line_start: number | null;
  line_end: number | null;
  quote: string | null;
}

export interface Finding {
  /** The fingerprint: one finding's identity on every surface. */
  id: string;
  rule: string;
  detector: string;
  severity: 'high' | 'medium' | 'low';
  /** `block`: deterministic, may fail a check; `advise`: a model's judgment. */
  gate: 'block' | 'advise';
  title: string;
  message: string;
  anchor: Anchor;
  related: { path: string; anchor: Anchor }[];
  evidence: string[];
  source: string | null;
  suggestion: { path: string; line_start: number; line_end: number; text: string } | null;
}

/** One document's findings, as one spec_finding node. */
export interface DocumentFindings {
  path: string | null;
  detector: string;
  findings: Finding[];
}

export interface SpecGraphProject {
  project_id: string;
  registered: boolean;
  project: {
    name?: string;
    scope?: string;
    repository?: { url: string; ref: string };
  } | null;
  /** The repository the graph reads, as the provider names it (`owner/name`); null when unknown. */
  repository?: string | null;
  service: { server?: { version?: string } } | null;
}

export interface SpecGraphCheck {
  revision: string;
  count: number;
  blocking: number;
  dismissed: number;
  documents: DocumentFindings[];
}

export interface SpecGraphFindingList {
  items: DocumentFindings[];
  total: number;
  dismissed: number;
}

export type Decision = 'confirmed' | 'dismissed';

/** An open pull request of the project, as Studio's sync keeps it. */
export interface OpenPullRequest {
  id: string;
  repo: string | null;
  number: number;
  title: string;
  url: string | null;
  /** The branch it would merge. */
  source_branch?: string | null;
}

/** A review thread to post on the pull request's head. */
export interface ReviewThread {
  path: string;
  line: number;
  start_line?: number;
  rule: string;
  gate: 'block' | 'advise';
  fingerprints: string[];
  /** Markdown, as CI posts it. */
  body: string;
}

/** What a pull request brings, and the threads to post. */
export interface Review {
  base: string;
  head: string;
  count: number;
  blocking: number;
  dismissed: number;
  threads: ReviewThread[];
  outside_diff: Finding[];
  fingerprints: string[];
}

export interface Run {
  id: string;
  job: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  error: string | null;
  result: (Partial<Review> & { stats?: { model_cost_usd?: number } }) | null;
}

/** A node of the project's spec graph (the service's `node` tool). */
export interface GraphNode {
  key: string;
  name?: string | null;
  type?: string | null;
  payload?: {
    path?: string;
    line?: number;
    quote?: string;
    text?: string;
    kind?: string;
    gear?: string;
    title?: string;
  } | null;
}

/** A judge's conclusion on an edge: an analysis edge with its provenance. */
export interface JudgedEdge {
  edge: string;
  from?: string;
  to?: string;
  path?: string;
  lines?: string;
  quote?: string;
  realized?: string;
  built?: string;
  by?: { method?: string; model?: string; at?: string };
}

/** The edges at a node, by type and direction (the service's `neighbors` tool). */
export interface Neighbors {
  key: string;
  in: Record<string, string[]>;
  out: Record<string, string[]>;
  judged: JudgedEdge[];
  truncated?: boolean;
}

export interface SearchHit {
  key: string;
  name?: string | null;
  type?: string | null;
  path?: string;
  line?: number;
  score?: number;
}
