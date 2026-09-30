// The rail is one toolset, the same in every mode; a mode adds its own views
// beside it, never on it.
//
// A perspective says where its views go (`viewPlacements`), but Theia applies
// that only on a mode's FIRST visit in a window. Every later visit restores the
// layout the mode was left in and detaches every side view that layout lacks
// (`PerspectiveServiceImpl.doSwitchPerspective` → `detachStrayWidgets`). So
// what a mode showed depended on the order it was visited in, measured on
// desktop 0.3.0-beta.5:
//
//   - Agent development had no file tree and no search at all;
//   - Full had Source Control on the left when it was visited first, and on the
//     right — tabless, 100px wide — when Agent development came before it;
//   - Building had Source Control only when some earlier mode had left it there;
//   - a view opened once in a mode (the Gearbox Catalogue in Doc editing) stayed
//     in that mode's saved layout for good.
//
// And the rail CSS (RAIL_TABS in studio-chrome-mode.ts) can only show a tab
// that is there. #542 patched one view (Extensions) in one host (the desktop);
// #552 made it the same repair for every view a mode named, in both hosts; and
// the modes then named different rails, so the rail itself changed with every
// switch. Now there is one rail (RAIL below) and every mode keeps it.
//
// WHAT IT DOES, on startup and after every switch, for the mode now active:
//
//   1. PLACES each rail view, and each side view the mode's perspective
//      declares, that is not in its side area — without activating it, so
//      nothing expands and nothing takes the focus a switch has just given to
//      the mode's primary view.
//   2. DETACHES, the way Theia does (`parent = null`, never `close`/`dispose`,
//      so another mode can still restore it), each side view that ANOTHER mode
//      declares and this one does not. The rail is every mode's, so it is never
//      detached: switching modes never adds or removes a rail item.
//
// WHAT "ALLOWED" MEANS, which is the part to read twice. A view is claimed by a
// mode when the mode names it: the RAIL, which every mode names, or the side
// entries of its perspective's `viewPlacements`. Only claimed views are ever detached, and
// only from modes that do not claim them. A view no mode claims — the Studio
// view, Claude and Codex, Theia's AI chat, Object Details beside the graph, a
// plugin's own view — is never touched: where it goes is the person's choice,
// kept by Theia's saved layout exactly as before. That is also why this does
// not fight anyone: a view somebody opens from the View menu stays for as long
// as they work in the mode, and is only set aside the next time the mode is
// entered, if it belongs to a different one.

import { inject, injectable, named, optional } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { WidgetFactory, WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { DisposableCollection } from '@theia/core/lib/common/disposable';

export type SideArea = 'left' | 'right';

/** One view kept on a side of the window: on the rail, or beside it for a mode. */
export interface ModeView {
    readonly id: string;
    readonly area: SideArea;
    /** Theia's own rank for the view, so a placed tab lands where Theia would put it. */
    readonly rank?: number;
}

/** Theia's view containers, as their packages name them, with their own default ranks. */
export const EXPLORER: ModeView = { id: 'explorer-view-container', area: 'left', rank: 100 };
export const SEARCH: ModeView = { id: 'search-view-container', area: 'left', rank: 200 };
export const SOURCE_CONTROL: ModeView = { id: 'scm-view-container', area: 'left', rank: 300 };
export const DEBUG: ModeView = { id: 'debug', area: 'left', rank: 400 };
/**
 * `VSXExtensionsViewContainer.ID`. `@theia/vsx-registry` is a dependency of
 * electron-app only: a session has no factory for it, and a view without a
 * factory in this application is skipped without a word.
 */
export const EXTENSIONS: ModeView = { id: 'vsx-extensions-view-container', area: 'left', rank: 500 };
export const TESTING: ModeView = { id: 'test-view-container', area: 'left', rank: 600 };

/**
 * THE rail: one toolset, the same in every mode, in VS Code's order.
 *
 * It was a table per mode (MODE_VIEWS), and it read as clutter rather than as
 * a choice: going from Development to Doc editing took Search, Run and Debug,
 * Testing and Extensions away and put a second, different search and a
 * Comments button in their place, so the column a hand learns by position moved
 * under it with every switch. VS Code's activity bar does not change with the
 * kind of work, and neither does this one now. What a mode changes is its
 * ribbon and its start page; the rail belongs to the workbench.
 *
 * The order is Theia's own ranks, which are VS Code's: Explorer, Search, Source
 * Control, Run and Debug, Extensions (a desktop's only), Testing. The product's
 * own rail controls follow — Collaboration, Quality when a project turns it on,
 * the one Assistants entry (product-ext's rail-nav.js) — and the Studio view,
 * the account and the connection, sits at the foot, where VS Code keeps
 * Accounts.
 *
 * One search: Theia's, which searches code and text across the files, and
 * which Ctrl+Shift+F opens in every mode. The product's Search, which also
 * reads comments, proposed changes and history, is the ribbon's Find in Doc
 * editing and Full functionality, and "Studio: Search" in the palette.
 *
 * A perspective may still name a rail view in its `viewPlacements`, even on
 * the other side; the rail wins, because a rail item that moves or vanishes
 * with the mode is exactly what this replaced.
 *
 * Outline is deliberately absent. It lives on the right, where the product
 * hides Theia's tab bar: placing it unopened would add a tab nobody can see,
 * and View > Outline opens it — at a readable width now — whenever it is wanted.
 */
export const RAIL: readonly ModeView[] = [EXPLORER, SEARCH, SOURCE_CONTROL, DEBUG, EXTENSIONS, TESTING];

/**
 * Views a mode places on the LEFT for its own work, drawn with no rail tab.
 *
 * The rail is common, so a mode's own view cannot be an item on it: it would
 * appear and vanish with the mode, which is what the common rail stops. Such a
 * view is reached from its mode's ribbon instead, and still opens in the side
 * panel, because a side panel is the only place Theia holds it:
 *
 *   - the Gearbox Catalogue: Building's ribbon, Corpus > Catalogue
 *     (`gearbox.catalogue.browse`), and View > Catalogue.
 *
 * Orca is not here because it is never on the left: every mode that has it
 * keeps it on the right, whose tab bar the product hides, and the ribbon's
 * Agents opens it.
 */
export const OFF_RAIL: readonly string[] = ['gearbox.catalogue'];

/** Never detached, even if a mode ever names them: the Studio view and the assistants. */
export const ALWAYS_KEPT: ReadonlySet<string> = new Set([
    'studio.desktop',
    'plugin-view-container:workbench.view.extension.claude-sidebar-secondary',
    'plugin-view-container:workbench.view.extension.codexSecondaryViewContainer',
]);

/**
 * The Studio view, in every mode, once it exists, at the FOOT of the rail.
 *
 * The foot because it is the account and the connection, which is where VS
 * Code keeps Accounts: a rank after every rail view makes it the last tab, and
 * the rail's stylesheet (studio-chrome-mode.ts) pushes it down to the bottom
 * whatever rank a saved layout gave it. It is added when the desktop backend
 * answers (DesktopStudioContribution), which can be after the first mode's
 * layout was taken: measured on a fresh profile, leaving Development in the
 * first seconds saved a layout without it, and Theia's restore then detached it
 * from Development for good. It is only put back when it was detached, never
 * created: a session, which has no Studio view, never makes one, and one the
 * member closed is disposed, not detached.
 */
export const STUDIO_VIEW: ModeView = { id: 'studio.desktop', area: 'left', rank: 10000 };

/** Just enough of a perspective descriptor for this file. */
export interface ModeDescriptor {
    readonly id: string;
    readonly viewPlacements: ReadonlyMap<string, string>;
}

/**
 * What a mode keeps on its rails: the common RAIL first, then the side entries
 * of its own `viewPlacements` that the rail does not already name.
 */
export function declaredViews(descriptor: ModeDescriptor | undefined, rail: readonly ModeView[] = RAIL): ModeView[] {
    const views = [...rail];
    for (const [id, area] of descriptor?.viewPlacements ?? []) {
        if ((area === 'left' || area === 'right') && !views.some(view => view.id === id)) {
            views.push({ id, area });
        }
    }
    return views;
}

/**
 * The side views another mode claims and `mode` does not: the ones to set
 * aside on entering it. Every mode claims the rail, so a rail view is never
 * among them — only a mode's own views (Orca, the Catalogue, the Inspector)
 * come and go.
 */
export function claimedElsewhere(mode: string, descriptors: readonly ModeDescriptor[], rail: readonly ModeView[] = RAIL): Set<string> {
    const own = new Set(declaredViews(descriptors.find(d => d.id === mode), rail).map(view => view.id));
    const others = new Set<string>();
    for (const other of descriptors) {
        if (other.id === mode) {
            continue;
        }
        for (const view of declaredViews(other, rail)) {
            if (!own.has(view.id) && !ALWAYS_KEPT.has(view.id)) {
                others.add(view.id);
            }
        }
    }
    return others;
}

@injectable()
export class StudioModeLayout implements FrontendApplicationContribution {

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(WidgetManager)
    protected readonly widgets!: WidgetManager;

    @inject(ContributionProvider) @named(WidgetFactory)
    protected readonly factories!: ContributionProvider<WidgetFactory>;

    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    protected readonly toDispose = new DisposableCollection();
    /** One pass at a time, in switch order: a quick second switch waits for the first. */
    protected pending: Promise<void> = Promise.resolve();

    onDidInitializeLayout(): void {
        if (!this.perspectives) {
            return;
        }
        this.toDispose.push(this.perspectives.onDidChangePerspective(() => void this.enqueue()));
        void this.enqueue();
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    protected enqueue(): Promise<void> {
        this.pending = this.pending.then(() => this.apply()).catch(error => {
            console.warn('studio: could not arrange the rails for this mode', error);
        });
        return this.pending;
    }

    /** Places what the active mode declares, then sets aside what belongs to another mode. */
    async apply(): Promise<void> {
        const mode = this.perspectives?.getActivePerspectiveId();
        if (!mode || !this.perspectives) {
            return;
        }
        const descriptors = this.perspectives.getRegisteredPerspectives();
        const studio = this.widgets.tryGetWidget(STUDIO_VIEW.id);
        if (studio && !studio.isAttached && !studio.isDisposed) {
            await this.shell.addWidget(studio, { area: STUDIO_VIEW.area, rank: STUDIO_VIEW.rank });
        }
        for (const view of declaredViews(descriptors.find(d => d.id === mode))) {
            await this.place(view);
        }
        await this.orderRail();
        const foreign = claimedElsewhere(mode, descriptors);
        for (const area of ['left', 'right'] as const) {
            for (const widget of this.shell.getWidgets(area)) {
                if (foreign.has(widget.id)) {
                    // A side tab bar selects the previous tab when its current
                    // one goes, which would bring forward whatever sat beside it
                    // (an assistant, say) with nobody having asked. Fold the
                    // panel first, so it simply closes.
                    if (this.shell.getCurrentWidget(area) === widget) {
                        await this.shell.collapsePanel(area);
                    }
                    // As Theia's own detachStrayWidgets: out of this layout, not
                    // disposed — the mode that declares it restores it.
                    // eslint-disable-next-line no-null/no-null
                    widget.parent = null;
                }
            }
        }
    }

    /** Puts one view in its area, unopened, unless it is already there. */
    protected async place(view: ModeView): Promise<void> {
        if (!this.hasFactory(view.id)) {
            return;
        }
        const existing = this.widgets.tryGetWidget(view.id);
        if (existing?.isAttached) {
            const area = this.shell.getAreaFor(existing);
            // Where it should be, or somewhere the shell does not track as a
            // top-level view (the file navigator inside the explorer's
            // container): either way it is not ours to move.
            if (area === view.area || area === undefined) {
                return;
            }
        }
        const widget = existing ?? await this.widgets.getOrCreateWidget(view.id);
        await this.shell.addWidget(widget, { area: view.area, rank: view.rank });
    }

    /**
     * Puts the rail's tabs back in the rail's order, if something else ordered them.
     *
     * Theia applies a perspective's `viewPlacements` on its first visit without
     * a rank, so a rail view a perspective names lands wherever the tab bar
     * puts an unranked tab: measured on a fresh desktop profile, Agent
     * development's Source Control went above Search, and Full, visited next,
     * kept that order. Only when the order is wrong: re-adding a tab moves it,
     * and the panel's open view is revealed again afterwards, unfocused.
     */
    protected async orderRail(): Promise<void> {
        const rank = new Map(RAIL.map(view => [view.id, view.rank ?? 0]));
        const onRail = this.shell.getWidgets('left').filter(widget => rank.has(widget.id));
        const sorted = [...onRail].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
        if (onRail.every((widget, index) => widget === sorted[index])) {
            return;
        }
        const current = this.shell.getCurrentWidget('left');
        for (const widget of onRail) {
            // eslint-disable-next-line no-null/no-null
            widget.parent = null;
        }
        for (const widget of sorted) {
            await this.shell.addWidget(widget, { area: 'left', rank: rank.get(widget.id) });
        }
        if (current && onRail.includes(current)) {
            await this.shell.revealWidget(current.id);
        }
    }

    /** Whether this application can make the view at all (a session has no Extensions view). */
    protected hasFactory(id: string): boolean {
        return this.factories.getContributions().some(factory => factory.id === id);
    }
}
