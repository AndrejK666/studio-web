// The start pages of Development, Agent development and Full functionality.
//
// The empty main dock is product-ext's layer (welcome-view.js); Doc editing's
// page is its own. These three are registered into its page registry
// (start-page-hub.ts) as data it paints in the same look, because what they
// list is what this package reads: git through the desktop's own routes or
// Source Control, the editor history, Orca. Building's page is gearbox-studio's.
//
// Read when the page is shown, never in the background: the layer calls `load`
// when the dock empties in that mode, and again after a save while it is on
// screen. Every source may be missing -- a session has no desktop git, Orca may
// not be installed, the assistants are plugins a build may lack -- and each
// then says so in its own section; a button is drawn only for a command this
// build has (the layer checks, the ribbon's rules).
//
// Host by what the backend says (isDesktopHost), never by Electron: the same
// bundle runs in the portal's session (docs/desktop-contributing.md, rule 1).

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { ScmContribution } from '@theia/scm/lib/browser/scm-contribution';
import { NavigationLocationService } from '@theia/editor/lib/browser/navigation/navigation-location-service';
import URI from '@theia/core/lib/common/uri';
import { FULL_PERSPECTIVE_ID, ORCA_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID } from '../common/studio-modes';
import { OrcaService, type OrcaRepository, type OrcaRuntimeStatus, type OrcaWorktree } from '../common/orca-protocol';
import { samePath } from '../common/desktop-git';
import { desktopRepositories } from './desktop-git-client';
import { isDesktopHost } from './desktop-git-contribution';
import { OrcaContribution } from './orca-contribution';
import { MODES } from './studio-mode-bar';
import {
    registerStartPage, registerStartSection,
    type StartAction, type StartPage, type StartPageContext, type StartPageModel, type StartRow, type StartSection,
} from './start-page-hub';
import {
    agentsSection, desktopRepositoryRow, modeOverview, orcaRow, projectWorktrees, recentFileRows, repositoriesSection,
    scmRepositoryRow, worktreeRows, worktreesSection, type AssistantFacts, type ModePrimary,
} from './studio-start-pages-model';

/**
 * The assistants the product-ext rail opens (ai-context.js ASSISTANTS), through
 * the rail's own command: the plugins' open commands do not reveal a view
 * container that already exists. Disabled, with the reason, when the
 * assistant's extension is not in this build.
 */
const REVEAL_ASSISTANT = 'studio.assistant.reveal';
const ASSISTANTS: readonly AssistantFacts[] = [
    { label: 'Claude Code', command: REVEAL_ASSISTANT, args: ['claude'] },
    { label: 'Codex', command: REVEAL_ASSISTANT, args: ['codex'] },
];

/** Stands for "open the Agents panel" where a command id would go: the panel's own command toggles. */
const OPEN_ORCA = 'studio.start.open-orca';

/** Each mode's first thing to do, run after Full functionality switches to it. */
const PRIMARIES: Readonly<Record<string, ModePrimary>> = {
    docs: { label: 'New document', command: 'studio.document.new' },
    building: { label: 'Open Product', command: 'gearbox.product.open' },
    development: { label: 'Open file', command: 'file-search.openFile' },
    orca: { label: 'Agents', command: OPEN_ORCA },
};

/** How long a page waits for Orca before saying it did not answer. */
const ORCA_TIMEOUT_MS = 5000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms / 1000} s`)), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); },
        );
    });
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function modeFacts(role: string): { label: string; title: string } {
    const mode = MODES.find(m => m.role === role);
    return { label: mode?.label ?? role, title: mode?.title ?? '' };
}

@injectable()
export class StudioStartPages implements FrontendApplicationContribution {
    @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(ScmService) @optional() protected readonly scm: ScmService | undefined;
    @inject(ScmContribution) @optional() protected readonly scmView: ScmContribution | undefined;
    @inject(NavigationLocationService) @optional() protected readonly navigation: NavigationLocationService | undefined;
    @inject(OrcaService) @optional() protected readonly orca: OrcaService | undefined;
    @inject(OrcaContribution) @optional() protected readonly orcaView: OrcaContribution | undefined;
    @inject(PerspectiveService) @optional() protected readonly perspectives: PerspectiveService | undefined;

    protected readonly toDispose = new DisposableCollection();

    onStart(): void {
        this.toDispose.push(registerStartSection({
            id: 'development.repositories',
            title: 'Repositories',
            load: ctx => this.repositories(ctx),
        }));
        this.toDispose.push(registerStartPage(this.developmentPage()));
        this.toDispose.push(registerStartPage(this.agentPage()));
        this.toDispose.push(registerStartPage(this.fullPage()));
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    // -- Development ------------------------------------------------------------

    protected developmentPage(): StartPage {
        const { label, title } = modeFacts('development');
        return {
            id: 'studio.development',
            modes: [WORKBENCH_PERSPECTIVE_ID],
            label,
            summary: title,
            actions: [
                { id: 'open-file', label: 'Open file', command: 'file-search.openFile', title: 'Find a file in the project by its name' },
                { id: 'search', label: 'Search in files', command: 'search-in-workspace.open', title: 'Search the text of every file in the project' },
                { id: 'terminal', label: 'Terminal', command: 'workbench.action.terminal.toggleTerminal', title: 'Show the terminal, or open one' },
                { id: 'push', label: 'Push', command: 'studio.desktop.git:push', title: 'Push the branch to its remote, and open its pull request' },
                { id: 'sync', label: 'Sync', command: 'studio.workspace-sources:sync', title: 'Pull the repositories up to their remotes' },
            ],
            load: async ctx => ({
                sections: [
                    { ...await this.repositories(ctx), column: 0 },
                    { ...this.recentFiles(ctx), column: 1 },
                ],
            }),
            watch: reload => this.watchRepositories(reload),
        };
    }

    protected watchRepositories(reload: () => void): { dispose(): void } {
        const watching = new DisposableCollection();
        if (this.scm) {
            watching.push(this.scm.onDidAddRepository(() => reload()));
            watching.push(this.scm.onDidRemoveRepository(() => reload()));
        }
        return watching;
    }

    /** The project's clones: the desktop's git routes when this is a desktop, else Source Control. */
    protected async repositories(ctx: StartPageContext): Promise<StartSection> {
        const roots = this.workspace.tryGetRoots();
        if (!roots.length) {
            return repositoriesSection([], 'none', { hasProject: false });
        }
        let note: string | undefined;
        if (await isDesktopHost()) {
            try {
                const found = (await Promise.all(roots.map(root => desktopRepositories(root.resource.path.fsPath())))).flat();
                const rows = found.map(repository => ({ ...desktopRepositoryRow(repository), activate: () => this.showRepository(repository.path) }));
                return repositoriesSection(rows, 'desktop', { hasProject: true });
            } catch (error) {
                // Signed out or offline, the routes may refuse; Source Control still knows the clones.
                note = `Branch and remote state could not be read: ${reasonOf(error)}.`;
            }
        }
        const rootPaths = roots.map(root => root.resource.path.fsPath());
        const rows: StartRow[] = (this.scm?.repositories ?? []).map(repository => {
            const provider = repository.provider;
            const rootPath = new URI(provider.rootUri).path.fsPath();
            const changed = provider.groups.flatMap(group => group.resources.map(resource => resource.sourceUri.toString()));
            return {
                ...scmRepositoryRow({
                    rootPath,
                    label: provider.label,
                    statusTitles: (provider.statusBarCommands ?? []).map(command => command.title),
                    changed,
                }, rootPaths),
                activate: () => this.showRepository(rootPath),
            };
        });
        return repositoriesSection(rows, this.scm ? 'session' : 'none', { hasProject: true, note });
    }

    /** Source Control, on this repository. */
    protected async showRepository(path: string): Promise<void> {
        const repository = this.scm?.repositories.find(r => samePath(new URI(r.provider.rootUri).path.fsPath(), path));
        if (this.scm && repository) {
            this.scm.selectedRepository = repository;
        }
        if (this.scmView) {
            await this.scmView.openView({ activate: true, reveal: true });
        }
    }

    protected recentFiles(ctx: StartPageContext): StartSection {
        const roots = this.workspace.tryGetRoots().map(root => root.resource.toString());
        const uris = (this.navigation?.locations() ?? []).map(location => location.uri.toString());
        const rows = recentFileRows(uris, roots);
        return {
            id: 'development.recent-files',
            title: 'Recently opened',
            rows,
            empty: this.navigation
                ? 'No file opened in an editor yet. Open file finds one by its name.'
                : 'This build keeps no editor history.',
        };
    }

    // -- Agent development ------------------------------------------------------

    protected agentPage(): StartPage {
        const { label, title } = modeFacts('orca');
        return {
            id: 'studio.agents',
            modes: [ORCA_PERSPECTIVE_ID],
            label,
            summary: title,
            reloadOnFileChange: false,
            actions: this.agentActions(),
            load: ctx => this.loadAgents(ctx),
        };
    }

    protected agentActions(): StartAction[] {
        return [
            {
                id: 'agents', label: 'Agents', title: 'Coding agents, their worktrees and their terminals',
                activate: () => this.openOrca(),
                enabled: this.orcaView !== undefined,
                reason: 'this build has no Agents panel',
            },
            ...ASSISTANTS.map(assistant => ({
                id: `assistant-${String(assistant.args?.[0] ?? assistant.label)}`, label: assistant.label,
                command: assistant.command, args: assistant.args ? [...assistant.args] : undefined,
                title: `Open ${assistant.label} beside the project`,
            })),
            { id: 'changes', label: 'Changes', command: 'scmView:toggle', title: 'What the agents changed, and commit it' },
        ];
    }

    protected async openOrca(): Promise<void> {
        await this.orcaView?.openView({ activate: true, reveal: true });
    }

    protected async loadAgents(_ctx: StartPageContext): Promise<StartPageModel> {
        const assistants = ASSISTANTS.filter(assistant => !!this.commands.getCommand(assistant.command));
        if (!this.orca) {
            return { sections: [{ ...agentsSection(undefined, assistants), column: 0 }] };
        }
        let status: OrcaRuntimeStatus | undefined;
        let statusError: string | undefined;
        try {
            status = await within(this.orca.status(), ORCA_TIMEOUT_MS, 'Orca');
        } catch (error) {
            statusError = reasonOf(error);
        }
        let worktrees: OrcaWorktree[] = [];
        let elsewhere = 0;
        let worktreeError: string | undefined;
        if (status?.reachable) {
            try {
                const [all, repositories] = await Promise.all([
                    within(this.orca.listWorktrees(), ORCA_TIMEOUT_MS, 'Orca'),
                    within(this.orca.listRepositories(), ORCA_TIMEOUT_MS, 'Orca').catch(() => [] as OrcaRepository[]),
                ]);
                const root = this.workspace.tryGetRoots()[0]?.resource.path.fsPath();
                ({ worktrees, elsewhere } = projectWorktrees(all, repositories, root));
            } catch (error) {
                worktreeError = reasonOf(error);
            }
        }
        const rows = worktreeRows(worktrees, Date.now()).map(row => ({ ...row, activate: () => this.openOrca() }));
        return {
            sections: [
                {
                    ...agentsSection({ ...orcaRow(status, statusError), activate: this.orcaView ? () => this.openOrca() : undefined }, assistants),
                    column: 0,
                },
                { ...worktreesSection(rows, worktrees.length, { reachable: !!status?.reachable, error: worktreeError, elsewhere }), column: 1 },
            ],
        };
    }

    // -- Full functionality -----------------------------------------------------

    protected fullPage(): StartPage {
        const { label, title } = modeFacts('full');
        return {
            id: 'studio.full',
            modes: [FULL_PERSPECTIVE_ID],
            label,
            summary: title,
            actions: [
                { id: 'search', label: 'Search', command: 'studio.search.open', title: 'Search the project: documents, comments, proposed changes and history' },
                { id: 'open-file', label: 'Open file', command: 'file-search.openFile', title: 'Find a file in the project by its name' },
            ],
            load: async ctx => {
                const [documents, repositories] = await Promise.all([ctx.section('documents.recent'), this.repositories(ctx)]);
                const sections: StartSection[] = [{ ...this.modesSection(), column: 0 }];
                sections.push({ ...repositories, column: 0 });
                if (documents) {
                    sections.push({ ...documents, column: 1 });
                }
                return { sections };
            },
        };
    }

    /** Every other mode, with the one thing it starts with: the row switches and runs it. */
    protected modesSection(): StartSection {
        const rows: StartRow[] = modeOverview(MODES, PRIMARIES).map(mode => {
            const primary = mode.primary;
            const runnable = primary?.command === OPEN_ORCA ? this.orcaView !== undefined : !!primary?.command && !!this.commands.getCommand(primary.command);
            return {
                name: mode.label,
                detail: mode.title,
                tag: runnable ? primary?.label : undefined,
                title: runnable ? `Switch to ${mode.label} and ${primary?.label}` : `Switch to ${mode.label}`,
                activate: this.perspectives ? () => this.switchAndRun(mode.perspective, runnable ? primary?.command : undefined) : undefined,
            };
        });
        return { id: 'modes', title: 'Modes', rows };
    }

    protected async switchAndRun(perspective: string, command: string | undefined): Promise<void> {
        await this.perspectives?.switchPerspective(perspective);
        if (command === OPEN_ORCA) {
            await this.openOrca();
        } else if (command && this.commands.isEnabled(command)) {
            await this.commands.executeCommand(command);
        }
    }
}
