// The Extensions view in the code modes of the desktop app.
//
// MODE_TABS (studio-chrome-mode.ts) shows the Extensions tab in Workbench and
// Full, but a rule for a tab shows only a tab that is there. Nothing put it
// there: a mode's `viewPlacements` do not name it (a session has no such view,
// so naming it would warn in every session), Theia's own contribution adds it
// only to the very first layout, and switching to a mode with a saved layout
// detaches every side view that layout does not hold. So a fresh profile — and
// any whose saved Full layout was made before the view existed — had no
// Extensions tab at all.

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { FULL_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID } from '../common/studio-modes';

/** `VSXExtensionsViewContainer.ID` in `@theia/vsx-registry`, a dependency of electron-app only. */
export const EXTENSIONS_VIEW_CONTAINER_ID = 'vsx-extensions-view-container';
/** The modes that keep the Extensions tab, as MODE_TABS names them. */
export const EXTENSIONS_MODES: readonly string[] = [WORKBENCH_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID];

@injectable()
export class DesktopExtensionsPlacement implements FrontendApplicationContribution {

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(WidgetManager)
    protected readonly widgets!: WidgetManager;

    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    protected readonly toDispose = new DisposableCollection();

    onDidInitializeLayout(): void {
        if (!this.perspectives) {
            return;
        }
        this.toDispose.push(this.perspectives.onDidChangePerspective(() => void this.place()));
        void this.place();
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    /** Puts the Extensions view back on the left in a code mode, without opening it. */
    async place(): Promise<void> {
        const active = this.perspectives?.getActivePerspectiveId();
        if (!active || !EXTENSIONS_MODES.includes(active)) {
            return;
        }
        if (this.shell.getWidgets('left').some(widget => widget.id === EXTENSIONS_VIEW_CONTAINER_ID)) {
            return;
        }
        try {
            const widget = await this.widgets.getOrCreateWidget(EXTENSIONS_VIEW_CONTAINER_ID);
            // Theia's own default for the view (VSXExtensionsContribution): after
            // the explorer, search and source control.
            await this.shell.addWidget(widget, { area: 'left', rank: 500 });
        } catch (error) {
            console.warn('studio: could not place the Extensions view', error);
        }
    }
}
