import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DesktopKitsContribution } from './desktop-kits';
import { repositoryIdentity } from './repository-registry';

/** The contribution with its collaborators replaced: a Studio that records requests, an installer, git. */
function harness(installFails?: string) {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    const installs: Array<{ kitSlug: string; version: string; repositoryId: string; label: string }> = [];
    const contribution = new DesktopKitsContribution();
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-desktop-kits-')));
    fs.mkdirSync(path.join(root, '.git'));
    Object.assign(contribution, {
        desktop: {
            isEnabled: () => true,
            openedProject: () => 'project-1',
            studioFetch: async (gearPath: string, init: RequestInit = {}) => {
                calls.push({ path: gearPath, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
                return { ok: true, status: 200, json: async () => ({ kit_slug: 'sdlc', status: installFails ? 'failed' : 'installed' }), text: async () => '' };
            },
        },
        kitInstaller: {
            installInto: async (request: { kitSlug: string; version: string }, target: { repositoryId: string; label: string }) => {
                installs.push({ ...request, repositoryId: target.repositoryId, label: target.label });
                if (installFails) {
                    throw new Error(installFails);
                }
                return { output: 'kit installed' };
            },
        },
        git: { revParseGitCommonDir: async (cwd: string) => path.join(cwd, '.git') },
    });
    return { contribution, calls, installs, root };
}

describe('desktop kits', () => {
    it('records the request, installs into the open checkout and reports it under the session\'s repository id', async () => {
        const { contribution, calls, installs, root } = harness();

        const answer = await (contribution as unknown as {
            install(projectId: string, root: string, kitSlug: string, version: string): Promise<{ output?: string; error?: string }>;
        }).install('project-1', root, 'sdlc', 'v1.2.3');

        const repositoryId = repositoryIdentity(root, fs.realpathSync.native(path.join(root, '.git')));
        expect(installs).toEqual([{ kitSlug: 'sdlc', version: 'v1.2.3', repositoryId, label: path.basename(root) }]);
        expect(calls).toEqual([
            {
                path: '/studio-kits/v1/projects/project-1/installations',
                method: 'POST',
                body: { kit_slug: 'sdlc', version: 'v1.2.3', install_mode: 'copy' },
            },
            {
                path: '/studio-kits/v1/projects/project-1/installations/sdlc/materializations',
                method: 'POST',
                body: { repository_id: repositoryId, repository_label: path.basename(root), status: 'installed' },
            },
        ]);
        expect(answer).toMatchObject({ output: 'kit installed', error: undefined });
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('reports a failed install as failed, with its reason, and still answers', async () => {
        const { contribution, calls, root } = harness('cfs kit install failed: stdout: no network');

        const answer = await (contribution as unknown as {
            install(projectId: string, root: string, kitSlug: string, version: string): Promise<{ error?: string }>;
        }).install('project-1', root, 'sdlc', 'main');

        expect(calls[1].body).toMatchObject({ status: 'failed', failure_reason: 'cfs kit install failed: stdout: no network' });
        expect(answer.error).toBe('cfs kit install failed: stdout: no network');
        fs.rmSync(root, { recursive: true, force: true });
    });
});
