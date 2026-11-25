/** The organization overview's shape (GET /studio-organizations/v1/overview).
 *
 * What a kit knows -- spend, pull requests, specs, the component registry -- is
 * that kit's block (`blocks`, ADR-0079): its tile and its needs come in the kit's
 * own words, so this screen draws any kit's block without knowing the kit. What
 * stays named here is the organization's own: its needs, people and workspaces. */

export interface OrgOverview {
  organization_id: string;
  name: string;
  period_from: string;
  period_to: string;
  previous_from: string;
  previous_to: string;
  stuck_days: number;
  growth_alert: number;
  quiet_days: number;
  /** The organization's own needs: refused connections, failed runs. */
  needs: OrgNeed[];
  /** The blocks of the kits installed for the organization, in their order. */
  blocks: OverviewBlock[];
  people: {
    active: number | null;
    idle: { person_id: string; name: string | null }[] | null;
  };
  workspaces: OrgWorkspace[];
  /** The currency the workspaces' and projects' spend is in; null without spend. */
  currency?: string | null;
  recent_failures?: OrgRunFailure[] | null;
  /**
   * The organization's kits the answer was computed for (ADR-0070 §7): a block
   * of a kit not among them is not there. Null when they could not be read.
   */
  kits?: string[] | null;
}

export interface OrgNeed {
  kind: 'connection' | 'runs';
  tone: 'danger' | 'warn';
  provider?: string | null;
  status?: string | null;
  projects: string[];
  repos?: number | null;
  runs?: number | null;
}

/** Words by language tag; `en` is always there. A `{name}` is an argument. */
export type Words = Record<string, string>;

/** One argument of a line: money, a count (null: unknown), or text. */
export interface LineArg {
  kind: string;
  value?: number | null;
  currency?: string | null;
  text?: string | null;
}

export interface Line {
  text: Words;
  args: Record<string, LineArg>;
}

/** Where something leads: a screen, or that screen inside a project. */
export interface BlockLink {
  route: string;
  view?: string | null;
  label: Words;
  workspace_id?: string | null;
  project_id?: string | null;
}

export interface BlockTile {
  title: Words;
  value?: Line | null;
  lines: Line[];
  link?: BlockLink | null;
  items?: { label: Words; rows: { text: Line; link: BlockLink }[] } | null;
}

export interface BlockDetails {
  label: Words;
  rows: { text: string; href?: string | null; note: Line[] }[];
}

export interface BlockNeed {
  key: string;
  tone: string;
  sentence: Line;
  detail?: Line | null;
  action?: BlockLink | null;
  details?: BlockDetails | null;
}

export interface OverviewBlock {
  kit: string;
  id: string;
  order: number;
  tile: BlockTile | null;
  needs: BlockNeed[];
  /** The kit's own figures. */
  data: unknown;
}

export interface OrgRunFailure {
  id: string;
  tenant_id: string;
  task_type: string;
  created_at: string;
}

export interface OrgReason {
  kind: 'refused' | 'specs_failing' | 'stuck' | 'spend_grows' | 'quiet';
  value: number | null;
}

export interface OrgProjectHealth {
  id: string;
  name: string;
  spend: number | null;
  previous: number | null;
  specs_failing: number | null;
  open_findings: number | null;
  stuck: number;
  quiet_days: number | null;
  broken: boolean;
  score: number;
  reasons: OrgReason[];
  /** The phase Project lifecycle has it in (`idea`, `discovery`, `build`, `run`); null or absent for none. */
  phase?: string | null;
}

export interface OrgWorkspace {
  id: string;
  name: string;
  spend: number | null;
  previous: number | null;
  specs_failing: number;
  stuck: number;
  quiet_days: number | null;
  score: number;
  projects: OrgProjectHealth[];
}
