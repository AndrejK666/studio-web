import * as fs from 'fs/promises';
import * as path from 'path';
import * as express from '@theia/core/shared/express';
import { inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { DesktopStudioContribution } from './desktop-studio-contribution';
import { GitExecutor } from './git-executor';
import { KitInstallerImpl, KitTargetRepository } from './kit-installer';
import { repositoryIdentity } from './repository-registry';

/** What `/studio-desktop/kits/install` answers: the project's installation, as the backend now records it. */
export interface DesktopKitInstallAnswer {
    readonly installation?: unknown;
    readonly output?: string;
    readonly error?: string;
}

/**
 * Studio kits on a desktop, installed from the Extensions view's Kits part.
 *
 * In a session the portal asks the backend, which calls the session's IDE
 * over its bridge (`materialize`). A desktop has no such bridge (ADR-0027):
 * the backend cannot call it. So the desktop does the three steps itself, for
 * the folder open in the window:
 *
 * 1. records the desired state (`POST …/installations`, as the portal does);
 * 2. installs the kit into that checkout with its own `cfs` (`KitInstallerImpl`);
 * 3. reports how it went (`POST …/installations/{kit}/materializations`), so
 *    the portal shows the same row a session's install would leave.
 *
 * The repository id is the one a session's registry would give that checkout
 * (`repositoryIdentity`), so a desktop and a session installing into the same
 * repository update one row.
 *
 * Mounted only on a desktop (`isEnabled`); a folder not opened from Studio has
 * no project to record against and is answered 404, as `/opened` is.
 */
@injectable()
export class DesktopKitsContribution implements BackendApplicationContribution {
    @inject(DesktopStudioContribution)
    protected readonly desktop: DesktopStudioContribution;

    @inject(KitInstallerImpl)
    protected readonly kitInstaller: KitInstallerImpl;

    @inject(GitExecutor)
    protected readonly git: GitExecutor;

    configure(app: express.Application): void {
        if (!this.desktop.isEnabled()) {
            return;
        }
        app.post('/studio-desktop/kits/install', express.json(), async (req, res) => {
            const body = (req.body ?? {}) as { root?: unknown; kitSlug?: unknown; version?: unknown };
            const root = typeof body.root === 'string' ? body.root : '';
            const kitSlug = typeof body.kitSlug === 'string' ? body.kitSlug.trim().toLowerCase() : '';
            const version = typeof body.version === 'string' ? body.version.trim() : '';
            if (!root || !kitSlug || !version) {
                res.status(400).json({ error: 'root, kitSlug and version are required' });
                return;
            }
            const projectId = this.desktop.openedProject(root);
            if (!projectId) {
                res.status(404).json({ error: 'this folder was not opened from Studio' });
                return;
            }
            try {
                res.json(await this.install(projectId, root, kitSlug, version));
            } catch (error) {
                res.status(502).json({ error: error instanceof Error ? error.message : String(error) } satisfies DesktopKitInstallAnswer);
            }
        });
    }

    protected async install(projectId: string, root: string, kitSlug: string, version: string): Promise<DesktopKitInstallAnswer> {
        const project = encodeURIComponent(projectId);
        const kit = encodeURIComponent(kitSlug);
        await this.expectOk(await this.desktop.studioFetch(`/studio-kits/v1/projects/${project}/installations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kit_slug: kitSlug, version, install_mode: 'copy' }),
        }), 'the kit could not be requested');

        const target = await this.target(root);
        let output: string | undefined;
        let failure: string | undefined;
        try {
            output = (await this.kitInstaller.installInto({ kitSlug, version }, target)).output;
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        }

        const reported = await this.desktop.studioFetch(`/studio-kits/v1/projects/${project}/installations/${kit}/materializations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repository_id: target.repositoryId,
                repository_label: target.label,
                status: failure ? 'failed' : 'installed',
                ...(failure ? { failure_reason: failure } : {}),
            }),
        });
        await this.expectOk(reported, failure ? `the install failed (${failure}), and reporting it` : 'the kit is installed, but reporting it');
        return { installation: await reported.json(), output, error: failure };
    }

    /** The checkout the window shows, named as a session's repository registry would name it. */
    protected async target(root: string): Promise<KitTargetRepository> {
        const canonicalRoot = await fs.realpath(root);
        const commonDirectory = await fs.realpath(await this.git.revParseGitCommonDir(canonicalRoot));
        return {
            repositoryId: repositoryIdentity(canonicalRoot, commonDirectory),
            label: path.basename(canonicalRoot),
            canonicalRoot,
        };
    }

    protected async expectOk(answer: Response, what: string): Promise<void> {
        if (answer.ok) {
            return;
        }
        const detail = await answer.text().catch(() => '');
        throw new Error(`${what}: Studio answered ${answer.status}${detail ? ` (${detail.slice(0, 300)})` : ''}`);
    }
}
