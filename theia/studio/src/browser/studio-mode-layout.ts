// A mode's rails are what the mode declares.
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
// And the rail CSS (MODE_TABS in studio-chrome-mode.ts) can only show a tab
// that is there. #542 patched one view (Extensions) in one host (the desktop);
// this is the same repair for every view a mode names, in both hosts.
//
// WHAT IT DOES, on startup and after every switch, for the mode now active:
//
//   1. PLACES each view the mode declares that is not in its declared side
//      area — without activating it, so nothing expands and nothing takes the
//      focus a switch has just given to the mode's primary view.
//   2. DETACHES, the way Theia does (`parent = null`, never `close`/`dispose`,
//      so another mode can still restore it), each side view that ANOTHER mode
//      declares and this one does not.
//
// WHAT "ALLOWED" MEANS, which is the part to read twice. A view is claimed by a
// mode when the mode names it: in MODE_VIEWS below, or in the side entries of
// its perspective's `viewPlacements`. Only claimed views are ever detached, and
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
import {
    BUILDING_PERSPECTIVE_ID, DOCUMENTS_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID, ORCA_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID
} from '../common/studio-modes';

export type SideArea = 'left' | 'right';

/** One view a mode keeps on a rail. */
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

/** The rails of the modes for working on code. */
const CODE_RAILS: readonly ModeView[] = [EXPLORER, SEARCH, SOURCE_CONTROL, DEBUG, EXTENSIONS, TESTING];

/**
 * THE table: what each mode keeps on its rails, beyond its perspective's own
 * `viewPlacements`. The rail CSS (MODE_TABS) is derived from it, so the tab a
 * mode shows and the view the mode is guaranteed to have cannot drift apart.
 *
 * Outline is deliberately absent. It lives on the right, where the product
 * hides Theia's tab bar: placing it unopened would add a tab nobody can see,
 * and View > Outline opens it — at a readable width now — whenever it is wanted.
 */
export const MODE_VIEWS: Readonly<Record<string, readonly ModeView[]>> = {
    // Writing: the documents are files, found by browsing. Finding them by
    // their text is the product's own Search, which also reads comments,
    // proposed changes and history; Theia's file search beside it would be a
    // second, lesser search.
    [DOCUMENTS_PERSPECTIVE_ID]: [EXPLORER],
    // Development and Full: the file tree, Theia's search across files (code is
    // found by its text), Source Control, Run and Debug, Testing, and the
    // Extensions view where the application has one.
    [WORKBENCH_PERSPECTIVE_ID]: CODE_RAILS,
    [FULL_PERSPECTIVE_ID]: CODE_RAILS,
    // Agent development: the agents are on the left and what they changed on
    // the right (studio-perspectives.ts); the files they work in were missing.
    [ORCA_PERSPECTIVE_ID]: [EXPLORER, SEARCH],
    // Building: a product's sources are files, and the change a Generate makes
    // is committed from Source Control.
    [BUILDING_PERSPECTIVE_ID]: [EXPLORER, SOURCE_CONTROL],
};

/** Never detached, even if a mode ever names them: the Studio view and the assistants. */
export const ALWAYS_KEPT: ReadonlySet<string> = new Set([
    'studio.desktop',
    'plugin-view-container:workbench.view.extension.claude-sidebar-secondary',
    'plugin-view-container:workbench.view.extension.codexSecondaryViewContainer',
]);

/** Just enough of a perspective descriptor for this file. */
export interface ModeDescriptor {
    readonly id: string;
    readonly viewPlacements: ReadonlyMap<string, string>;
}

/**
 * What a mode keeps on its rails: MODE_VIEWS first, then the side entries of
 * its own `viewPlacements` that MODE_VIEWS does not already name.
 */
export function declaredViews(mode: string, descriptor: ModeDescriptor | undefined, table = MODE_VIEWS): ModeView[] {
    const views = [...(table[mode] ?? [])];
    for (const [id, area] of descriptor?.viewPlacements ?? []) {
        if ((area === 'left' || area === 'right') && !views.some(view => view.id === id)) {
            views.push({ id, area });
        }
    }
    return views;
}

/** The side views another mode claims and `mode` does not: the ones to set aside on entering it. */
export function claimedElsewhere(mode: string, descriptors: readonly ModeDescriptor[], table = MODE_VIEWS): Set<string> {
    const own = new Set(declaredViews(mode, descriptors.find(d => d.id === mode), table).map(view => view.id));
    const modes = new Set([...Object.keys(table), ...descriptors.map(d => d.id)]);
    const others = new Set<string>();
    for (const other of modes) {
        if (other === mode) {
            continue;
        }
        for (const view of declaredViews(other, descriptors.find(d => d.id === other), table)) {
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
        for (const view of declaredViews(mode, descriptors.find(d => d.id === mode))) {
            await this.place(view);
        }
        const foreign = claimedElsewhere(mode, descriptors);
        for (const area of ['left', 'right'] as const) {
            for (const widget of this.shell.getWidgets(area)) {
                if (foreign.has(widget.id)) {
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

    /** Whether this application can make the view at all (a session has no Extensions view). */
    protected hasFactory(id: string): boolean {
        return this.factories.getContributions().some(factory => factory.id === id);
    }
}
