// Workbench modes, as Theia perspectives.
//
// Theia is a good place to work on a repository and a busy place to write a
// document: the explorer, the SCM row, the agents dock and the problems panel
// are all beside the paragraph you are trying to write. A perspective is the
// shell's own answer to that — a named arrangement of the shell, each one
// remembering its own layout (`PerspectiveServiceInternal` persists them under
// `perspective-layouts`), with a picker that Theia contributes itself as soon
// as more than one is registered.
//
// Two are registered here and a third is a descriptor, not a refactor.
//
// What a perspective is NOT: a smaller application. Every package is still
// loaded and every command is still in the palette — Documents opens without
// the terminal in front of you, it does not take the terminal away. Removing
// capability means a second browser-app with fewer `@theia/*` dependencies,
// which is a different and much larger change.

import { injectable } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { PerspectiveContribution, PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { FILE_NAVIGATOR_ID } from '@theia/navigator/lib/browser/navigator-widget';
import { AnalyzeWidget } from './analyze-widget';
import { DEFAULT_LAYOUT } from './studio-contribution';
import { OrcaWidget } from './orca-widget';
import { DOCUMENTS_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID } from '../common/studio-modes';

@injectable()
export class StudioPerspectiveContribution implements PerspectiveContribution {

    registerPerspectives(service: PerspectiveService): void {
        service.registerPerspective({
            id: WORKBENCH_PERSPECTIVE_ID,
            label: 'Workbench',
            viewPlacements: new Map(
                DEFAULT_LAYOUT.map(placement => [placement.id, placement.area as ApplicationShell.Area]),
            ),
            // The graph last, so it takes the focus from the agents dock —
            // the same order `StudioContribution.initializeLayout` establishes
            // when it builds a fresh session's layout.
            primaryViews: { right: OrcaWidget.ID },
            // The desktop collapses its side panels on start; this workbench
            // had no equivalent, and #167 recorded the result — a fresh session
            // opening with a wide strip of unclaimed right panel beside the
            // editor. Collapsed is not hidden: the Agents dock is one click on
            // its tab, and the panel stays where the person leaves it.
            chromeOptions: { collapseAreas: ['right', 'bottom'] },
        });

        service.registerPerspective({
            id: DOCUMENTS_PERSPECTIVE_ID,
            label: 'Documents',
            // The document list is the explorer: in Studio sessions it already
            // shows markdown only and labels each file with its own H1 rather
            // than its filename (ExplorerPresentationService), which is the
            // list a writer wants and nothing like a file tree.
            viewPlacements: new Map<string, ApplicationShell.Area>([
                [FILE_NAVIGATOR_ID, 'left'],
                // Findings belong to a document, so the view stays placed —
                // one click away in a collapsed panel rather than absent.
                [AnalyzeWidget.ID, 'bottom'],
            ]),
            chromeOptions: { collapseAreas: ['right', 'bottom'] },
            primaryViews: { left: FILE_NAVIGATOR_ID },
        });
    }
}
