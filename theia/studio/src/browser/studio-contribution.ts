import { injectable, inject, optional } from '@theia/core/shared/inversify';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import type { FrontendApplication } from '@theia/core/lib/browser/frontend-application';
import { WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { OrcaService } from '../common/orca-protocol';
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
    /** Asked one question, once: is there a runtime for the Agents panel to be
     *  a panel of. Optional because this contribution composes a layout with or
     *  without an answer — see [`Self::agentsAreUsable`]. */
    @inject(OrcaService) @optional()
    protected readonly orca: OrcaService | undefined;

    constructor(
        @inject(WidgetManager) protected readonly widgetManager: WidgetManager
    ) {}

    async initializeLayout(app: FrontendApplication): Promise<void> {
        const agents = await this.agentsAreUsable();
        for (const placement of DEFAULT_LAYOUT) {
            if (placement.id === OrcaWidget.ID && !agents) {
                continue;
            }
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
        if (agents) {
            await app.shell.activateWidget(OrcaWidget.ID);
        }
    }

    /**
     * Whether a fresh session should open on the Agents panel.
     *
     * The release image is built without the Orca runtime — it arrives through
     * `--build-arg STUDIO_ORCA_DEB_URL=…`, and the deployed one does not carry
     * it — while the deployment still sets `STUDIO_ORCA_ENABLED=1`. Asked of a
     * live session on the dev stand rather than assumed: no `orca` on PATH, no
     * `orca serve` running, and the right flank expanded on a panel whose only
     * content is an explanation of why it has none.
     *
     * That is the same case the header above already keeps out of a fresh
     * session for the Workspace Graph and Object Details: a panel that can say
     * nothing is not worth the flank it opens. The difference is that this one
     * can say nothing only in SOME sessions, so it is decided per session
     * instead of in the list.
     *
     * The panel is not removed — it is one command away, like every other view
     * here, and the moment an image carries a runtime it opens by default
     * again.
     *
     * `cliMissing` and nothing weaker: a runtime that is merely not running is
     * one `orca serve` away, and the panel's own hint says so, which is worth
     * a flank. And a question that cannot be asked — no client bound, or a
     * transport that failed — is not evidence of absence, so the layout is
     * composed the way it was before this existed.
     */
    protected async agentsAreUsable(): Promise<boolean> {
        if (!this.orca) {
            return true;
        }
        try {
            return !(await this.orca.status()).cliMissing;
        } catch {
            return true;
        }
    }
}
