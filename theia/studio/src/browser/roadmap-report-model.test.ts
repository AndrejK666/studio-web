import { ReferenceReadiness } from './components-reference-model';
import {
    RoadmapReport,
    RoadmapRow,
    ROADMAP_REPORT_PATH,
    axesOf,
    loadRoadmapReport,
    reportSheets,
    workbookName,
} from './roadmap-report-model';
import { columnName, makeXlsx, sheetName, sheetXml, xlsxFiles } from './xlsx';
import { TextEncoder as NodeTextEncoder } from 'util';

// jsdom has no TextEncoder; every browser the IDE runs in does.
if (typeof globalThis.TextEncoder === 'undefined') {
    (globalThis as { TextEncoder?: unknown }).TextEncoder = NodeTextEncoder;
}

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

    it('lists the axes in board order and names the workbook by date', () => {
        expect(axesOf(report.items)).toEqual(['Design', 'SDK', 'Tests']);
        expect(workbookName('2026-09-29')).toBe('roadmap-2026-09-29.xlsx');
    });

    it('writes one Roadmap row per component, axes as columns', () => {
        const [roadmap, summary] = reportSheets(report, '2026-09-29');
        expect(roadmap.name).toBe('Roadmap');
        const [header, broker, files] = roadmap.rows;
        const col = (h: string) => header.indexOf(h);
        expect(broker[col('Gear')]).toBe('CORE - cf-gears-event-broker');
        expect(broker[col('Group')]).toBe('CORE');
        expect(broker[col('Components')]).toBe('cf-gears-event-broker');
        expect(broker[col('Remaining m*d')]).toBe(20);
        expect(broker[col('Demand')]).toBe('Acronis P1, Virtuozzo P3');
        expect(broker[col('Design')]).toBe(80);
        expect(broker[col('SDK')]).toBe('Done');
        expect(broker[col('Tests')]).toBeNull();
        expect(broker[col('Effort m*d')]).toBe(40);
        expect(broker[col('Committed')]).toBe('yes');
        expect(broker[col('Why')]).toBeNull();
        expect(files[col('Why')]).toBe('overdue: due 2026-07-31; P1 for Acronis');
        expect(files[col('Tests')]).toBe('N/A');

        expect(summary.name).toBe('Summary');
        expect(summary.rows).toContainEqual(['Catalogued, not on the board', 5]);
        expect(summary.rows).toContainEqual(['26.10', '2026-10-31', 2, 2, 1]);
        expect(summary.rows[summary.rows.length - 1]).toEqual(['cf-gears-file-storage']);
        expect((summary.bold ?? []).map(i => summary.rows[i][0]))
            .toEqual(['Roadmap report', 'Group', 'Stage', 'Milestone', 'Consumer', 'Plan', 'Overdue']);
        expect(summary.rows).toContainEqual(['CORE', 2, 0, 2, 80, null, 2, 80, 40]);
        expect(summary.freeze).toBe(false);
    });
});

describe('xlsx', () => {
    it('names columns past Z and keeps sheet names legal', () => {
        expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
        expect(sheetName('a/b:c')).toBe('a b c');
        expect(sheetName('x'.repeat(40))).toHaveLength(31);
    });

    it('escapes text, writes numbers as numbers, skips empty cells', () => {
        const xml = sheetXml({ name: 'S', rows: [['h'], ['<a & b>', 3, null, '']] });
        expect(xml).toContain('&lt;a &amp; b&gt;');
        expect(xml).toContain('<c r="B2"><v>3</v></c>');
        expect(xml).not.toContain('r="C2"');
        expect(xml).toContain('<c r="A1" t="inlineStr" s="1">');
        expect(xml).toContain('state="frozen"');
    });

    it('packages one worksheet per sheet, with unique names, as a zip', () => {
        const files = xlsxFiles([{ name: 'Roadmap', rows: [['a']] }, { name: 'roadmap', rows: [['b']] }]);
        expect(files.map(f => f.name)).toContain('xl/worksheets/sheet2.xml');
        const workbook = files.find(f => f.name === 'xl/workbook.xml')!.content;
        expect(workbook).toContain('name="Roadmap"');
        expect(workbook).toContain('name="roadmap 2"');
        const bytes = makeXlsx([{ name: 'S', rows: [['a']] }]);
        // Local file header first, end of central directory last.
        expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
        expect(Array.from(bytes.slice(bytes.length - 22, bytes.length - 18))).toEqual([0x50, 0x4b, 0x05, 0x06]);
    });
});
