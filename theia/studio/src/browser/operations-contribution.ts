import { injectable, inject } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { Command, CommandRegistry } from '@theia/core';
import { GitOperationsFrontendController } from './git-operations-contribution';
import { StudioRuntimeService } from '../common/studio-protocol';
import { AUDIT_FILTERS, OperationsWidget } from './operations-widget';

/*
 * The view contribution for the one Operations panel.
 *
 * It replaces two — `GitOperationsContribution` and `AuditContribution` — which
 * registered two toggles, two entries in the View menu and two bottom-panel
 * tabs for one subject: what became of a change. See operations-widget.tsx for
 * why that is one surface now, and why it is not called Git.
 *
 * The lifecycle duties come from the Git one: this contribution still binds the
 * runtime to the operations controller and forwards `onStart` and
 * `onDidInitializeLayout` to it. Those belong to the CONTROLLER's life, not the
 * panel's, and the controller did not merge with anything — it stayed where it
 * was, feeding the queue half.
 */

export const OperationsCommand: Command = {
    id: 'studio:operations:toggle',
    label: 'Operations'
};

/** One command per outcome, so the palette can open the panel already filtered. */
export const OperationsFilterCommandPrefix = 'studio:operations:filter:';

@injectable()
export class OperationsContribution extends AbstractViewContribution<OperationsWidget> implements FrontendApplicationContribution {
    constructor(
        @inject(GitOperationsFrontendController) protected readonly controller: GitOperationsFrontendController,
        @inject(StudioRuntimeService) runtime: StudioRuntimeService
    ) {
        super({
            widgetId: OperationsWidget.ID,
            widgetName: OperationsWidget.LABEL,
            defaultWidgetOptions: { area: 'bottom' },
            toggleCommandId: OperationsCommand.id
        });
        this.controller.bindRuntime(runtime);
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        for (const filter of AUDIT_FILTERS) {
            commands.registerCommand(
                { id: `${OperationsFilterCommandPrefix}${filter.id}`, label: `Operations: ${filter.label}` },
                {
                    execute: async () => {
                        // `activate: false` — a filter chosen from the palette
                        // reveals the panel without stealing focus from the
                        // editor the person is reading.
                        const widget = await this.openView({ activate: false, reveal: true });
                        widget.setFilter(filter.id);
                        return widget;
                    }
                }
            );
        }
    }

    async onStart(): Promise<void> {
        await this.controller.onStart();
    }

    onDidInitializeLayout(): void {
        this.controller.onDidInitializeLayout();
    }
}
