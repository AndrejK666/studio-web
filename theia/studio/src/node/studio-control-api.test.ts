/**
 * @jest-environment node
 */
import * as http from 'http';
import * as express from '@theia/core/shared/express';
import { mountStudioControlApi, StudioControlContext } from './studio-control-api';

/**
 * Both protocol versions on one node (ADR-0080 §4): the v1 path and header a
 * running backend dials stay as they were, and the v2 spelling answers beside
 * them, from the same handlers.
 */
const context = (opened: string[]): StudioControlContext => ({
    workspaceId: () => 'ws',
    runtimeStatus: () => ({
        ready: true, workspaceMode: 'managed', activeClients: 1, idleSecs: 0, lastEventSequence: 7, version: 'test'
    }),
    getSession: async () => { throw new Error('unused'); },
    getRepositories: async () => [],
    projectRepositoryId: () => undefined,
    enqueueOperation: async () => { throw new Error('unused'); },
    getOperationDeltas: async () => { throw new Error('unused'); },
    retryOperation: async () => { throw new Error('unused'); },
    openInEditor: async request => { opened.push(request.relativePath); return { opened: true }; },
    notifyEditor: async () => ({ shown: true }),
    openDocument: async request => { opened.push(`doc:${request.workspaceId}/${request.documentId}`); return { opened: true }; },
    installKit: async () => { throw new Error('unused'); },
});

async function serve(env: Record<string, string | undefined>, opened: string[] = []): Promise<{
    post: (path: string, headers: Record<string, string>, body?: unknown) => Promise<{ status: number; json: unknown }>;
    close: () => Promise<void>;
    mounted: boolean;
}> {
    const saved = { ...process.env };
    delete process.env.STUDIO_THEIA_S2S_TOKEN;
    delete process.env.STUDIO_IDE_CONTROL_TOKEN;
    Object.assign(process.env, env);
    const app = express();
    const mounted = mountStudioControlApi(app, context(opened));
    process.env = saved;
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
        new Promise<{ status: number; json: unknown }>((resolve, reject) => {
            const data = JSON.stringify(body);
            const req = http.request({
                host: '127.0.0.1', port, path, method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers }
            }, res => {
                let text = '';
                res.on('data', chunk => text += chunk);
                res.on('end', () => {
                    let json: unknown;
                    try { json = JSON.parse(text); } catch { json = text; }
                    resolve({ status: res.statusCode ?? 0, json });
                });
            });
            req.on('error', reject);
            req.end(data);
        });
    return { post, mounted, close: () => new Promise(resolve => server.close(() => resolve())) };
}

describe('the control API at v1 and v2', () => {
    it('mounts nothing without a token', async () => {
        const api = await serve({});
        expect(api.mounted).toBe(false);
        expect((await api.post('/internal/ide/v2/getRuntimeStatus', { 'x-cfs-ide-token': 'x' })).status).toBe(404);
        await api.close();
    });

    it('answers v1 as before and v2 beside it, on the v1 token', async () => {
        const api = await serve({ STUDIO_THEIA_S2S_TOKEN: 'secret' });
        const v1 = await api.post('/internal/theia/v1/getRuntimeStatus', { 'x-cfs-theia-token': 'secret' });
        expect(v1.status).toBe(200);
        expect(v1.json).toMatchObject({ ready: true, lastEventSequence: 7 });
        const v2 = await api.post('/internal/ide/v2/getRuntimeStatus', { 'x-cfs-ide-token': 'secret' });
        expect(v2.status).toBe(200);
        expect(v2.json).toMatchObject({ ready: true, runtime: 'theia', protocol: 2 });
        expect((v2.json as { capabilities: string[] }).capabilities).toContain('frame_channel');
        await api.close();
    });

    it('takes each version only with its own header', async () => {
        const api = await serve({ STUDIO_THEIA_S2S_TOKEN: 'secret' });
        expect((await api.post('/internal/theia/v1/getRuntimeStatus', { 'x-cfs-ide-token': 'secret' })).status).toBe(401);
        expect((await api.post('/internal/ide/v2/getRuntimeStatus', { 'x-cfs-theia-token': 'secret' })).status).toBe(401);
        expect((await api.post('/internal/ide/v2/getRuntimeStatus', { 'x-cfs-ide-token': 'wrong' })).status).toBe(401);
        await api.close();
    });

    it('serves v2 alone on the neutral token, and v1 stays shut', async () => {
        const api = await serve({ STUDIO_IDE_CONTROL_TOKEN: 'neutral' });
        expect((await api.post('/internal/ide/v2/getRuntimeStatus', { 'x-cfs-ide-token': 'neutral' })).status).toBe(200);
        expect((await api.post('/internal/theia/v1/getRuntimeStatus', { 'x-cfs-theia-token': 'neutral' })).status).toBe(404);
        await api.close();
    });

    it('opens a file and a portal document through the browser clients', async () => {
        const opened: string[] = [];
        const api = await serve({ STUDIO_IDE_CONTROL_TOKEN: 't' }, opened);
        const file = await api.post('/internal/ide/v2/openInEditor', { 'x-cfs-ide-token': 't' }, { relativePath: 'docs/a.md' });
        expect(file.json).toEqual({ opened: true });
        const doc = await api.post('/internal/ide/v2/openDocument', { 'x-cfs-ide-token': 't' },
            { workspaceId: 'w1', documentId: 'd1', title: 'Spec', content: 'ignored' });
        expect(doc.json).toEqual({ opened: true });
        expect(opened).toEqual(['docs/a.md', 'doc:w1/d1']);
        await api.close();
    });
});
