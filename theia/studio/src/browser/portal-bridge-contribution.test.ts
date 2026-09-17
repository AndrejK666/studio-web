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

import * as fs from 'fs';
import * as path from 'path';
import { CommandService } from '@theia/core/lib/common';
import type { NotifyEditorFrontendController } from './notify-editor-controller';
import { IDENTITY_VIEWER_COMMAND_ID, PortalBridgeContribution, PortalViewer } from './portal-bridge-contribution';

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

    notify(request: Parameters<NotifyEditorFrontendController['onNotifyEditor']>[0]): void {
        void this.notifier.onNotifyEditor(request);
    }

    adopt(viewer: PortalViewer | undefined): void {
        this.adoptPortalViewer(viewer);
    }

    useCommands(commands: CommandService): void {
        (this as unknown as { commands: CommandService }).commands = commands;
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

describe('PortalBridgeContribution notifications', () => {
    it('shows a portal notification without waiting for the layout', () => {
        // The opens are held until the shell has restored, because the restore
        // would bury them. A notification moves nothing and steals no focus,
        // and holding it back would only make it arrive after the thing it is
        // about has gone stale.
        const bridge = new TestBridge();
        const shown: unknown[] = [];
        Object.defineProperty(bridge, 'notifier', {
            value: { onNotifyEditor: (request: unknown) => void shown.push(request) },
        });

        bridge.notify({ level: 'info', message: 'finished', source: 'Artifact ingest' });

        expect(shown).toEqual([
            expect.objectContaining({ message: 'finished', source: 'Artifact ingest' }),
        ]);
    });
});

/**
 * Who the session attributes writing to.
 *
 * The IDE has no login of its own and one session container is shared by
 * everybody who opens the workspace, so the portal stating the viewer is the
 * only thing that tells two authors apart. What the identity is then keyed by
 * belongs to `product-ext/test/identity.test.js`; what is here is the one thing
 * this side owns — when the hand-off happens, and when it must not.
 */
describe('PortalBridgeContribution viewer hand-off', () => {

    function bridgeWith(): { bridge: TestBridge; calls: [string, unknown[]][] } {
        const calls: [string, unknown[]][] = [];
        const bridge = new TestBridge();
        bridge.useCommands({
            executeCommand: (id: string, ...args: unknown[]) => {
                calls.push([id, args]);
                return Promise.resolve(undefined);
            }
        } as unknown as CommandService);
        return { bridge, calls };
    }

    it('forwards the viewer to the identity command', () => {
        const { bridge, calls } = bridgeWith();
        const viewer = { sub: 'sub-42', name: 'Roma', kind: 'person' };

        bridge.adopt(viewer);

        expect(calls).toEqual([[IDENTITY_VIEWER_COMMAND_ID, [viewer]]]);
    });

    it('drops a viewer with no subject rather than signing the session out', () => {
        // `studio.token` is posted on every silent renew whether or not anybody
        // is signed in. Forwarding a subject-less viewer would replace a
        // verified identity with an anonymous one mid-session.
        const { bridge, calls } = bridgeWith();

        bridge.adopt(undefined);
        bridge.adopt({});
        bridge.adopt({ name: 'Roma' });

        expect(calls).toEqual([]);
    });

    it('survives a build composed without the product extension', async () => {
        const bridge = new TestBridge();
        bridge.useCommands({
            executeCommand: () => Promise.reject(new Error('unknown command'))
        } as unknown as CommandService);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* quiet */ });

        expect(() => bridge.adopt({ sub: 'sub-42' })).not.toThrow();
        await Promise.resolve(); // let the rejection settle inside the catch

        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('names the command the product extension actually registers', () => {
        // The two sides are different Theia extensions with no dependency
        // between them, so the id is a literal in each. Renaming one alone is
        // a sign-in that silently stops arriving, with nothing to compile
        // against — which is what this reads the other file for.
        const registrar = fs.readFileSync(
            path.resolve(__dirname, '../../../product-ext/src/browser/product-frontend-module.js'),
            'utf8'
        );
        expect(registrar).toContain(`id: '${IDENTITY_VIEWER_COMMAND_ID}'`);
        expect(registrar).toContain('identity.adopt(viewer)');
    });
});
