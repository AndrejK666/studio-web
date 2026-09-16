import 'reflect-metadata';

// The descriptors place widgets by id, and importing those ids drags in the
// widgets themselves — React, mermaid, the editor stack. What is under test is
// the ARRANGEMENT, so the placed views stand in for themselves.
jest.mock('./studio-contribution', () => ({
    DEFAULT_LAYOUT: [
        { id: 'studio:widget', area: 'left' },
        { id: 'studio.orca', area: 'right' },
        { id: 'studio:audit', area: 'bottom' }
    ]
}));
// Same stand-in the explorer suite uses: the real navigator widget wants the
// frontend application config before a single test runs.
jest.mock('@theia/navigator/lib/browser/navigator-widget', () => ({
    FILE_NAVIGATOR_ID: 'files'
}));
jest.mock('./analyze-widget', () => ({ AnalyzeWidget: { ID: 'studio:analyze' } }));
jest.mock('./orca-widget', () => ({ OrcaWidget: { ID: 'studio.orca' } }));
jest.mock('./workspace-graph-widget', () => ({ WorkspaceGraphWidget: { ID: 'studio:workspace-graph' } }));

import { DOCUMENTS_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID } from '../common/studio-modes';
import { StudioPerspectiveContribution } from './studio-perspectives';

function register() {
    const registered = new Map<string, any>();
    new StudioPerspectiveContribution().registerPerspectives({
        registerPerspective: (descriptor: any) => registered.set(descriptor.id, descriptor)
    } as never);
    return registered;
}

describe('Studio workbench modes', () => {
    it('offers two modes, and no leftover stub beside them', () => {
        const registered = register();
        expect([...registered.keys()].sort()).toEqual(
            [DOCUMENTS_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID].sort(),
        );
        expect([...registered.values()].map(d => d.label)).toEqual(
            expect.arrayContaining(['Workbench', 'Documents']),
        );
    });

    it('takes over Theia’s own default id rather than adding a third entry', () => {
        // registerPerspective is keyed by id, so this REPLACES the built-in
        // "Default". A session that never switches then behaves as it always
        // did, and the picker offers two real choices instead of one and a stub.
        expect(WORKBENCH_PERSPECTIVE_ID).toBe('default');
        expect(register().has('default')).toBe(true);
    });

    it('lays the workbench out the way a fresh session already does', () => {
        // One source for both, or the layout a session builds and the layout
        // the mode restores drift apart.
        const workbench = register().get(WORKBENCH_PERSPECTIVE_ID);
        expect([...workbench.viewPlacements.entries()]).toEqual([
            ['studio:widget', 'left'],
            ['studio.orca', 'right'],
            ['studio:audit', 'bottom'],
        ]);
        expect(workbench.primaryViews).toEqual({ right: 'studio.orca' });
        // The desktop collapses its side panels on start and this workbench had
        // no equivalent — #167 recorded the result as a strip of unclaimed
        // right panel beside the editor.
        expect(workbench.chromeOptions).toEqual({ collapseAreas: ['right', 'bottom'] });
    });

    it('clears the flanks for writing, and keeps findings one click away', () => {
        const documents = register().get(DOCUMENTS_PERSPECTIVE_ID);
        expect(documents.chromeOptions).toEqual({ collapseAreas: ['right', 'bottom'] });
        // The document list is the explorer — markdown only, labelled by each
        // file's own H1 (ExplorerPresentationService).
        expect(documents.viewPlacements.get('files')).toBe('left');
        expect(documents.primaryViews).toEqual({ left: 'files' });
        // Placed but collapsed: a finding belongs to a document, so the view is
        // out of the way rather than absent.
        expect(documents.viewPlacements.get('studio:analyze')).toBe('bottom');
        expect(documents.viewPlacements.has('studio.orca')).toBe(false);
    });
});
