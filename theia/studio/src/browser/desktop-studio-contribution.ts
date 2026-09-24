// Opens the desktop Studio view on start — only in a desktop Studio, where the
// IDE backend says it is connected to one (ADR-0027). A session never shows it.

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { DESKTOP_STUDIO_WIDGET_ID, DesktopStudioWidget, desktopStatus } from './desktop-studio-widget';

@injectable()
export class DesktopStudioContribution extends AbstractViewContribution<DesktopStudioWidget> implements FrontendApplicationContribution {
    @inject(FrontendApplicationStateService)
    protected readonly appState: FrontendApplicationStateService;

    constructor() {
        super({
            widgetId: DESKTOP_STUDIO_WIDGET_ID,
            widgetName: 'Constructor Studio',
            defaultWidgetOptions: { area: 'left', rank: 50 },
            toggleCommandId: 'studio.desktop.toggle',
        });
    }

    onStart(): void {
        // Not onDidInitializeLayout: that runs only for a fresh layout, and
        // every later start restores the last one, where some other view may
        // be in front. The member's Studio is what a desktop opens on.
        void this.appState.reachedState('ready').then(async () => {
            if ((await desktopStatus())?.enabled) {
                await this.openView({ activate: true, reveal: true });
            }
        });
    }
}
