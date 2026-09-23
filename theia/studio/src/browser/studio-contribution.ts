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
 * How much of the window the right flank takes when a session first opens.
 *
 * Theia's own `initialSizeRatio` for that panel, used here because the framework
 * cannot apply it this early (see `initializeLayout`) — the number is the
 * default's, not a preference of this product's.
 */
const RIGHT_FLANK_RATIO = 0.191;

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
        //
        // The width has to be said out loud, BEFORE the activation that expands
        // the panel. Theia sizes a flank it is expanding for the first time from
        // `SidePanel.Options.initialSizeRatio`, but only through
        // `getDefaultPanelSize()`, which answers nothing unless the panel's
        // parent `isVisible` — and at this point in startup it is not, because
        // `revealShell` runs after every contribution's `initializeLayout`. So
        // the default never applied and Lumino's own stretch decided: measured
        // in a real session, 149px in a 1584px window, against the 302 the ratio
        // asks for. Five panels live in that flank — Agents, Claude Code, Codex,
        // AI Chat, Outline — and at 149px the one on top is a column of single
        // words, which is what "the IDE opens on a grey strip" turned out to be.
        //
        await app.shell.activateWidget(OrcaWidget.ID);
        this.sizeRightFlank(app);
    }

    /**
     * Give the right flank a width, once there is a layout to give it in.
     *
     * TWO EARLIER ATTEMPTS AT THIS DID NOTHING, and both looked right. Neither
     * the number nor the API was wrong — `rightPanelHandler.resize(303)` moves
     * the flank and the size sticks, confirmed against a running IDE. What was
     * wrong was the moment. `resize` writes `lastPanelSize` when the dock panel
     * is hidden and calls `setPanelSize` when it is not, and `setPanelSize`
     * "assumes that the parent of the panel container is a SplitPanel" — during
     * `initializeLayout` the shell is attached but not laid out, so neither
     * branch has anything to act on and the call is swallowed. Theia's own
     * default is lost to the same moment: `getDefaultPanelSize()` answers
     * nothing unless the panel's parent `isVisible`, and `revealShell` runs
     * after every contribution's `initializeLayout`.
     *
     * So this waits for the one condition that says the layout happened — the
     * shell has a width — and then says the size once. Bounded, because a
     * frame loop with no end is a leak: two seconds at 60fps is far more than
     * a reveal takes, and a session that somehow never lays out keeps the
     * flank Lumino gave it rather than spinning.
     *
     * It is only ever reached on a FRESH session. Theia calls
     * `initializeLayout` only when it has no saved layout to restore, so a
     * flank somebody dragged is never overruled.
     */
    protected sizeRightFlank(app: FrontendApplication): void {
        // Said on the frame the layout appears AND on a few frames after it.
        //
        // Not belt and braces: a swallowed `resize` reports nothing, and
        // `getPanelSize` is protected, so there is no way to ask whether it
        // landed. The shell having a width is the first moment it CAN land, and
        // the flank's own container can become ready a frame or two later than
        // the shell — so repeating briefly costs a handful of idempotent calls
        // and removes the guess. Nobody drags a panel in the first tenth of a
        // second of a session, which is the only thing this could overrule.
        let framesLeft = 120;
        let repeatsLeft = 6;
        const attempt = (): void => {
            const width = app.shell.node.clientWidth;
            if (width > 0) {
                app.shell.rightPanelHandler.resize(Math.round(width * RIGHT_FLANK_RATIO));
                if (--repeatsLeft <= 0) {
                    return;
                }
            } else if (--framesLeft <= 0) {
                return;
            }
            window.requestAnimationFrame(attempt);
        };
        window.requestAnimationFrame(attempt);
    }
}
