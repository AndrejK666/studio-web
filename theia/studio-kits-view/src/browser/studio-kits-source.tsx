import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter } from '@theia/core/lib/common/event';
import { MessageService } from '@theia/core/lib/common/message-service';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { TreeElement } from '@theia/core/lib/browser/source-tree';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ExtensionsSourceContribution, SearchResult } from '@theia/vsx-registry/lib/browser/extensions-source-contribution';
import { ExtensionCard } from '@theia/vsx-registry/lib/browser/extension-card';
import { TypeBadge } from '@theia/vsx-registry/lib/browser/type-badge';
import { KitCatalogEntry, KitInstallationRow, KitState, StudioKitsClient, kitState, shortVersion } from './studio-kits-client';

/**
 * Studio kits as one more kind of entry in the desktop's Extensions view,
 * beside the extensions from open-vsx: the kits the open project has under
 * Installed, the rest of the catalogue under Recommended, all of them in a
 * search (or `@kit` alone).
 *
 * A kit belongs to the project, not to the app: Install records it for the
 * project and puts it into the checkout open in this window
 * (`/studio-desktop/kits/install`), so the portal shows it as installed too.
 * A folder not opened from Studio has no project; its kits show, but cannot
 * be installed from here.
 */
@injectable()
export class StudioKitsSource implements ExtensionsSourceContribution {
    readonly type = 'studio-kit';
    readonly displayName = 'Studio Kits';
    readonly searchToken = '@kit';
    readonly priority = 10;

    @inject(WorkspaceService)
    protected readonly workspace: WorkspaceService;

    @inject(MessageService)
    protected readonly messages: MessageService;

    protected readonly client = new StudioKitsClient();
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    protected root: string | undefined;
    protected projectId: string | undefined;
    protected catalogue: KitCatalogEntry[] = [];
    protected installations = new Map<string, KitInstallationRow>();
    protected readonly busy = new Set<string>();
    protected loading: Promise<void> | undefined;

    @postConstruct()
    protected init(): void {
        this.workspace.onWorkspaceChanged(() => { void this.refresh(); });
    }

    refresh(): Promise<void> {
        this.loading = this.load().finally(() => this.onDidChangeEmitter.fire());
        return this.loading;
    }

    resolveInstalled(): Iterable<TreeElement> {
        this.ensureLoaded();
        return this.catalogue.filter(kit => this.installations.has(kit.slug)).map(kit => this.element(kit));
    }

    resolveRecommended(): Iterable<TreeElement> {
        this.ensureLoaded();
        return this.projectId ? this.catalogue.filter(kit => !this.installations.has(kit.slug)).map(kit => this.element(kit)) : [];
    }

    resolveSearchResults(): Iterable<SearchResult> {
        this.ensureLoaded();
        return this.catalogue.map(kit => ({
            element: this.element(kit),
            searchableText: [kit.name, kit.slug, kit.description, kit.publisher, 'kit studio'].join(' '),
        }));
    }

    protected ensureLoaded(): void {
        if (!this.loading) {
            void this.refresh();
        }
    }

    protected async load(): Promise<void> {
        this.root = this.workspace.tryGetRoots()[0]?.resource.path.fsPath();
        try {
            this.catalogue = await this.client.catalog();
            this.projectId = this.root ? await this.client.project(this.root) : undefined;
            const rows = this.projectId ? await this.client.installations(this.projectId) : [];
            this.installations = new Map(rows.map(row => [row.kit_slug, row]));
        } catch (error) {
            // Signed out, or the Studio unreachable: no kits rather than an error in a list.
            console.warn('[studio-kits] kits unavailable', error);
            this.catalogue = [];
            this.installations = new Map();
        }
    }

    protected element(kit: KitCatalogEntry): TreeElement {
        return {
            id: `studio-kit:${kit.slug}`,
            render: () => this.renderCard(kit, kitState(this.installations.get(kit.slug), this.busy.has(kit.slug))),
        };
    }

    protected renderCard(kit: KitCatalogEntry, state: KitState): React.ReactNode {
        const version = state.kind === 'installed' || state.kind === 'requested' ? state.version : kit.default_version;
        return <ExtensionCard
            title={kit.name}
            version={shortVersion(version)}
            description={state.kind === 'failed' ? `Install failed: ${state.reason}` : kit.description}
            icon={<i className={codicon('package')} />}
            typeBadge={<TypeBadge icon={<i className={codicon('library')} />} label='Kit' variant='kit' title='A Studio kit: templates, rules and skills for the project' />}
            publisher={kit.publisher}
            publisherTitle={kit.repository_url}
            trust={kit.publisher.toLowerCase().includes('constructor') ? 'verified' : 'unknown'}
            actions={this.renderActions(kit, state)}
        />;
    }

    protected renderActions(kit: KitCatalogEntry, state: KitState): React.ReactNode {
        const noProject = !this.projectId || !this.root;
        const title = noProject ? 'Open this project from the Constructor Studio view to install kits into it' : undefined;
        switch (state.kind) {
            case 'busy':
                return <button className='theia-button action prominent theia-mod-disabled'>Installing</button>;
            case 'installed':
                return <button className='theia-button action' title='The project stops wanting this kit; its files stay in the checkout'
                    onClick={() => this.remove(kit)}>Remove</button>;
            case 'failed':
            case 'requested':
                return <>
                    <button className='theia-button prominent action' disabled={noProject} title={title}
                        onClick={() => this.install(kit, state.kind === 'requested' ? state.version : kit.default_version)}>
                        {state.kind === 'failed' ? 'Retry' : 'Install here'}
                    </button>
                    <button className='theia-button action' onClick={() => this.remove(kit)}>Remove</button>
                </>;
            default:
                return <button className='theia-button prominent action' disabled={noProject} title={title}
                    onClick={() => this.install(kit, kit.default_version)}>Install</button>;
        }
    }

    protected async install(kit: KitCatalogEntry, version: string): Promise<void> {
        if (!this.root || this.busy.has(kit.slug)) {
            return;
        }
        this.busy.add(kit.slug);
        this.onDidChangeEmitter.fire();
        try {
            const answer = await this.client.install(this.root, kit.slug, version);
            if (answer.error) {
                this.messages.error(`${kit.name} could not be installed: ${answer.error}`);
            } else {
                this.messages.info(`${kit.name} is installed in this project. Commit the new files to share it.`);
            }
        } catch (error) {
            this.messages.error(`${kit.name} could not be installed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.busy.delete(kit.slug);
            await this.refresh();
        }
    }

    protected async remove(kit: KitCatalogEntry): Promise<void> {
        if (!this.projectId) {
            return;
        }
        try {
            await this.client.remove(this.projectId, kit.slug);
        } catch (error) {
            this.messages.error(`${kit.name} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await this.refresh();
    }
}
