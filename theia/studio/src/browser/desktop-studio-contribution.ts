// Opens the desktop Studio view on start — only in a desktop Studio, where the
// IDE backend says it is connected to one (ADR-0027). A session never shows it.

import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { DESKTOP_STUDIO_WIDGET_ID, DesktopStudioWidget, desktopStatus } from './desktop-studio-widget';

@injectable()
export class DesktopStudioContribution extends AbstractViewContribution<DesktopStudioWidget> implements FrontendApplicationContribution {
    constructor() {
        super({
            widgetId: DESKTOP_STUDIO_WIDGET_ID,
            widgetName: 'Constructor Studio',
            defaultWidgetOptions: { area: 'left', rank: 50 },
            toggleCommandId: 'studio.desktop.toggle',
        });
    }

    async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
        if ((await desktopStatus())?.enabled) {
            await this.openView({ activate: true, reveal: true });
        }
    }
}
