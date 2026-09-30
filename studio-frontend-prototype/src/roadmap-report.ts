// The roadmap report, as `GET /studio-components-catalog/v1/roadmap-report`
// serves it (`components_catalog/roadmap_report.rs`), and the two sheets a
// download writes: Roadmap, one row per planned component, and Summary.
// The server decides every number; this only lays them out.

import type { Cell, Sheet } from "./xlsx";

export interface RoadmapDemand {
  consumer: string;
  priority: number;
}

export interface RoadmapAxis {
  label: string;
  value: string;
  pct: number | null;
}

export interface RoadmapReadiness {
  stage: string | null;
  stage_at: number | null;
  stage_of: number | null;
  lifecycle: string | null;
  milestone: string | null;
  due: string | null;
  committed: boolean | null;
  plan: string | null;
  plan_lamp: string | null;
  plan_reasons: string[];
  demand: RoadmapDemand[];
  progress: RoadmapAxis[];
  last_release: string | null;
  released_on: string | null;
  used_by: number | null;
  roadmap_item: string | null;
  grade: string | null;
  grade_fixes: string[];
}

export interface RoadmapRow {
  /** The implementing component, or the board's title for a gear with no code. */
  name: string;
  /** The board's title for the gear. */
  title: string;
  number: number | null;
  /** The title's `DOMAIN - ` prefix, or `Ungrouped`. */
  group: string;
  /** The catalogued components it is the plan of; empty: no code yet. */
  components: string[];
  closed: boolean;
  off_board: boolean;
  category: string | null;
  readiness: RoadmapReadiness;
  assignees: string | null;
  /** Person-days. */
  effort_md: number | null;
  remaining_md: number | null;
  roadmap_title: string | null;
}

export interface RoadmapGroup {
  group: string;
  total: number;
  done: number;
  in_code: number;
  axes: { label: string; average: number | null }[];
  estimated: number;
  effort_md: number;
  remaining_md: number;
}

export interface RoadmapCount {
  label: string;
  count: number;
}

export interface RoadmapMilestone {
  milestone: string;
  due: string | null;
  total: number;
  committed: number;
  at_risk: number;
}

export interface RoadmapConsumer {
  consumer: string;
  p1: number;
  p2: number;
  p3: number;
  p1_not_on_track: number;
}

export interface RoadmapReport {
  items: RoadmapRow[];
  total: number;
  /** Gears no catalogued component implements yet. */
  not_in_code: number;
  not_on_board: number;
  summary: {
    by_group: RoadmapGroup[];
    by_stage: RoadmapCount[];
    by_milestone: RoadmapMilestone[];
    by_consumer: RoadmapConsumer[];
    by_plan: RoadmapCount[];
    overdue: string[];
  };
}

/** `Acronis P1, Virtuozzo P3`, most urgent first. */
export function demandText(demand: RoadmapDemand[]): string {
  return [...demand]
    .sort((a, b) => a.priority - b.priority || a.consumer.localeCompare(b.consumer))
    .map((d) => `${d.consumer} P${d.priority}`)
    .join(", ");
}

/** The progress axes across all rows, in the order the board lists them. */
export function axesOf(items: RoadmapRow[]): string[] {
  const out: string[] = [];
  for (const row of items)
    for (const a of row.readiness.progress) if (!out.includes(a.label)) out.push(a.label);
  return out;
}

const yesNo = (b: boolean | null) => (b === null ? null : b ? "yes" : "no");

export function roadmapSheet(report: RoadmapReport): Sheet {
  const axes = axesOf(report.items);
  const header = [
    "ID",
    "Group",
    "Gear",
    "Components",
    "Stage",
    "Milestone",
    "Due",
    "Committed",
    "Plan",
    "Why",
    "Demand",
    ...axes,
    "Assignees",
    "Effort m*d",
    "Remaining m*d",
    "Lifecycle",
    "Last release",
    "Released on",
    "Grade",
    "Board item",
    "Link",
  ];
  const rows: Cell[][] = report.items.map((row) => {
    const r = row.readiness;
    return [
      row.number,
      row.group,
      row.title,
      row.components.join(", ") || "not in code yet",
      r.stage,
      r.milestone,
      r.due,
      yesNo(r.committed),
      r.plan,
      r.plan_reasons.join("; ") || null,
      demandText(r.demand) || null,
      // A percentage as a number, so the sheet can sort and sum it; `Done`
      // or `N/A` as the board wrote it.
      ...axes.map((label) => {
        const a = r.progress.find((p) => p.label === label);
        if (!a) return null;
        return /^\d+%$/.test(a.value) && a.pct !== null ? a.pct : a.value;
      }),
      row.assignees,
      row.effort_md,
      row.remaining_md === null ? null : Math.round(row.remaining_md * 10) / 10,
      r.lifecycle,
      r.last_release,
      r.released_on,
      r.grade,
      row.roadmap_title,
      r.roadmap_item,
    ];
  });
  const widths = header.map((h) =>
    h === "Gear" || h === "Components" ? 34 : h === "Why" ? 48 : h === "Board item" ? 40 : h === "Link" ? 44 : Math.max(8, h.length + 2),
  );
  return { name: "Roadmap", rows: [header, ...rows], widths };
}

export function summarySheet(report: RoadmapReport, asOf: string): Sheet {
  const s = report.summary;
  const axisLabels: string[] = [];
  for (const g of s.by_group) for (const a of g.axes) if (!axisLabels.includes(a.label)) axisLabels.push(a.label);
  const rows: Cell[][] = [
    ["Roadmap report", asOf],
    ["Gears on the board", report.total],
    ["Not in code yet", report.not_in_code],
    ["Catalogued, not on the board", report.not_on_board],
    [],
    ["Group", "Gears", "Done", "In code", ...axisLabels.map((l) => `${l} %`), "Estimated", "Effort m*d", "Remaining m*d"],
    ...s.by_group.map((g) => [
      g.group,
      g.total,
      g.done,
      g.in_code,
      ...axisLabels.map((l) => g.axes.find((a) => a.label === l)?.average ?? null),
      g.estimated,
      g.effort_md,
      Math.round(g.remaining_md * 10) / 10,
    ]),
    [],
    ["Stage", "Gears"],
    ...s.by_stage.map((c) => [c.label, c.count]),
    [],
    ["Milestone", "Due", "Gears", "Committed", "At risk"],
    ...s.by_milestone.map((m) => [m.milestone, m.due, m.total, m.committed, m.at_risk]),
    [],
    ["Consumer", "P1", "P2", "P3", "P1 not on track"],
    ...s.by_consumer.map((c) => [c.consumer, c.p1, c.p2, c.p3, c.p1_not_on_track]),
    [],
    ["Plan", "Gears"],
    ...s.by_plan.map((c) => [c.label, c.count]),
  ];
  if (s.overdue.length) rows.push([], ["Overdue"], ...s.overdue.map((n) => [n]));
  // The title, and the first row of each section after a blank one.
  const bold = rows.flatMap((_, i) => (i === 0 || (i > 0 && rows[i - 1].length === 0) ? [i] : []));
  return { name: "Summary", rows, widths: [34, 14, 12, 12, 16], bold, freeze: false };
}

export function reportSheets(report: RoadmapReport, asOf: string): Sheet[] {
  return [roadmapSheet(report), summarySheet(report, asOf)];
}
