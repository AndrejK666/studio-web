import { BuildReports, IdeBuildReport } from './gearbox-build-reports';

const res = (status: number): Response => ({ ok: status >= 200 && status < 300, status }) as unknown as Response;

const report: IdeBuildReport = {
    build_id: 'b-abc-12345678',
    action: 'build',
    status: 'running',
    product: 'shop',
    started_at: '2026-10-15T10:00:00.000Z',
};

describe('a build the IDE ran, told to the Studio server', () => {
    it('goes to the project the folder was opened for, saying where it ran', async () => {
        const sent: { path: string; body: unknown }[] = [];
        const reports = new BuildReports(
            async () => ({ kind: 'project', workspaceId: 'w', projectId: 'p-1' }),
            async () => true,
            async (path, init) => {
                sent.push({ path, body: JSON.parse(String(init?.body)) });
                return res(200);
            },
        );
        await reports.report('/home/a/p/products/shop/product.gdl', report);
        expect(sent).toEqual([
            { path: '/studio-artifact-ingest/v1/builds?project_id=p-1', body: { ...report, where: 'desktop' } },
        ]);
    });

    it('in a session says so, and outside a Studio project says nothing', async () => {
        const bodies: unknown[] = [];
        const session = new BuildReports(
            async () => ({ kind: 'project', workspaceId: 'w', projectId: 'p' }),
            async () => false,
            async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body)));
                return res(200);
            },
        );
        await session.report('/w/p/product.gdl', report);
        expect((bodies[0] as { where: string }).where).toBe('session');

        let asked = false;
        const outside = new BuildReports(async () => undefined, async () => true, async () => {
            asked = true;
            return res(200);
        });
        await outside.report('/x/product.gdl', report);
        expect(asked).toBe(false);
    });

    it('a refusal is thrown, for the caller to log', async () => {
        const refused = new BuildReports(
            async () => ({ kind: 'project', workspaceId: 'w', projectId: 'p' }),
            async () => true,
            async () => res(400),
        );
        await expect(refused.report('/p/product.gdl', report)).rejects.toThrow('HTTP 400');
    });
});
