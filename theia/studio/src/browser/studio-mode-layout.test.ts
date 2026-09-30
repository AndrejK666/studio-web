// The rail is one toolset in every mode; a mode adds its own views beside it
// (studio-mode-layout.ts).

import 'reflect-metadata';
import { Emitter } from '@theia/core/lib/common/event';
import {
    BUILDING_PERSPECTIVE_ID, DOCUMENTS_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID, ORCA_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID
} from '../common/studio-modes';
import { ModeDescriptor, OFF_RAIL, RAIL, STUDIO_VIEW, StudioModeLayout, claimedElsewhere, declaredViews } from './studio-mode-layout';
import { RAIL_TABS } from './studio-chrome-mode';

/** The perspectives as the application registers them, reduced to their side placements. */
const DESCRIPTORS: ModeDescriptor[] = [
    { id: WORKBENCH_PERSPECTIVE_ID, viewPlacements: new Map([['studio.orca', 'right'], ['studio.operations', 'bottom']]) },
    { id: DOCUMENTS_PERSPECTIVE_ID, viewPlacements: new Map([['files', 'left'], ['studio:analyze', 'bottom']]) },
    { id: ORCA_PERSPECTIVE_ID, viewPlacements: new Map([['studio.orca', 'right'], ['scm-view-container', 'left']]) },
    { id: FULL_PERSPECTIVE_ID, viewPlacements: new Map([['studio.orca', 'right'], ['files', 'left']]) },
    { id: BUILDING_PERSPECTIVE_ID, viewPlacements: new Map([['gearbox.catalogue', 'left'], ['gearbox.product', 'main'], ['gearbox.inspector', 'right']]) },
];

const MODES = [WORKBENCH_PERSPECTIVE_ID, DOCUMENTS_PERSPECTIVE_ID, BUILDING_PERSPECTIVE_ID, ORCA_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID];

interface FakeWidget { id: string; isAttached: boolean; parent: unknown }

/** Every Theia view container, plus the Studio and Gearbox views; `vsx` says whether this is the desktop. */
function setup(active: string, placed: Record<string, 'left' | 'right'>, { vsx = true } = {}) {
    const changed = new Emitter<string>();
    let current = active;
    const area = new Map<string, 'left' | 'right'>(Object.entries(placed));
    const made = new Map<string, FakeWidget>();
    /** The expanded view of each side panel, if any. */
    const currentIn: Partial<Record<'left' | 'right', string>> = {};
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
        getCurrentWidget: jest.fn((side: 'left' | 'right') => (currentIn[side] ? made.get(currentIn[side]!) : undefined)),
        collapsePanel: jest.fn(async (side: 'left' | 'right') => { delete currentIn[side]; }),
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
    return { layout, shell, widgets, switchTo, on, area, currentIn };
}

/** The rail on a desktop, sorted as `on()` sorts. */
const RAIL_LEFT = ['debug', 'explorer-view-container', 'scm-view-container', 'search-view-container', 'test-view-container', 'vsx-extensions-view-container'];
const ASSISTANT = 'plugin-view-container:workbench.view.extension.claude-sidebar-secondary';

describe('the rail', () => {
    it('is the same in every mode', async () => {
        for (const mode of MODES) {
            const { layout, on } = setup(mode, {});
            await layout.apply();
            expect(on('left').filter(id => RAIL_LEFT.includes(id))).toEqual(RAIL_LEFT);
        }
    });

    it('never gains or loses an item when the mode changes, in any order', async () => {
        const { layout, on, switchTo } = setup(WORKBENCH_PERSPECTIVE_ID, { 'studio.desktop': 'left' });
        layout.onDidInitializeLayout();
        await new Promise(resolve => setTimeout(resolve, 0));
        const seen: string[][] = [];
        for (const mode of [DOCUMENTS_PERSPECTIVE_ID, BUILDING_PERSPECTIVE_ID, ORCA_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID]) {
            await switchTo(mode);
            seen.push(on('left').filter(id => id !== 'gearbox.catalogue'));
        }
        for (const rail of seen) {
            expect(rail).toEqual(['studio.desktop', ...RAIL_LEFT].sort());
        }
        layout.onStop();
    });

    it('is VS Code’s set in VS Code’s order: Theia’s own ranks', () => {
        expect(RAIL.map(view => view.id)).toEqual([
            'explorer-view-container', 'search-view-container', 'scm-view-container', 'debug', 'vsx-extensions-view-container', 'test-view-container',
        ]);
        const ranks = RAIL.map(view => view.rank ?? 0);
        expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
        expect(RAIL.every(view => view.area === 'left')).toBe(true);
    });

    it('has one search on it', () => {
        expect(RAIL.filter(view => /search/.test(view.id)).map(view => view.id)).toEqual(['search-view-container']);
    });

    it('is where the rail tabs come from, and a mode’s own view is not one of them', () => {
        expect(RAIL_TABS).toEqual(RAIL.map(view => view.id));
        for (const id of OFF_RAIL) {
            expect(RAIL_TABS).not.toContain(id);
        }
        expect(RAIL_TABS).not.toContain('studio.orca');
    });

    it('puts the Studio view after every rail view: the foot, where VS Code keeps Accounts', () => {
        expect(STUDIO_VIEW.rank).toBeGreaterThan(Math.max(...RAIL.map(view => view.rank ?? 0)));
    });
});

describe('what a mode adds beside the rail', () => {
    it('gives Development and Full the agents on the right', async () => {
        for (const mode of [WORKBENCH_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID]) {
            const { layout, on } = setup(mode, { 'studio.desktop': 'left' });
            await layout.apply();
            expect(on('left')).toEqual(['studio.desktop', ...RAIL_LEFT].sort());
            expect(on('right')).toEqual(['studio.orca']);
        }
    });

    it('gives Agent development its agents on the right too, and Source Control on the rail with everything else', async () => {
        const { layout, on } = setup(ORCA_PERSPECTIVE_ID, {});
        await layout.apply();
        expect(on('left')).toEqual(RAIL_LEFT);
        expect(on('right')).toEqual(['studio.orca']);
    });

    it('mirrors a layout Agent development saved before the rail was common: agents right, Source Control left', async () => {
        const { layout, on } = setup(ORCA_PERSPECTIVE_ID, { 'studio.orca': 'left', 'scm-view-container': 'right' });
        await layout.apply();
        expect(on('left')).toEqual(RAIL_LEFT);
        expect(on('right')).toEqual(['studio.orca']);
    });

    it('gives Building the catalogue beside the rail and the inspector on the right', async () => {
        const { layout, on } = setup(BUILDING_PERSPECTIVE_ID, {});
        await layout.apply();
        expect(on('left')).toEqual([...RAIL_LEFT, 'gearbox.catalogue'].sort());
        expect(on('right')).toEqual(['gearbox.inspector']);
    });

    it('places without activating, at Theia’s own rank', async () => {
        const { layout, shell } = setup(WORKBENCH_PERSPECTIVE_ID, {});
        await layout.apply();
        expect(shell.addWidget).toHaveBeenCalledWith(expect.objectContaining({ id: 'scm-view-container' }), { area: 'left', rank: 300 });
        expect(shell).not.toHaveProperty('activateWidget');
    });

    it('leaves a view where it already is', async () => {
        const placed = Object.fromEntries(RAIL_LEFT.map(id => [id, 'left' as const]));
        const { layout, shell } = setup(DOCUMENTS_PERSPECTIVE_ID, placed);
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

describe('the Studio view', () => {
    it('comes back, at the foot, to a mode whose layout was saved before it existed', async () => {
        const { layout, on, widgets, shell } = setup(WORKBENCH_PERSPECTIVE_ID, { 'studio.desktop': 'left' });
        const studio = widgets.tryGetWidget('studio.desktop')!;
        studio.parent = null;                       // Theia's restore detached it
        await layout.apply();
        expect(on('left')).toContain('studio.desktop');
        expect(shell.addWidget).toHaveBeenCalledWith(studio, { area: 'left', rank: STUDIO_VIEW.rank });
    });

    it('is never created where there is none (a session)', async () => {
        const { layout, widgets } = setup(WORKBENCH_PERSPECTIVE_ID, {});
        await layout.apply();
        expect(widgets.getOrCreateWidget).not.toHaveBeenCalledWith('studio.desktop');
    });
});

describe('what a mode sets aside on entering it', () => {
    it('takes the Gearbox Catalogue out of Doc editing, and keeps the rail and the Studio view', async () => {
        const placed = Object.fromEntries(RAIL_LEFT.map(id => [id, 'left' as const]));
        const { layout, on } = setup(DOCUMENTS_PERSPECTIVE_ID, {
            ...placed, 'gearbox.catalogue': 'left', 'studio.desktop': 'left', [ASSISTANT]: 'right',
        });
        await layout.apply();
        expect(on('left')).toEqual(['studio.desktop', ...RAIL_LEFT].sort());
        // The assistants belong to no mode, and stay.
        expect(on('right')).toEqual([ASSISTANT]);
    });

    it('takes the agents out of Doc editing and Building, where no ribbon places them', async () => {
        for (const mode of [DOCUMENTS_PERSPECTIVE_ID, BUILDING_PERSPECTIVE_ID]) {
            const { layout, on } = setup(mode, { 'studio.orca': 'right' });
            await layout.apply();
            expect(on('right')).not.toContain('studio.orca');
        }
    });

    it('folds a panel whose front view is set aside, rather than bringing its neighbour forward', async () => {
        const { layout, shell, currentIn, on } = setup(DOCUMENTS_PERSPECTIVE_ID, {
            'explorer-view-container': 'left', 'gearbox.inspector': 'right', [ASSISTANT]: 'right',
        });
        currentIn.right = 'gearbox.inspector';
        await layout.apply();
        expect(shell.collapsePanel).toHaveBeenCalledWith('right');
        expect(on('right')).toEqual([ASSISTANT]);
        expect(shell.collapsePanel).not.toHaveBeenCalledWith('left');
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
            'explorer-view-container': 'left', 'scm-view-container': 'left',
            'studio.object-details': 'right', 'chat-view-widget': 'right', 'timeline-view': 'left',
        });
        await layout.apply();
        expect(on('left')).toEqual([...RAIL_LEFT, 'timeline-view'].sort());
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

describe('the declaration', () => {
    it('is the rail first, then a perspective’s own side placements the rail does not name; main and bottom ignored', () => {
        const views = declaredViews(DESCRIPTORS[2]).map(view => `${view.id}@${view.area}`);
        expect(views).toEqual([...RAIL.map(view => `${view.id}@left`), 'studio.orca@right']);
        expect(declaredViews(DESCRIPTORS[1]).map(view => view.id)).not.toContain('studio:analyze');
    });

    it('lets the rail win over a perspective that names a rail view on the other side', () => {
        const views = declaredViews({ id: 'x', viewPlacements: new Map([['scm-view-container', 'right']]) });
        expect(views.filter(view => view.id === 'scm-view-container')).toEqual([expect.objectContaining({ area: 'left' })]);
    });

    it('never sets a rail view aside', () => {
        for (const mode of MODES) {
            const foreign = claimedElsewhere(mode, DESCRIPTORS);
            for (const view of RAIL) {
                expect(foreign.has(view.id)).toBe(false);
            }
        }
    });

    it('never counts the Studio view or an assistant as another mode’s', () => {
        const descriptors = [
            { id: 'a', viewPlacements: new Map([['studio.desktop', 'left'], [ASSISTANT, 'right']]) },
            { id: 'b', viewPlacements: new Map<string, string>() },
        ];
        const foreign = claimedElsewhere('b', descriptors);
        expect(foreign.has('studio.desktop')).toBe(false);
        expect(foreign.has(ASSISTANT)).toBe(false);
    });
});
