import 'reflect-metadata';
jest.mock('inversify', () => {
    const actual = jest.requireActual('inversify');
    return {
        ...actual,
        inject: () => () => undefined,
        injectable: () => <T>(target: T): T => target,
        named: () => () => undefined
    };
});
jest.mock('perfect-scrollbar', () => ({
    __esModule: true,
    default: class {
        update(): void {}
        destroy(): void {}
    }
}));
jest.mock('@theia/core/lib/browser/shell/view-contribution', () => ({
    AbstractViewContribution: class<T> {
        constructor(protected readonly options: { toggleCommandId?: string; widgetId: string; widgetName: string; defaultWidgetOptions: { area: string } }) {}
        async openView(): Promise<T> {
            return { id: this.options.widgetId } as T;
        }
        registerCommands(commands: { registerCommand: (command: { id: string }) => unknown }): void {
            if (this.options.toggleCommandId) {
                commands.registerCommand({ id: this.options.toggleCommandId });
            }
        }
        registerMenus(menus: { registerMenuAction: (path: readonly string[], item: { commandId: string }) => void }): void {
            if (this.options.toggleCommandId) {
                const { CommonMenus } = require('@theia/core/lib/browser/common-menus');
                menus.registerMenuAction(CommonMenus.VIEW_VIEWS, { commandId: this.options.toggleCommandId });
            }
        }
    }
}));
jest.mock('@theia/core/lib/browser/shell/application-shell', () => ({
    ApplicationShell: Symbol('ApplicationShell')
}));
jest.mock('@theia/core/lib/browser/shell/shell-layout-restorer', () => ({
    ShellLayoutRestorer: Symbol('ShellLayoutRestorer'),
    ApplicationShellLayoutMigrationError: { is: () => false }
}));
jest.mock('./workspace-graph-widget', () => ({
    WorkspaceGraphWidget: { ID: 'studio:workspace-graph', LABEL: 'Workspace Graph' }
}));
jest.mock('./object-details-widget', () => ({
    ObjectDetailsWidget: { ID: 'studio:object-details', LABEL: 'Object Details' }
}));

jest.mock('./analyze-widget', () => ({
    AnalyzeWidget: { ID: 'studio:analyze', LABEL: 'Analyze' }
}));
jest.mock('./operations-widget', () => ({
    OperationsWidget: { ID: 'studio:operations', LABEL: 'Operations' },
    AUDIT_FILTERS: []
}));
jest.mock('./orca-widget', () => ({
    ORCA_WIDGET_ID: 'studio.orca',
    OrcaWidget: { ID: 'studio.orca', LABEL: 'Agents (Orca)' }
}));
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { CommonMenus } from '@theia/core/lib/browser/common-menus';
import { FrontendApplication } from '@theia/core/lib/browser/frontend-application';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { OperationsCommand, OperationsContribution } from './operations-contribution';
import { StudioContribution } from './studio-contribution';
import { WorkspaceGraphWidget } from './workspace-graph-widget';
import { ObjectDetailsWidget } from './object-details-widget';
import { AnalyzeWidget } from './analyze-widget';
import { OperationsWidget } from './operations-widget';
import { OrcaWidget } from './orca-widget';

describe('StudioContribution', () => {
    it('initializes the default layout only through initializeLayout', async () => {
        const widgets = new Map([
            [WorkspaceGraphWidget.ID, { id: WorkspaceGraphWidget.ID, isAttached: false }],
            [ObjectDetailsWidget.ID, { id: ObjectDetailsWidget.ID, isAttached: false }],
            [OperationsWidget.ID, { id: OperationsWidget.ID, isAttached: false }],
            [AnalyzeWidget.ID, { id: AnalyzeWidget.ID, isAttached: false }],
            [OrcaWidget.ID, { id: OrcaWidget.ID, isAttached: false }]
        ]);
        const widgetManager = {
            getOrCreateWidget: jest.fn(async (id: string) => widgets.get(id))
        };
        const shell = {
            addWidget: jest.fn(async (widget: { isAttached: boolean }, _options: unknown) => {
                widget.isAttached = true;
            }),
            activateWidget: jest.fn()
        };
        const contribution = new StudioContribution(widgetManager as never);

        await contribution.initializeLayout({ shell } as never);

        // Three, not four: the Git Operations panel and the Audit panel were
        // one subject in two tabs — what became of a change — and are one
        // Operations panel now.
        expect(shell.addWidget).toHaveBeenCalledTimes(3);
        expect(shell.addWidget).toHaveBeenCalledWith(
            expect.objectContaining({ id: OperationsWidget.ID }),
            { area: 'bottom' }
        );
        expect(shell.addWidget).toHaveBeenCalledWith(
            expect.objectContaining({ id: OrcaWidget.ID }),
            { area: 'right' }
        );
        // Object Details reads the graph's selection and can say nothing
        // without it. It arrives with the graph, not with the session.
        expect(shell.addWidget).not.toHaveBeenCalledWith(
            expect.objectContaining({ id: ObjectDetailsWidget.ID }),
            expect.anything()
        );
        // The Agents panel is revealed by activating it — adding a widget to a
        // side area only puts it in that area's tab bar.
        expect(shell.activateWidget.mock.calls.map(([id]: [string]) => id))
            .toEqual([OrcaWidget.ID]);
        // The graph is no longer part of what a session opens on: it used to
        // occupy the main area and be activated last, so every session opened
        // on a picture of itself, in front of the file the person came for.
        expect(shell.addWidget).not.toHaveBeenCalledWith(
            expect.objectContaining({ id: WorkspaceGraphWidget.ID }),
            expect.anything()
        );
    });

    it('does not compose the default layout when Theia restores a saved layout', async () => {
        const contribution = new StudioContribution({ getOrCreateWidget: jest.fn() } as never);
        const initializeLayout = jest.spyOn(contribution, 'initializeLayout');
        const application = new TestFrontendApplication(
            async () => true,
            [contribution],
            { pendingUpdates: Promise.resolve() }
        );

        await application.runInitializeLayout();

        expect(initializeLayout).not.toHaveBeenCalled();
    });

    it('composes the default layout when Theia has no saved layout', async () => {
        const contribution = new StudioContribution({
            getOrCreateWidget: jest.fn(async (id: string) => ({ id, isAttached: false }))
        } as never);
        const shell = {
            addWidget: jest.fn(async (widget: { isAttached: boolean }) => {
                widget.isAttached = true;
            }),
            activateWidget: jest.fn(),
            pendingUpdates: Promise.resolve()
        };
        const application = new TestFrontendApplication(
            async () => false,
            [contribution],
            shell
        );

        await application.runInitializeLayout();

        expect(shell.addWidget).toHaveBeenCalledTimes(3);
        expect(shell.activateWidget).toHaveBeenCalledWith(OrcaWidget.ID);
        expect(shell.activateWidget).not.toHaveBeenCalledWith(WorkspaceGraphWidget.ID);
    });

    it('contributes no view of its own', () => {
        // It used to be the sample widget's view contribution, with the layout
        // riding along on it. The sample is gone; a toggle command for a view
        // that no longer exists would be a menu entry that opens nothing.
        const contribution = new StudioContribution({ getOrCreateWidget: jest.fn() } as never);

        expect((contribution as unknown as { registerCommands?: unknown }).registerCommands)
            .toBeUndefined();
        expect((contribution as unknown as { registerMenus?: unknown }).registerMenus)
            .toBeUndefined();
    });

    /* One toggle and one View entry, where there used to be two of each: the
     * Git Operations panel and the Audit panel registered separately for one
     * subject. */
    it('registers exactly one Operations toggle command and one View menu entry', () => {
        const commands = createRecordingCommandRegistry();
        const menus = new RecordingMenuRegistry();
        const contribution = new OperationsContribution(
            { bindRuntime: jest.fn() } as never,
            {} as never
        );

        contribution.registerCommands(commands as never);
        contribution.registerMenus(menus as never);

        expect(commands.getCommand(OperationsCommand.id)).toMatchObject({ id: OperationsCommand.id });
        expect(menus.actionsFor(CommonMenus.VIEW_VIEWS, OperationsCommand.id)).toHaveLength(1);
    });

    it('uses Theia theme variables and focus-visible rules in the stylesheet', () => {
        const cssPath = path.resolve(__dirname, 'style/index.css');
        const css = fs.readFileSync(cssPath, 'utf8');

        expect(css).toContain('var(--theia-focusBorder)');
        expect(css).toContain('var(--theia-editorWidget-background)');
        expect(css).toContain('.studio-audit__filter:focus-visible');
        expect(css).toContain('.studio-status-badge--blocked');
        expect(css).toContain('.studio-status-badge--pending');
    });
});

class TestFrontendApplication extends FrontendApplication {
    constructor(
        restoreLayout: () => Promise<boolean>,
        contributions: FrontendApplicationContribution[],
        shell: { pendingUpdates: Promise<void> }
    ) {
        super(
            {} as never,
            {} as never,
            {} as never,
            { restoreLayout } as never,
            { getContributions: () => contributions } as never,
            shell as never,
            {} as never
        );
    }

    async runInitializeLayout(): Promise<void> {
        await this.initializeLayout();
    }

    protected override async measureContribution<T>(
        _contribution: FrontendApplicationContribution,
        _hook: string,
        fn: () => T | PromiseLike<T>
    ): Promise<T> {
        return fn();
    }
}

class RecordingMenuRegistry {
    protected readonly actions: Array<{ path: readonly string[]; commandId: string }> = [];

    registerMenuAction(path: readonly string[], item: { commandId: string }): void {
        this.actions.push({ path, commandId: item.commandId });
    }

    actionsFor(path: readonly string[], commandId: string): Array<{ path: readonly string[]; commandId: string }> {
        return this.actions.filter(action => samePath(action.path, path) && action.commandId === commandId);
    }
}

function createRecordingCommandRegistry(): Pick<CommandRegistry, 'registerCommand' | 'getCommand'> {
    const commands = new Map<string, { id: string }>();
    return {
        registerCommand(command: { id: string }) {
            commands.set(command.id, command);
            return { dispose() {} };
        },
        getCommand(id: string): { id: string } | undefined {
            return commands.get(id);
        }
    };
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
