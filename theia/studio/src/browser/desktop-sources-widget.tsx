// The Sources view on the desktop: the open project's clones, not the
// session's canonical workspace config.
//
// A session's Sources edits `.cf-studio` TOML, which the desktop does not
// have: a desktop project's repositories are the ones its settings in Studio
// list, cloned into the folder when the project is opened. The session's view
// said "Missing canonical config" there and offered Create Config and Edit Raw
// TOML, neither of which means anything for that folder. This one lists the
// clones as git sees them, with Sync and Push, and says where the list comes
// from. Bound by the desktop's frontend module only; with no Studio configured
// it is the session's view.

import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import type { Message } from '@theia/core/lib/browser/widgets/widget';
import { repositoryLine, type DesktopGitRepository } from '../common/desktop-git';
import { desktopRepositories } from './desktop-git-client';
import { DesktopWorkspaceSourcesController, isDesktopHost, openFolders } from './desktop-git-contribution';
import { WorkspaceSourcesWidget } from './workspace-sources-widget';

interface Folder {
    readonly root: string;
    readonly repositories?: readonly DesktopGitRepository[];
    readonly error?: string;
}

@injectable()
export class DesktopSourcesWidget extends WorkspaceSourcesWidget {
    /** `undefined` until the backend answered whether this is a desktop. */
    protected desktop: boolean | undefined;
    protected folders: readonly Folder[] = [];
    protected loading = false;

    @inject(WorkspaceService)
    protected readonly workspace!: WorkspaceService;

    // Not decorated again: the parent's `@postConstruct` calls this override.
    protected override init(): void {
        super.init();
        void isDesktopHost().then(desktop => {
            this.desktop = desktop;
            if (desktop) {
                void this.reload();
            }
            this.update();
        });
        // A sync or a push changed what git says; read it again.
        this.toDispose.push(this.controller.onDidChange(() => {
            if (this.desktop && !this.loading && !this.desktopController.isSyncing()) {
                void this.reload();
            }
        }));
    }

    protected get desktopController(): DesktopWorkspaceSourcesController {
        return this.controller as DesktopWorkspaceSourcesController;
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        if (this.desktop) {
            void this.reload();
        }
    }

    protected async reload(): Promise<void> {
        this.loading = true;
        this.update();
        try {
            this.folders = await Promise.all(openFolders(this.workspace).map(async root => {
                try {
                    return { root, repositories: await desktopRepositories(root) };
                } catch (error) {
                    return { root, error: error instanceof Error ? error.message : String(error) };
                }
            }));
        } finally {
            this.loading = false;
            this.update();
        }
    }

    protected override render(): React.ReactNode {
        if (this.desktop === undefined) {
            return <div className="studio-workspace-sources"><div className="studio-workspace-sources__meta">Loading…</div></div>;
        }
        if (!this.desktop) {
            return super.render();
        }
        const syncing = this.desktopController.isSyncing();
        const clones = this.folders.flatMap(folder => (folder.repositories ?? []).map(repository => ({ root: folder.root, repository })));
        return (
            <div className="studio-workspace-sources" data-testid="desktop-sources">
                <div className="studio-workspace-sources__header">
                    <div>
                        <div className="studio-workspace-sources__eyebrow">Sources</div>
                        <h3>The project's repositories</h3>
                    </div>
                    <div className="studio-workspace-sources__inline-actions">
                        <button type="button" className="theia-button secondary" disabled={this.loading} onClick={() => void this.reload()}>Refresh</button>
                        <button type="button" className="theia-button" disabled={syncing || clones.length === 0}
                            title="Fetch every repository, and fast-forward the ones that only need it"
                            onClick={() => void this.desktopController.syncClones()}>
                            {syncing ? 'Syncing…' : 'Sync'}
                        </button>
                    </div>
                </div>
                <div className="studio-workspace-sources__meta">
                    The repositories are the ones set in the project's settings in Studio (the portal's project page);
                    this folder holds their clones. A repository added there is cloned the next time the project is opened
                    from the Constructor Studio view.
                </div>
                {this.folders.filter(folder => folder.error).map(folder => (
                    <div key={folder.root} className="studio-workspace-sources__reason">{folder.root}: {folder.error}</div>
                ))}
                {clones.length === 0 && !this.loading
                    ? <div className="studio-workspace-sources__panel" data-testid="desktop-sources-empty">
                        No repository in this folder. Open a project from the Constructor Studio view to clone its sources here.
                    </div>
                    : <div className="studio-workspace-sources__list">
                        {clones.map(({ root, repository }) => (
                            <div key={repository.path} className="studio-workspace-sources__row" data-testid="desktop-source-row">
                                <div className="studio-workspace-sources__row-top">
                                    <strong>{repository.name}</strong>
                                    <button type="button" className="theia-button secondary"
                                        disabled={!repository.branch}
                                        title={`Push ${repository.branch ?? ''} to its remote`}
                                        onClick={() => void this.desktopController.pushClone(root, repository.path)}>
                                        Push
                                    </button>
                                </div>
                                <div className="studio-workspace-sources__meta">{repositoryLine(repository)}</div>
                                {repository.remote && <div className="studio-workspace-sources__meta">{repository.remote}</div>}
                            </div>
                        ))}
                    </div>}
            </div>
        );
    }
}
