import { ReferenceReadiness } from './components-reference-model';
import {
    RoadmapReport,
    RoadmapRow,
    ROADMAP_REPORT_PATH,
    ROADMAP_WORKBOOK_PATH,
    loadRoadmapReport,
    loadRoadmapWorkbook,
    workbookName,
} from './roadmap-report-model';

function answer(status: number, body: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function row(name: string, over: Partial<ReferenceReadiness> = {}): RoadmapRow {
    return {
        name,
        category: 'core',
        assignees: '@a, @b',
        title: `CORE - ${name}`,
        number: 1,
        group: 'CORE',
        components: [name],
        closed: false,
        off_board: false,
        effort_md: 40,
        remaining_md: 20,
        roadmap_title: `#1 ${name}`,
        readiness: {
            stage: 'In Dev',
            stage_at: 3,
            stage_of: 6,
            lifecycle: null,
            milestone: '26.10',
            due: '2026-10-31',
            committed: true,
            plan: 'on track',
            plan_lamp: 'good',
            plan_reasons: [],
            demand: [],
            progress: [],
            last_release: null,
            released_on: null,
            used_by: null,
            roadmap_item: 'https://github.com/o/r/issues/1',
            grade: 'C',
            grade_fixes: [],
            ...over,
        },
    };
}

const report: RoadmapReport = {
    items: [
        row('cf-gears-event-broker', {
            demand: [{ consumer: 'Virtuozzo', priority: 3 }, { consumer: 'Acronis', priority: 1 }],
            progress: [{ label: 'Design', value: '80%', pct: 80 }, { label: 'SDK', value: 'Done', pct: 100 }],
        }),
        row('cf-gears-file-storage', {
            plan: 'at risk',
            plan_lamp: 'bad',
            plan_reasons: ['overdue: due 2026-07-31', 'P1 for Acronis'],
            progress: [{ label: 'Tests', value: 'N/A', pct: null }],
        }),
    ],
    total: 2,
    not_in_code: 0,
    not_on_board: 5,
    summary: {
        by_group: [{
            group: 'CORE', total: 2, done: 0, in_code: 2,
            axes: [{ label: 'Design', average: 80 }, { label: 'SDK', average: null }],
            estimated: 2, effort_md: 80, remaining_md: 40,
        }],
        by_stage: [{ label: 'In Dev', count: 2 }],
        by_milestone: [{ milestone: '26.10', due: '2026-10-31', total: 2, committed: 2, at_risk: 1 }],
        by_consumer: [{ consumer: 'Acronis', p1: 1, p2: 0, p3: 0, p1_not_on_track: 0 }],
        by_plan: [{ label: 'at risk', count: 1 }, { label: 'on track', count: 1 }],
        overdue: ['cf-gears-file-storage'],
    },
};

describe('roadmap report', () => {
    it('reads the report in one request and turns a refusal into a sentence', async () => {
        const asked: string[] = [];
        const ok = await loadRoadmapReport(async path => { asked.push(path); return answer(200, report); });
        expect(asked).toEqual([ROADMAP_REPORT_PATH]);
        expect(ok.kind).toBe('ok');
        const old = await loadRoadmapReport(async () => answer(404, {}));
        expect(old).toEqual({ kind: 'error', message: expect.stringContaining('older than the IDE') });
        const refused = await loadRoadmapReport(async () => answer(401, {}));
        expect(refused).toEqual({ kind: 'error', message: expect.stringContaining('roadmap cannot be read') });
        const broken = await loadRoadmapReport(async () => answer(500, {}));
        expect(broken).toEqual({ kind: 'error', message: 'Studio could not read the roadmap (HTTP 500).' });
        const odd = await loadRoadmapReport(async () => answer(200, { items: 'no' }));
        expect(odd).toEqual({ kind: 'error', message: expect.stringContaining('not a roadmap report') });
        const down = await loadRoadmapReport(async () => { throw new Error('offline'); });
        expect(down).toEqual({ kind: 'error', message: expect.stringContaining('offline') });
    });

    it('saves the workbook the server writes, named the way the planning team names it', async () => {
        expect(workbookName('2026-09-29')).toBe('back_roadmap_2026-09-29.xlsx');
        const asked: string[] = [];
        const bytes = [0x50, 0x4b, 0x03, 0x04];
        const ok = await loadRoadmapWorkbook('2026-09-29', async path => {
            asked.push(path);
            return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer } as Response;
        });
        expect(asked).toEqual([`${ROADMAP_WORKBOOK_PATH}?date=2026-09-29`]);
        expect(ok.kind === 'ok' && Array.from(ok.bytes)).toEqual(bytes);
        const old = await loadRoadmapWorkbook('2026-09-29', async () => answer(404, {}));
        expect(old).toEqual({ kind: 'error', message: expect.stringContaining('older than the IDE') });
        const down = await loadRoadmapWorkbook('2026-09-29', async () => { throw new Error('offline'); });
        expect(down).toEqual({ kind: 'error', message: expect.stringContaining('offline') });
    });
});
