// A mode's rails are what the mode declares (studio-mode-layout.ts).

import 'reflect-metadata';
import { Emitter } from '@theia/core/lib/common/event';
import {
    BUILDING_PERSPECTIVE_ID, DOCUMENTS_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID, ORCA_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID
} from '../common/studio-modes';
import { ModeDescriptor, MODE_VIEWS, StudioModeLayout, claimedElsewhere, declaredViews } from './studio-mode-layout';
import { MODE_TABS } from './studio-chrome-mode';

/** The perspectives as the application registers them, reduced to their side placements. */
const DESCRIPTORS: ModeDescriptor[] = [
    { id: WORKBENCH_PERSPECTIVE_ID, viewPlacements: new Map([['studio.orca', 'right'], ['studio.operations', 'bottom']]) },
    { id: DOCUMENTS_PERSPECTIVE_ID, viewPlacements: new Map([['files', 'left'], ['studio:analyze', 'bottom']]) },
    { id: ORCA_PERSPECTIVE_ID, viewPlacements: new Map([['studio.orca', 'left'], ['scm-view-container', 'right']]) },
    { id: FULL_PERSPECTIVE_ID, viewPlacements: new Map([['studio.orca', 'right'], ['files', 'left']]) },
    { id: BUILDING_PERSPECTIVE_ID, viewPlacements: new Map([['gearbox.catalogue', 'left'], ['gearbox.product', 'main'], ['gearbox.inspector', 'right']]) },
];

interface FakeWidget { id: string; isAttached: boolean; parent: unknown }

/** Every Theia view container, plus the Studio and Gearbox views; `vsx` says whether this is the desktop. */
function setup(active: string, placed: Record<string, 'left' | 'right'>, { vsx = true } = {}) {
    const changed = new Emitter<string>();
    let current = active;
    const area = new Map<string, 'left' | 'right'>(Object.entries(placed));
    const made = new Map<string, FakeWidget>();
    const widget = (id: string): FakeWidget => {
        let w = made.get(id);
        if (!w) {
            w = {
                id,
                get isAttached(): boolean { return area.has(id); },
                set parent(value: unknown) { if (value === null) { area.delete(id); } },
                get parent(): unknown { return area.has(id) ? {} : null; },
            } as FakeWidget;
            made.set(id, w);
        }
        return w;
    };
    for (const id of area.keys()) { widget(id); }
    // The file navigator lives inside the explorer's container: attached, but
    // not a rail tab of its own, so the shell names no area for it.
    made.set('files', { id: 'files', isAttached: true, parent: {} });
    const shell = {
        getWidgets: jest.fn((side: string) => [...area].filter(([, a]) => a === side).map(([id]) => widget(id))),
        getAreaFor: jest.fn((w: FakeWidget) => area.get(w.id)),
        addWidget: jest.fn(async (w: FakeWidget, options: { area: 'left' | 'right' }) => { area.set(w.id, options.area); }),
    };
    const widgets = {
        tryGetWidget: jest.fn((id: string) => made.get(id)),
        getOrCreateWidget: jest.fn(async (id: string) => widget(id)),
    };
    const factoryIds = [
        'explorer-view-container', 'search-view-container', 'scm-view-container', 'debug', 'test-view-container',
        'studio.orca', 'studio.desktop', 'gearbox.catalogue', 'gearbox.inspector', 'files',
        ...(vsx ? ['vsx-extensions-view-container'] : []),
    ];
    const factories = { getContributions: () => factoryIds.map(id => ({ id })) };
    const perspectives = {
        getActivePerspectiveId: () => current,
        getRegisteredPerspectives: () => DESCRIPTORS,
        onDidChangePerspective: changed.event,
    };
    const layout = new StudioModeLayout();
    Object.defineProperty(layout, 'shell', { value: shell });
    Object.defineProperty(layout, 'widgets', { value: widgets });
    Object.defineProperty(layout, 'factories', { value: factories });
    Object.defineProperty(layout, 'perspectives', { value: perspectives });
    const switchTo = async (id: string): Promise<void> => {
        current = id;
        changed.fire(id);
        await new Promise(resolve => setTimeout(resolve, 0));
    };
    const on = (side: 'left' | 'right'): string[] => [...area].filter(([, a]) => a === side).map(([id]) => id).sort();
    return { layout, shell, widgets, switchTo, on, area };
}

const CODE_LEFT = ['debug', 'explorer-view-container', 'scm-view-container', 'search-view-container', 'test-view-container', 'vsx-extensions-view-container'];

describe('the views a mode keeps on its rails', () => {
    it('gives Development and Full the code rails, Source Control on the left', async () => {
        for (const mode of [WORKBENCH_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID]) {
            const { layout, on } = setup(mode, { 'studio.desktop': 'left' });
            await layout.apply();
            expect(on('left')).toEqual(['studio.desktop', ...CODE_LEFT].sort());
            expect(on('right')).toEqual(['studio.orca']);
        }
    });

    it('gives Agent development its file tree and search, and keeps Source Control on the right', async () => {
        const { layout, on } = setup(ORCA_PERSPECTIVE_ID, { 'studio.orca': 'left', 'scm-view-container': 'right' });
        await layout.apply();
        expect(on('left')).toEqual(['explorer-view-container', 'search-view-container', 'studio.orca']);
        expect(on('right')).toEqual(['scm-view-container']);
    });

    it('gives Building the files and Source Control beside the catalogue', async () => {
        const { layout, on } = setup(BUILDING_PERSPECTIVE_ID, {});
        await layout.apply();
        expect(on('left')).toEqual(['explorer-view-container', 'gearbox.catalogue', 'scm-view-container']);
        expect(on('right')).toEqual(['gearbox.inspector']);
    });

    it('places without activating, at Theia’s own rank', async () => {
        const { layout, shell } = setup(WORKBENCH_PERSPECTIVE_ID, {});
        await layout.apply();
        expect(shell.addWidget).toHaveBeenCalledWith(expect.objectContaining({ id: 'scm-view-container' }), { area: 'left', rank: 300 });
        expect(shell).not.toHaveProperty('activateWidget');
    });

    it('brings Source Control back to the left in Full after Agent development moved it right', async () => {
        const { layout, on, switchTo } = setup(ORCA_PERSPECTIVE_ID, { 'studio.orca': 'left', 'scm-view-container': 'right' });
        layout.onDidInitializeLayout();
        await switchTo(FULL_PERSPECTIVE_ID);
        expect(on('left')).toContain('scm-view-container');
        expect(on('right')).not.toContain('scm-view-container');
        layout.onStop();
    });

    it('leaves a view where it already is', async () => {
        const { layout, shell } = setup(DOCUMENTS_PERSPECTIVE_ID, { 'explorer-view-container': 'left' });
        await layout.apply();
        expect(shell.addWidget).not.toHaveBeenCalled();
    });

    it('does not move a view the shell does not track as a rail tab (the navigator inside the explorer)', async () => {
        const { layout, shell } = setup(DOCUMENTS_PERSPECTIVE_ID, { 'explorer-view-container': 'left' });
        await layout.apply();
        expect(shell.addWidget).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'files' }), expect.anything());
    });

    it('skips, silently, a view this application cannot make (a session has no Extensions view)', async () => {
        const { layout, on, widgets } = setup(FULL_PERSPECTIVE_ID, {}, { vsx: false });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        await layout.apply();
        expect(on('left')).not.toContain('vsx-extensions-view-container');
        expect(widgets.getOrCreateWidget).not.toHaveBeenCalledWith('vsx-extensions-view-container');
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('what a mode sets aside on entering it', () => {
    it('takes the Gearbox Catalogue and the code rails out of Doc editing', async () => {
        const { layout, on } = setup(DOCUMENTS_PERSPECTIVE_ID, {
            'explorer-view-container': 'left', 'gearbox.catalogue': 'left', 'scm-view-container': 'left',
            'vsx-extensions-view-container': 'left', 'studio.desktop': 'left',
            'plugin-view-container:workbench.view.extension.claude-sidebar-secondary': 'right',
        });
        await layout.apply();
        expect(on('left')).toEqual(['explorer-view-container', 'studio.desktop']);
        // The assistants belong to no mode, and stay.
        expect(on('right')).toEqual(['plugin-view-container:workbench.view.extension.claude-sidebar-secondary']);
    });

    it('detaches without disposing: the mode that declares it gets it back', async () => {
        const { layout, on, switchTo } = setup(BUILDING_PERSPECTIVE_ID, {});
        layout.onDidInitializeLayout();
        await switchTo(DOCUMENTS_PERSPECTIVE_ID);
        expect(on('left')).not.toContain('gearbox.catalogue');
        await switchTo(BUILDING_PERSPECTIVE_ID);
        expect(on('left')).toContain('gearbox.catalogue');
        layout.onStop();
    });

    it('never touches a view no mode claims — Object Details, the AI chat, a plugin’s view', async () => {
        const { layout, on } = setup(DOCUMENTS_PERSPECTIVE_ID, {
            'explorer-view-container': 'left', 'studio.object-details': 'right', 'chat-view-widget': 'right', 'timeline-view': 'left',
        });
        await layout.apply();
        expect(on('left')).toEqual(['explorer-view-container', 'timeline-view']);
        expect(on('right')).toEqual(['chat-view-widget', 'studio.object-details']);
    });

    it('does not fight a view opened while working in the mode: nothing runs until the next switch', async () => {
        const { layout, on, area, shell } = setup(DOCUMENTS_PERSPECTIVE_ID, { 'explorer-view-container': 'left' });
        layout.onDidInitializeLayout();
        await new Promise(resolve => setTimeout(resolve, 0));
        area.set('gearbox.catalogue', 'left');      // View > Gearbox Catalogue
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(on('left')).toContain('gearbox.catalogue');
        expect(shell.getWidgets).toHaveBeenCalledTimes(2);   // the one pass on startup, left and right
        layout.onStop();
    });
});

describe('the table', () => {
    it('adds a perspective’s own side placements after what MODE_VIEWS names, and ignores main and bottom', () => {
        const views = declaredViews(ORCA_PERSPECTIVE_ID, DESCRIPTORS[2]).map(view => `${view.id}@${view.area}`);
        expect(views).toEqual(['explorer-view-container@left', 'search-view-container@left', 'studio.orca@left', 'scm-view-container@right']);
        expect(declaredViews(DOCUMENTS_PERSPECTIVE_ID, DESCRIPTORS[1]).map(view => view.id)).not.toContain('studio:analyze');
    });

    it('never counts the Studio view or an assistant as another mode’s', () => {
        const table = { a: [{ id: 'studio.desktop', area: 'left' as const }], b: [] };
        expect(claimedElsewhere('b', [], table).has('studio.desktop')).toBe(false);
    });

    it('is where the rail tabs come from', () => {
        for (const [mode, views] of Object.entries(MODE_VIEWS)) {
            expect(MODE_TABS[mode]).toEqual(views.filter(view => view.area === 'left').map(view => view.id));
        }
        // Extensions only where MODE_VIEWS says: the code modes.
        const withExtensions = Object.entries(MODE_TABS).filter(([, ids]) => ids.includes('vsx-extensions-view-container')).map(([mode]) => mode);
        expect(withExtensions.sort()).toEqual([WORKBENCH_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID].sort());
    });
});
