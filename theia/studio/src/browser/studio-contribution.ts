import { injectable, inject } from '@theia/core/shared/inversify';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import type { FrontendApplication } from '@theia/core/lib/browser/frontend-application';
import { WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { OperationsWidget } from './operations-widget';
import { AnalyzeWidget } from './analyze-widget';
import { OrcaWidget } from './orca-widget';

/** Where the Studio views go in the normal workbench.
 *
 *  Exported because it is now two things at once: what a fresh session lays
 *  out, and the "Workbench" perspective's placement map. Writing it twice is
 *  how the two would drift apart.
 *
 *  What is deliberately NOT here is as much of the design as what is:
 *
 *  - The Workspace Graph. It used to be the main area's occupant and the widget
 *    activated last, so every session opened on a picture of itself — in front
 *    of the file the person came for. It is a view you ask for, and it is one
 *    command away.
 *  - Object Details, which reads the graph's selection and can say nothing
 *    without it. Kept out of a fresh session it stops being an empty panel in
 *    the right flank; `WorkspaceGraphContribution.openView` attaches it the
 *    moment the graph opens, which is the only moment it has anything to show.
 *  - The sample widget the Theia extension generator left behind. It shipped in
 *    the left flank of every session, opened by default, offering a button that
 *    congratulated the reader on its own creation. */
export const DEFAULT_LAYOUT: ReadonlyArray<{ id: string; area: 'left' | 'main' | 'right' | 'bottom' }> = [
    { id: OrcaWidget.ID, area: 'right' },
    { id: OperationsWidget.ID, area: 'bottom' },
    { id: AnalyzeWidget.ID, area: 'bottom' }
] as const;

/**
 * Composes the layout a fresh session opens on.
 *
 * Not a view contribution any more: it used to be the sample widget's, and the
 * layout rode along on it. With the sample gone the layout is the whole job, so
 * the class says so rather than carrying a toggle command for a view that no
 * longer exists.
 */
@injectable()
export class StudioContribution implements FrontendApplicationContribution {
    constructor(
        @inject(WidgetManager) protected readonly widgetManager: WidgetManager
    ) {}

    async initializeLayout(app: FrontendApplication): Promise<void> {
        for (const placement of DEFAULT_LAYOUT) {
            const widget = await this.widgetManager.getOrCreateWidget(placement.id);
            if (widget.isAttached) {
                continue;
            }
            await app.shell.addWidget(widget, { area: placement.area });
        }
        // Adding a widget to a side area only puts it in that area's tab bar;
        // the panel stays collapsed until something activates it, which is how
        // the Agents panel came out invisible on a fresh session. Activating it
        // is what expands the right panel.
        await app.shell.activateWidget(OrcaWidget.ID);
    }
}
