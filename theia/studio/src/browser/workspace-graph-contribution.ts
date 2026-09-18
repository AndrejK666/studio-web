import { injectable, inject } from '@theia/core/shared/inversify';
import { AbstractViewContribution, type OpenViewArguments } from '@theia/core/lib/browser';
import { Command, CommandRegistry, MenuModelRegistry } from '@theia/core';
import { CommonMenus } from '@theia/core/lib/browser/common-menus';
import { WorkspaceGraphWidget } from './workspace-graph-widget';
import { ObjectDetailsWidget } from './object-details-widget';
import { WorkspaceGraphFrontendController } from './workspace-graph-widget';
import { WorkspaceGraphService } from '../common/graph-model';

export const WorkspaceGraphCommand: Command = { id: 'studio.workspace-graph:toggle' };
export const ObjectDetailsCommand: Command = { id: 'studio.object-details:toggle' };

@injectable()
export class WorkspaceGraphContribution extends AbstractViewContribution<WorkspaceGraphWidget> {
    constructor(
        @inject(WorkspaceGraphFrontendController) controller: WorkspaceGraphFrontendController,
        @inject(WorkspaceGraphService) graphService: WorkspaceGraphService
    ) {
        super({
            widgetId: WorkspaceGraphWidget.ID,
            widgetName: WorkspaceGraphWidget.LABEL,
            defaultWidgetOptions: { area: 'main' },
            toggleCommandId: WorkspaceGraphCommand.id
        });
        controller.bindGraphService(graphService);
    }

    // No `onStart`. There was one, and it called `openView` — which overrides
    // `activate` to true — so every session that ever registered this class as
    // a FrontendApplicationContribution opened on the graph instead of on the
    // file the person came for. It was never registered as one, so the code was
    // dead and read as a promise the product does not make. The graph is a view
    // you ask for; the command and the View menu are how you ask.

    registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand(ObjectDetailsCommand, {
            execute: async () => {
                await this.shell.addWidget(await this.widgetManager.getOrCreateWidget(ObjectDetailsWidget.ID), { area: 'right' });
                await this.shell.activateWidget(ObjectDetailsWidget.ID);
            }
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
            commandId: ObjectDetailsCommand.id,
            label: ObjectDetailsWidget.LABEL
        });
    }

    override async openView(args: Partial<OpenViewArguments> = {}): Promise<WorkspaceGraphWidget> {
        const widget = await super.openView({ ...args, activate: true, reveal: true });
        const detailsWidget = await this.widgetManager.getOrCreateWidget(ObjectDetailsWidget.ID);
        if (!detailsWidget.isAttached) {
            await this.shell.addWidget(detailsWidget, { area: 'right' });
        }
        return widget;
    }
}
