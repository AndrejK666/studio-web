// The mode you are in, where you can see it and click it.
//
// Theia registers the switch itself — `perspective.switch`, a quick-pick that
// appears once more than one perspective exists. But it registers it as a
// COMMAND, and this session has no menu bar (the product chrome removes it), so
// the only way to reach it is the command palette, under a label that says
// "Experimental". A mode nobody can find is not a mode.
//
// The status bar is where this belongs, and not only because it is visible:
// most of the time the useful thing is not switching but KNOWING — which
// workbench am I in, and why is this file opening in that editor. The control
// answers that first and switches second.

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';

const STATUS_ID = 'studio-workbench-mode';
/** Left of the editor's own entries, right of the workspace's. */
const STATUS_PRIORITY = 100;

@injectable()
export class StudioModeStatus implements FrontendApplicationContribution {

    @inject(StatusBar)
    protected readonly statusBar: StatusBar;

    // Optional for the same reason the open handler's is: an application built
    // without perspectives still works, it just has one mode and nothing to say
    // about it.
    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    protected readonly toDispose = new DisposableCollection();

    /**
     * After the layout, not during `onStart`: the active perspective is decided
     * by the restore, so anything rendered earlier would name the wrong mode
     * for a moment and then correct itself.
     */
    onDidInitializeLayout(): void {
        if (!this.perspectives) {
            return;
        }
        this.toDispose.push(this.perspectives.onDidChangePerspective(() => this.render()));
        void this.render();
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    protected async render(): Promise<void> {
        const perspectives = this.perspectives;
        if (!perspectives) {
            return;
        }
        // One mode is not a choice, and an indicator for it is noise.
        if (perspectives.getRegisteredPerspectives().length < 2) {
            await this.statusBar.removeElement(STATUS_ID);
            return;
        }
        const active = perspectives.getActivePerspective();
        await this.statusBar.setElement(STATUS_ID, {
            // `$(layout)` is a codicon; the label is the mode's own, so a mode
            // added later needs nothing here.
            text: `$(layout) ${active?.label ?? 'Workbench'}`,
            alignment: StatusBarAlignment.LEFT,
            priority: STATUS_PRIORITY,
            name: 'Workbench mode',
            tooltip: 'Workbench mode — click to switch',
            command: 'perspective.switch',
        });
    }
}
