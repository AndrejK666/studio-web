import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpenVsxBootstrap, OpenVsxInstaller } from './desktop-open-vsx';

const CLAUDE = { id: 'anthropic.claude-code', label: 'Claude Code' };
const CODEX = { id: 'openai.chatgpt', label: 'Codex' };

describe('open-vsx bootstrap', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-open-vsx-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Theia's plugin server, as far as the bootstrap sees it: install adds `id@<version>`. */
    function fakeServer(initial: string[] = [], fail?: string): OpenVsxInstaller & { installs: string[]; list: string[] } {
        const server = {
            installs: [] as string[],
            list: [...initial],
            installed: async () => server.list,
            install: async (id: string) => {
                server.installs.push(id);
                if (id === fail) {
                    throw new Error('getaddrinfo ENOTFOUND open-vsx.org');
                }
                server.list.push(`${id}@9.9.9`);
            },
        };
        return server;
    }

    function bootstrap(installer: OpenVsxInstaller): OpenVsxBootstrap {
        return new OpenVsxBootstrap({
            assistants: [CLAUDE, CODEX],
            installer,
            markerFile: path.join(dir, '.open-vsx-installed.json'),
            pluginsDir: dir,
            log: () => undefined,
        });
    }

    it('installs each one from open-vsx once, and reports the version it got', async () => {
        const server = fakeServer();
        const it = bootstrap(server);

        await it.ensure();
        await it.ensure();

        expect(server.installs).toEqual([CLAUDE.id, CODEX.id]);
        expect(it.status().map(s => [s.id, s.state, s.version])).toEqual([
            [CLAUDE.id, 'ready', '9.9.9'],
            [CODEX.id, 'ready', '9.9.9'],
        ]);
    });

    it('leaves one the member already has, at whatever version', async () => {
        const server = fakeServer(['anthropic.claude-code@2.1.284']);

        await bootstrap(server).ensure();

        expect(server.installs).toEqual([CODEX.id]);
    });

    it('does not install again what the member removed', async () => {
        const server = fakeServer();
        await bootstrap(server).ensure();
        server.list = server.list.filter(id => !id.startsWith(CLAUDE.id));

        const next = bootstrap(server);
        await next.ensure();

        expect(server.installs).toEqual([CLAUDE.id, CODEX.id]);
        expect(next.status().map(s => s.id)).toEqual([CODEX.id]);
    });

    it('says what failed and tries again on retry', async () => {
        const server = fakeServer([], CODEX.id);
        const it = bootstrap(server);

        await it.ensure();
        const failed = it.status().find(s => s.id === CODEX.id)!;
        expect(failed.state).toBe('failed');
        expect(failed.error).toContain('ENOTFOUND open-vsx.org');
        expect(failed.error).toContain('Extensions view');

        await it.ensure();
        expect(server.installs.filter(id => id === CODEX.id)).toHaveLength(1);
        await it.retry(CODEX.id);
        expect(server.installs.filter(id => id === CODEX.id)).toHaveLength(2);
    });

    it('removes the copies a pinning build unpacked, once the member has their own', async () => {
        fs.mkdirSync(path.join(dir, 'anthropic.claude-code-2.1.227', 'anthropic.claude-code'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'constructorfabric.studio-cli-1.6.2-ca55c66.3'), { recursive: true });

        await bootstrap(fakeServer()).ensure();

        expect(fs.readdirSync(dir).sort()).toEqual(['.open-vsx-installed.json', 'constructorfabric.studio-cli-1.6.2-ca55c66.3']);
    });
});
