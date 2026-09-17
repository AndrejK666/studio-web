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
//   Workbench  — Theia's own menu bar, rendered.
//   Documents  — no menu bar, and no band where it was.
//
// Two levers are needed, because two systems decide. `window.menuBarVisibility`
// is what Theia acts on — it is the only thing that takes the panel out of the
// LAYOUT (ApplicationShell.setTopPanelVisibility → Lumino setHidden). The
// stylesheet below is what takes it back out of the product's blanket
// `#theia-top-panel { display: none !important }`, which is a PAINT rule and
// would otherwise leave the restored bar invisible but occupying its height —
// the same band, earned a different way.

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { PreferenceScope, PreferenceService } from '@theia/core/lib/common';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { DOCUMENTS_PERSPECTIVE_ID } from '../common/studio-modes';

const STYLE_ID = 'studio-chrome-mode';

/**
 * Wins over `#theia-top-panel { display: none !important }` on specificity —
 * (0,2,1) against (0,1,0) — so the order the two stylesheets are injected in
 * does not decide who is right.
 */
const CHROME_CSS = `
body[data-studio-mode="documents"] #theia-top-panel { display: none !important; }
body[data-studio-mode="workbench"] #theia-top-panel { display: flex !important; }
/* Source Control. The product hides its activity-bar tab along with Debug,
   Test, Search and Explorer — "a product keeps only the ones it wants" — which
   is right for someone writing a document and wrong for someone who has just
   edited code and wants to commit it. The workbench is the mode that wants it.

   Only this one is restored. Explorer stays hidden because Projects replaces
   it, and Debug, Test and Search are not part of the question being answered. */
body[data-studio-mode="workbench"] #shell-tab-scm-view-container { display: flex !important; }
`;

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
        style.textContent = CHROME_CSS;
        document.head.appendChild(style);
        this.toDispose.push({ dispose: () => style.remove() });

        this.toDispose.push(this.perspectives.onDidChangePerspective(() => void this.apply()));
        void this.apply();
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    protected async apply(): Promise<void> {
        const documents = this.perspectives?.getActivePerspectiveId() === DOCUMENTS_PERSPECTIVE_ID;
        // The attribute drives the paint; the preference drives the layout.
        document.body.dataset.studioMode = documents ? 'documents' : 'workbench';
        try {
            await this.preferences.set(
                'window.menuBarVisibility',
                documents ? 'hidden' : 'classic',
                PreferenceScope.User,
            );
        } catch (error) {
            // Written at User scope, into the throwaway session container. A
            // failure here costs the menu bar, not the session.
            console.warn('studio: could not set the menu bar visibility for this mode', error);
        }
    }
}
