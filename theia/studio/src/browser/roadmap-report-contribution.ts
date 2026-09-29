import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution, type OpenViewArguments } from '@theia/core/lib/browser';
import { Command } from '@theia/core';
import { RoadmapReportWidget } from './roadmap-report-widget';

export const RoadmapReportCommand: Command = {
    id: 'studio.roadmap-report:toggle',
    label: 'Studio: Roadmap Report',
};

/**
 * Opens the roadmap report in the main area: from the Building ribbon's
 * Corpus group, the View menu, or the command palette.
 */
@injectable()
export class RoadmapReportContribution extends AbstractViewContribution<RoadmapReportWidget> {
    constructor() {
        super({
            widgetId: RoadmapReportWidget.ID,
            widgetName: RoadmapReportWidget.LABEL,
            defaultWidgetOptions: { area: 'main' },
            toggleCommandId: RoadmapReportCommand.id,
        });
    }

    override async openView(args: Partial<OpenViewArguments> = {}): Promise<RoadmapReportWidget> {
        return super.openView({ ...args, activate: true, reveal: true });
    }
}
