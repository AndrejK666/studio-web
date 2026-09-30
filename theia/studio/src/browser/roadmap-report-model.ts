import { StudioApi } from './studio-api';
import { ReferenceReadiness, demandText, failureMessage } from './components-reference-model';
import type { Cell, Sheet } from './xlsx';

/*
 * The roadmap report, as the IDE reads it.
 *
 * One read -- `GET /studio-components-catalog/v1/roadmap-report` -- answers
 * every component the roadmap board plans, one row each, and a summary per
 * stage, milestone, consumer and plan state. The numbers are the backend's
 * (`components_catalog/roadmap_report.rs`); this file only lays them out, for
 * the widget and for the workbook's Roadmap and Summary sheets, so the layout
 * is testable without a widget.
 *
 * Through `StudioApi.fetch`, which the portal session and the desktop both
 * answer, so there is no host branch here.
 */

export const ROADMAP_REPORT_PATH = '/studio-components-catalog/v1/roadmap-report';

export interface RoadmapRow {
    /** The implementing component, or the board's title for a gear with no code. */
    readonly name: string;
    /** The board's title for the gear. */
    readonly title: string;
    readonly number: number | null;
    /** The title's `DOMAIN - ` prefix, or `Ungrouped`. */
    readonly group: string;
    /** The catalogued components it is the plan of; empty: no code yet. */
    readonly components: readonly string[];
    readonly closed: boolean;
    readonly off_board: boolean;
    readonly category: string | null;
    readonly readiness: ReferenceReadiness;
    readonly assignees: string | null;
    /** Person-days. */
    readonly effort_md: number | null;
    readonly remaining_md: number | null;
    readonly roadmap_title: string | null;
}

export interface RoadmapGroup {
    readonly group: string;
    readonly total: number;
    readonly done: number;
    readonly in_code: number;
    readonly axes: readonly { readonly label: string; readonly average: number | null }[];
    readonly estimated: number;
    readonly effort_md: number;
    readonly remaining_md: number;
}

export interface RoadmapCount {
    readonly label: string;
    readonly count: number;
}

export interface RoadmapMilestone {
    readonly milestone: string;
    readonly due: string | null;
    readonly total: number;
    readonly committed: number;
    readonly at_risk: number;
}

export interface RoadmapConsumer {
    readonly consumer: string;
    readonly p1: number;
    readonly p2: number;
    readonly p3: number;
    readonly p1_not_on_track: number;
}

export interface RoadmapReport {
    readonly items: readonly RoadmapRow[];
    readonly total: number;
    /** Gears no catalogued component implements yet. */
    readonly not_in_code: number;
    readonly not_on_board: number;
    readonly summary: {
        readonly by_group: readonly RoadmapGroup[];
        readonly by_stage: readonly RoadmapCount[];
        readonly by_milestone: readonly RoadmapMilestone[];
        readonly by_consumer: readonly RoadmapConsumer[];
        readonly by_plan: readonly RoadmapCount[];
        readonly overdue: readonly string[];
    };
}

export type RoadmapLoad =
    | { readonly kind: 'ok'; readonly report: RoadmapReport }
    | { readonly kind: 'error'; readonly message: string };

type Fetch = (path: string) => Promise<Response>;

/** Read the report. Never throws: a failure becomes a sentence a person can act on. */
export async function loadRoadmapReport(fetchApi: Fetch = path => StudioApi.fetch(path)): Promise<RoadmapLoad> {
    let res: Response;
    try {
        res = await fetchApi(ROADMAP_REPORT_PATH);
    } catch (e) {
        return { kind: 'error', message: `Studio could not be reached: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!res.ok) {
        return { kind: 'error', message: roadmapFailure(res.status) };
    }
    try {
        const body = await res.json() as RoadmapReport;
        if (!body || !Array.isArray(body.items) || !body.summary) {
            throw new Error('shape');
        }
        return { kind: 'ok', report: body };
    } catch {
        return { kind: 'error', message: 'Studio answered with something that is not a roadmap report.' };
    }
}

export function roadmapFailure(status: number): string {
    switch (status) {
        case 401:
            return 'You are not signed in to Studio, so the roadmap cannot be read. Sign in and reload.';
        case 403:
            return 'Your Studio account may not read the component catalogue, which the roadmap report is built from.';
        case 404:
            return 'This Studio does not serve the roadmap report yet (its backend is older than the IDE).';
        default:
            return failureMessage(status).replace('list the components', 'read the roadmap');
    }
}

/** The progress axes across all rows, in the order the board lists them. */
export function axesOf(items: readonly RoadmapRow[]): string[] {
    const out: string[] = [];
    for (const row of items) {
        for (const a of row.readiness.progress) {
            if (!out.includes(a.label)) {
                out.push(a.label);
            }
        }
    }
    return out;
}

/** The progress axes across the groups, in board order. */
export function groupAxes(groups: readonly RoadmapGroup[]): string[] {
    const out: string[] = [];
    for (const g of groups) {
        for (const a of g.axes) {
            if (!out.includes(a.label)) {
                out.push(a.label);
            }
        }
    }
    return out;
}

/** `roadmap-2026-09-29.xlsx`. */
export function workbookName(asOf: string): string {
    return `roadmap-${asOf}.xlsx`;
}

const yesNo = (b: boolean | null) => (b === null ? null : b ? 'yes' : 'no');

export function roadmapSheet(report: RoadmapReport): Sheet {
    const axes = axesOf(report.items);
    const header = [
        'ID', 'Group', 'Gear', 'Components', 'Stage', 'Milestone', 'Due', 'Committed', 'Plan', 'Why', 'Demand',
        ...axes,
        'Assignees', 'Effort m*d', 'Remaining m*d', 'Lifecycle', 'Last release', 'Released on', 'Grade', 'Board item', 'Link',
    ];
    const rows: Cell[][] = report.items.map(row => {
        const r = row.readiness;
        return [
            row.number,
            row.group,
            row.title,
            row.components.join(', ') || 'not in code yet',
            r.stage,
            r.milestone,
            r.due,
            yesNo(r.committed),
            r.plan,
            r.plan_reasons.join('; ') || null,
            demandText(r)?.replace(/ · /g, ', ') ?? null,
            // A percentage as a number, so the sheet can sort and sum it; `Done`
            // or `N/A` as the board wrote it.
            ...axes.map(label => {
                const a = r.progress.find(p => p.label === label);
                if (!a) {
                    return null;
                }
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
    const widths = header.map(h =>
        h === 'Gear' || h === 'Components' ? 34 : h === 'Why' ? 48 : h === 'Board item' ? 40 : h === 'Link' ? 44 : Math.max(8, h.length + 2));
    return { name: 'Roadmap', rows: [header, ...rows], widths };
}

export function summarySheet(report: RoadmapReport, asOf: string): Sheet {
    const s = report.summary;
    const labels = groupAxes(s.by_group);
    const rows: Cell[][] = [
        ['Roadmap report', asOf],
        ['Gears on the board', report.total],
        ['Not in code yet', report.not_in_code],
        ['Catalogued, not on the board', report.not_on_board],
        [],
        ['Group', 'Gears', 'Done', 'In code', ...labels.map(l => `${l} %`), 'Estimated', 'Effort m*d', 'Remaining m*d'],
        ...s.by_group.map(g => [
            g.group, g.total, g.done, g.in_code,
            ...labels.map(l => g.axes.find(a => a.label === l)?.average ?? null),
            g.estimated, g.effort_md, Math.round(g.remaining_md * 10) / 10,
        ]),
        [],
        ['Stage', 'Gears'],
        ...s.by_stage.map(c => [c.label, c.count]),
        [],
        ['Milestone', 'Due', 'Gears', 'Committed', 'At risk'],
        ...s.by_milestone.map(m => [m.milestone, m.due, m.total, m.committed, m.at_risk]),
        [],
        ['Consumer', 'P1', 'P2', 'P3', 'P1 not on track'],
        ...s.by_consumer.map(c => [c.consumer, c.p1, c.p2, c.p3, c.p1_not_on_track]),
        [],
        ['Plan', 'Gears'],
        ...s.by_plan.map(c => [c.label, c.count]),
    ];
    if (s.overdue.length) {
        rows.push([], ['Overdue'], ...s.overdue.map(n => [n]));
    }
    // The title, and the first row of each section after a blank one.
    const bold = rows.flatMap((_, i) => (i === 0 || rows[i - 1].length === 0 ? [i] : []));
    return { name: 'Summary', rows, widths: [34, 14, 12, 12, 16], bold, freeze: false };
}

export function reportSheets(report: RoadmapReport, asOf: string): Sheet[] {
    return [roadmapSheet(report), summarySheet(report, asOf)];
}
