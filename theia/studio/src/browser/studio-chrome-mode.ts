// Chrome that belongs to the mode rather than to the application.
//
// The session's menu bar was removed application-wide, and for a reason that
// was true at the time: the product chrome hides its contents with CSS, Lumino
// still allocated its height, and the result was a blank band across the top of
// every session. Hiding it properly fixed the band and took File, Edit and
// Terminal with it — from the workbench as well, where a programmer expects
// them and where they are not replaced by anything.
//
// Both halves of that were application-wide decisions about something that is
// not application-wide. The menu bar is chrome, and which chrome you want is
// exactly what a mode says:
//
//   Workbench  — Theia's own menu bar, and its application icon.
//   Documents  — the same menu bar, beside the one line that says who else is
//                in this project, and no second application icon above the
//                portal's own.
//
// WHY DOCUMENTS KEEPS THE ROW NOW. The band is the reason the panel was taken
// out of the layout, and the band was an argument about an EMPTY row. It is not
// empty any more: `product-ext`'s collaboration strip mounts into this panel
// (`area: 'top'`), and it is the only surface that states, while you are
// reading something else, that a colleague is in the next file or that a thread
// now mentions you. Measured on the dev stand before this change: the strip was
// constructed, mounted and repainting on every heartbeat inside a panel that
// `window.menuBarVisibility: 'hidden'` had removed from the layout, so nobody
// ever saw a collaborator — the panel's own `setHidden(false)` in
// `mountCollabStrip` runs at startup and the perspective overrides it after.
//
// So Documents pays the 32px and gets the line. And once the row is paid for,
// taking File, Edit and Terminal out of it buys nothing back: the height is
// spent either way, the menu is what a person reaches for when they want a
// terminal in the project they are reading, and the strip asks for
// `flex: 1 1 auto`, so it takes whatever the menu leaves and sits at the
// window's edge — which is the arrangement it was measured in. The one thing
// Documents does drop is Theia's application icon, because the portal's own
// branding is directly above it and two are one too many.
//
// A mode has two levers because two systems decide. `window.menuBarVisibility`
// is what Theia acts on — it is the only thing that takes the panel out of the
// LAYOUT (ApplicationShell.setTopPanelVisibility → Lumino setHidden), so it
// says `classic` in both modes and the panel stays. The stylesheet below is
// what PAINTS: it takes the row back out of the product's blanket
// `#theia-top-panel { display: none !important }`.
//
// BOTH LEVERS ARE LOAD-BEARING FOR THE STRIP, and neither says so where it is
// read. `studio-chrome-mode.test.ts` asserts them together, in both modes, for
// that reason: a strip nobody can see costs a heartbeat every four seconds and
// reports nothing, and the failure is silent — it was shipped that way.

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { PreferenceScope, PreferenceService } from '@theia/core/lib/common';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { DOCUMENTS_PERSPECTIVE_ID } from '../common/studio-modes';
import { OFF_RAIL, RAIL, STUDIO_VIEW } from './studio-mode-layout';

const STYLE_ID = 'studio-chrome-mode';

/**
 * Wins over `#theia-top-panel { display: none !important }` on specificity —
 * (0,2,1) against (0,1,0) — so the order the two stylesheets are injected in
 * does not decide who is right.
 */
const CHROME_CSS = `
body[data-studio-mode="documents"] #theia-top-panel,
body[data-studio-mode="workbench"] #theia-top-panel { display: flex !important; }
/* Documents keeps the row and the menu in it, and drops only Theia's own
   application icon — the portal's branding is the line above. A hidden flex
   child takes no width, so nothing shifts. */
body[data-studio-mode="documents"] #theia-top-panel > .theia-icon { display: none !important; }
/* The rail's tabs are one list for every mode (RAIL_TABS, from RAIL in
   studio-mode-layout.ts), written by railTabsCss below — not a rule per mode. */
/* Writing's bottom panel is Analyze. The Problems list, Operations and a
   terminal the session started are still there, one menu away, but their tabs
   show only while one of them is the tab in front, so opening findings does
   not put a shell beside the paragraph. */
body[data-studio-perspective="studio.documents"] #theia-bottom-content-panel .lm-TabBar-tab:not(.lm-mod-current):not([id="shell-tab-studio:analyze"]) { display: none !important; }
`;

/**
 * The rail's tabs, the same in every mode.
 *
 * The product hides Theia's view containers wholesale (product-ext's "chrome
 * removal"), so the rail shows only what is named here. RAIL
 * (studio-mode-layout.ts) is the one list, and it also guarantees each view is
 * on the rail — a rule for a tab shows only a tab that is there. This is its
 * left-hand half: the right-hand tab bar is hidden in every mode, so no rule
 * there could show anything.
 */
export const RAIL_TABS: readonly string[] = RAIL.filter(view => view.area === 'left').map(view => view.id);

/** A tab by its view id, which may hold a dot (`gearbox.catalogue`) an id selector would misread. */
function railTab(id: string): string {
    return `#theia-left-content-panel .lm-TabBar-tab[id="shell-tab-${id}"]`;
}

/**
 * The rail's stylesheet, from the one declaration:
 *
 *   - the RAIL's tabs shown, the grid display being Theia's own for a rail tab —
 *     (1,2,0), over the product's `#shell-tab-… { display: none }` at (1,0,0);
 *   - a mode's own left-hand views (OFF_RAIL) drawn without a tab: their ribbon
 *     opens them, and a tab there would come and go with the mode;
 *   - the Studio view at the rail's foot, where VS Code keeps Accounts. The tab
 *     list is a flex column as tall as the rail, so `margin-top: auto` on its
 *     last item is the foot; `order` makes it the last item whatever rank a
 *     layout saved before this change gave it.
 */
export function railTabsCss(tabs: readonly string[] = RAIL_TABS, offRail: readonly string[] = OFF_RAIL, foot: string = STUDIO_VIEW.id): string {
    const rules: string[] = [];
    if (tabs.length > 0) {
        rules.push(tabs.map(railTab).join(',\n') + ' { display: grid !important; }');
    }
    if (offRail.length > 0) {
        rules.push(offRail.map(railTab).join(',\n') + ' { display: none !important; }');
    }
    rules.push(`${railTab(foot)} { order: 1; margin-top: auto !important; }`);
    return rules.join('\n');
}

@injectable()
export class StudioChromeMode implements FrontendApplicationContribution {

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    protected readonly toDispose = new DisposableCollection();

    onDidInitializeLayout(): void {
        if (!this.perspectives) {
            return;
        }
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CHROME_CSS + railTabsCss();
        document.head.appendChild(style);
        this.toDispose.push({ dispose: () => style.remove() });

        this.toDispose.push(this.perspectives.onDidChangePerspective(() => void this.apply()));
        void this.apply();
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    protected async apply(): Promise<void> {
        const active = this.perspectives?.getActivePerspectiveId();
        const documents = active === DOCUMENTS_PERSPECTIVE_ID;
        // Which mode exactly, for the chrome that differs by mode (the bottom
        // panel above, the status line in product-ext) — the rail does not.
        if (active) {
            document.body.dataset.studioPerspective = active;
        } else {
            delete document.body.dataset.studioPerspective;
        }
        // The attribute drives the paint; the preference drives the layout, and
        // the layout is the same in both modes because both need the panel —
        // one for the menu bar, one for the collaboration strip. Only the paint
        // differs.
        document.body.dataset.studioMode = documents ? 'documents' : 'workbench';
        try {
            await this.preferences.set(
                'window.menuBarVisibility',
                'classic',
                PreferenceScope.User,
            );
        } catch (error) {
            // Written at User scope, into the throwaway session container. A
            // failure here costs the top row, not the session.
            console.warn('studio: could not keep the top panel in the layout for this mode', error);
        }
    }
}
