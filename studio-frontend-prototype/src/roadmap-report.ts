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
  name: string;
  category: string | null;
  readiness: RoadmapReadiness;
  assignees: string | null;
  effort: string | null;
  roadmap_title: string | null;
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
  not_on_board: number;
  summary: {
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
    "Component",
    "Category",
    "Stage",
    "Milestone",
    "Due",
    "Committed",
    "Plan",
    "Why",
    "Demand",
    ...axes,
    "Assignees",
    "Effort",
    "Lifecycle",
    "Last release",
    "Released on",
    "Grade",
    "Board item",
    "Link",
  ];
  const rows: Cell[][] = report.items.map((row) => {
    const r = row.readiness;
    const effort = row.effort !== null && /^\d+(\.\d+)?$/.test(row.effort) ? Number(row.effort) : row.effort;
    return [
      row.name,
      row.category,
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
      effort,
      r.lifecycle,
      r.last_release,
      r.released_on,
      r.grade,
      row.roadmap_title,
      r.roadmap_item,
    ];
  });
  const widths = header.map((h) =>
    h === "Component" ? 34 : h === "Why" ? 48 : h === "Board item" ? 40 : h === "Link" ? 44 : Math.max(10, h.length + 2),
  );
  return { name: "Roadmap", rows: [header, ...rows], widths };
}

export function summarySheet(report: RoadmapReport, asOf: string): Sheet {
  const s = report.summary;
  const rows: Cell[][] = [
    ["Roadmap report", asOf],
    ["Components on the board", report.total],
    ["Catalogued, not on the board", report.not_on_board],
    [],
    ["Stage", "Components"],
    ...s.by_stage.map((c) => [c.label, c.count]),
    [],
    ["Milestone", "Due", "Components", "Committed", "At risk"],
    ...s.by_milestone.map((m) => [m.milestone, m.due, m.total, m.committed, m.at_risk]),
    [],
    ["Consumer", "P1", "P2", "P3", "P1 not on track"],
    ...s.by_consumer.map((c) => [c.consumer, c.p1, c.p2, c.p3, c.p1_not_on_track]),
    [],
    ["Plan", "Components"],
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
