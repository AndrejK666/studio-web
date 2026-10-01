import { StudioApi } from './studio-api';
import { ReferenceReadiness, failureMessage } from './components-reference-model';

/*
 * The roadmap report, as the IDE reads it.
 *
 * One read -- `GET /studio-reports/v1/reports/roadmap/summary` -- answers
 * every component the roadmap board plans, one row each, and a summary per
 * stage, milestone, consumer and plan state. The numbers are the backend's
 * (`reports/roadmap/summary.rs`); this file only reads them for the
 * widget. The workbook is the backend's too
 * (`reports/roadmap/workbook.rs`, drawn by the report's definition): the planning team's
 * `back_roadmap.xlsx`, which this saves as the server wrote it.
 *
 * Through `StudioApi.fetch`, which the portal session and the desktop both
 * answer, so there is no host branch here.
 */

export const ROADMAP_REPORT_PATH = '/studio-reports/v1/reports/roadmap/summary';
export const ROADMAP_WORKBOOK_PATH = '/studio-reports/v1/reports/roadmap/workbook';

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

/** `back_roadmap_2026-09-29.xlsx`, the name the planning team gives it. */
export function workbookName(asOf: string): string {
    return `back_roadmap_${asOf}.xlsx`;
}

export type WorkbookLoad =
    | { readonly kind: 'ok'; readonly bytes: Uint8Array }
    | { readonly kind: 'error'; readonly message: string };

/** Read the workbook as of `asOf` (`YYYY-MM-DD`). Never throws, like the report. */
export async function loadRoadmapWorkbook(
    asOf: string,
    fetchApi: Fetch = path => StudioApi.fetch(path),
): Promise<WorkbookLoad> {
    let res: Response;
    try {
        res = await fetchApi(`${ROADMAP_WORKBOOK_PATH}?date=${encodeURIComponent(asOf)}`);
    } catch (e) {
        return { kind: 'error', message: `Studio could not be reached: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!res.ok) {
        return {
            kind: 'error',
            message: res.status === 404
                ? 'This Studio does not write the roadmap workbook yet (its backend is older than the IDE).'
                : roadmapFailure(res.status),
        };
    }
    return { kind: 'ok', bytes: new Uint8Array(await res.arrayBuffer()) };
}
