import 'reflect-metadata';

// The collaborators pull the editor, the workspace service and the markdown
// editor's whole widget tree behind them, none of which this is about: the
// question here is purely WHEN the bridge runs an open, not what an open does.
jest.mock('./open-in-editor-controller', () => ({
    OpenInEditorFrontendController: class OpenInEditorFrontendController {}
}));
jest.mock('./studio-document-opener', () => ({
    StudioDocumentOpener: class StudioDocumentOpener {}
}));
jest.mock('./artifact-graph-contribution', () => ({
    ArtifactGraphCommand: { id: 'studio.artifactGraph' }
}));

import { PortalBridgeContribution } from './portal-bridge-contribution';

/**
 * The hand-off and the shell layout race, and the layout wins.
 *
 * Theia starts its contributions first and restores the layout second, and the
 * restore re-activates whichever tab was active when the session was last used.
 * The portal's message arrives during the first half, so a file opened there
 * opens correctly and is then buried under the restored view — a tab that is
 * present but not in front, which reads as "the hand-off did nothing".
 */
class TestBridge extends PortalBridgeContribution {
    requestOpen(open: () => void): void {
        this.openWhenLayoutReady(open);
    }
}

describe('PortalBridgeContribution layout gating', () => {
    it('holds an open requested before the layout is restored, then runs it', () => {
        const bridge = new TestBridge();
        const opened: string[] = [];

        bridge.requestOpen(() => opened.push('document'));
        expect(opened).toEqual([]); // the restore would bury it

        bridge.onDidInitializeLayout();
        expect(opened).toEqual(['document']);
    });

    it('keeps the portal’s order, so the last thing asked for ends up on top', () => {
        const bridge = new TestBridge();
        const opened: string[] = [];

        bridge.requestOpen(() => opened.push('graph'));
        bridge.requestOpen(() => opened.push('file'));
        bridge.onDidInitializeLayout();

        expect(opened).toEqual(['graph', 'file']);
    });

    it('opens immediately once the layout is up — the common case is not delayed', () => {
        const bridge = new TestBridge();
        const opened: string[] = [];

        bridge.onDidInitializeLayout();
        bridge.requestOpen(() => opened.push('file'));

        expect(opened).toEqual(['file']);
    });

    it('does not replay an open on a second layout initialization', () => {
        const bridge = new TestBridge();
        const opened: string[] = [];

        bridge.requestOpen(() => opened.push('file'));
        bridge.onDidInitializeLayout();
        bridge.onDidInitializeLayout();

        expect(opened).toEqual(['file']);
    });
});
