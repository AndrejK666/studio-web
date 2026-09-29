import 'reflect-metadata';

import { DOCUMENTS_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID, ORCA_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID } from '../common/studio-modes';
import * as fs from 'fs';
import * as path from 'path';

import { ARCHITECT_PERSPECTIVE_ID, MODES, RibbonCommands, keepsMenu, ribbonAction, roleOf } from './studio-mode-bar';

describe('Studio modes', () => {
    it('names the modes by the work, one perspective each', () => {
        expect(MODES.map(m => m.label)).toEqual(['Doc editing', 'Building', 'Development', 'Agent development', 'FULL SUPER POWER']);
        expect(new Set(MODES.map(m => m.perspective)).size).toBe(MODES.length);
    });

    it('reads the active perspective as its mode', () => {
        expect(roleOf(DOCUMENTS_PERSPECTIVE_ID)).toBe('docs');
        expect(roleOf(ARCHITECT_PERSPECTIVE_ID)).toBe('building');
        expect(roleOf(WORKBENCH_PERSPECTIVE_ID)).toBe('development');
        expect(roleOf(ORCA_PERSPECTIVE_ID)).toBe('orca');
        expect(roleOf(FULL_PERSPECTIVE_ID)).toBe('full');
    });

    it('reads a perspective it does not know as Development', () => {
        // A package that registers its own perspective must not leave the
        // header claiming no mode at all.
        expect(roleOf('someone.elses')).toBe('development');
        expect(roleOf(undefined)).toBe('development');
    });

    it('keeps File and Help in every mode, and everything in FULL SUPER POWER', () => {
        for (const mode of MODES.filter(m => m.role !== 'full')) {
            expect(mode.menus).toEqual(expect.arrayContaining(['File', 'Help']));
        }
        expect(MODES.find(m => m.role === 'full')?.menus).toEqual(['*']);
    });

    it('gives FULL SUPER POWER every other mode\'s commands, each once', () => {
        const full = MODES.find(m => m.role === 'full');
        const commands = (full?.groups ?? []).flatMap(g => g.actions.map(a => a.command));
        expect(new Set(commands).size).toBe(commands.length);
        const everyOther = new Set(MODES.filter(m => m.role !== 'full').flatMap(m => m.groups.flatMap(g => g.actions.map(a => a.command))));
        expect(new Set(commands)).toEqual(everyOther);
    });

    it('gives every mode a ribbon with captioned, non-empty groups', () => {
        for (const mode of MODES) {
            expect(mode.groups.length).toBeGreaterThan(0);
            for (const group of mode.groups) {
                expect(group.label).not.toBe('');
                expect(group.actions.length).toBeGreaterThan(0);
                for (const action of group.actions) {
                    expect(action.command).not.toBe('');
                    expect(action.icon).not.toBe('');
                }
            }
        }
    });
});

describe('the Gearbox menu and the Building ribbon', () => {
    /** The label gearbox-studio registers its top-level menu under, read from its source. */
    function gearboxMenuLabel(): string {
        const menus = fs.readFileSync(path.join(__dirname, '../../../gearbox-studio/src/browser/menus.ts'), 'utf8');
        const match = /export const GEARBOX_MENU_LABEL = "([^"]+)";/.exec(menus);
        if (!match) {
            throw new Error('gearbox-studio no longer exports GEARBOX_MENU_LABEL');
        }
        return match[1];
    }

    it('keeps the menu gearbox-studio labels, in Building and FULL SUPER POWER only', () => {
        const label = gearboxMenuLabel();
        expect(label).toBe('Gearbox');
        expect(keepsMenu(ARCHITECT_PERSPECTIVE_ID, label)).toBe(true);
        expect(keepsMenu(FULL_PERSPECTIVE_ID, label)).toBe(true);
        expect(keepsMenu(WORKBENCH_PERSPECTIVE_ID, label)).toBe(false);
        expect(keepsMenu(DOCUMENTS_PERSPECTIVE_ID, label)).toBe(false);
        expect(keepsMenu(ORCA_PERSPECTIVE_ID, label)).toBe(false);
    });

    it('keeps what it kept before, and drops a menu no mode names', () => {
        expect(keepsMenu(ARCHITECT_PERSPECTIVE_ID, 'File')).toBe(true);
        expect(keepsMenu(ARCHITECT_PERSPECTIVE_ID, 'Terminal')).toBe(false);
        expect(keepsMenu(undefined, 'Terminal')).toBe(true);
        expect(keepsMenu(FULL_PERSPECTIVE_ID, 'Anything a plugin adds')).toBe(true);
    });

    it('puts Resolve and Lock in Building\'s Check group, beside Conflicts and Generate', () => {
        const building = MODES.find(m => m.role === 'building');
        const check = building?.groups.find(g => g.label === 'Check');
        expect(check?.actions.map(a => a.command)).toEqual([
            'gearbox.product.resolve',
            'gearbox.conflicts.show',
            'gearbox.lock.show',
            'gearbox.generate.show',
        ]);
    });

    it('draws Resolve and Lock disabled with the reason gearbox-studio gives, before a product is open', () => {
        const building = MODES.find(m => m.role === 'building');
        const actions = building?.groups.flatMap(g => g.actions) ?? [];
        const reasons: Record<string, string> = {
            'gearbox.product.resolve': 'Open or create a product first',
            'gearbox.lock.show': 'Open or create a product first',
        };
        const commands: RibbonCommands = {
            getCommand: id => ({ id }),
            isEnabled: () => false,
            getAllHandlers: id => [{ execute: () => undefined, disabledReason: () => reasons[id] }],
        };
        for (const id of Object.keys(reasons)) {
            const action = actions.find(a => a.command === id);
            expect(action).toBeDefined();
            expect(ribbonAction(commands, action!)).toEqual({ enabled: false, title: `${action!.title} — Open or create a product first` });
        }
    });

    it('draws Resolve enabled once the handler says it can run', () => {
        const resolve = MODES.find(m => m.role === 'building')?.groups.flatMap(g => g.actions).find(a => a.command === 'gearbox.product.resolve');
        const commands: RibbonCommands = { getCommand: id => ({ id }), isEnabled: () => true, getAllHandlers: () => [] };
        expect(ribbonAction(commands, resolve!)).toEqual({ enabled: true, title: resolve!.title });
    });
});

describe('ribbonAction', () => {
    const action = { command: 'gearbox.product.show', title: 'The product: composition, topology, validation' };

    function registry(opts: { registered: boolean; enabled: boolean; handlers?: object[] }): RibbonCommands {
        return {
            getCommand: id => (opts.registered ? { id } : undefined),
            isEnabled: () => opts.enabled,
            getAllHandlers: () => opts.handlers ?? [],
        };
    }

    it('leaves out an action whose command this build does not have', () => {
        expect(ribbonAction(registry({ registered: false, enabled: false }), action)).toBeUndefined();
    });

    it('draws an enabled action with its own title', () => {
        expect(ribbonAction(registry({ registered: true, enabled: true }), action)).toEqual({ enabled: true, title: action.title });
    });

    it('draws a registered but disabled action disabled, saying why when a handler can', () => {
        const handlers = [
            { execute: () => undefined },
            { execute: () => undefined, disabledReason: () => 'Open or create a product first' },
        ];
        const state = ribbonAction(registry({ registered: true, enabled: false, handlers }), action);
        expect(state?.enabled).toBe(false);
        expect(state?.title).toBe(`${action.title} — Open or create a product first`);
    });

    it('still says it is unavailable when no handler explains', () => {
        const handlers = [{ execute: () => undefined, disabledReason: () => undefined }];
        const state = ribbonAction(registry({ registered: true, enabled: false, handlers }), action);
        expect(state).toEqual({ enabled: false, title: `${action.title} — not available right now` });
    });

    it('asks the enablement and the reason with the action\'s own arguments', () => {
        const isEnabled = jest.fn((_id: string, ..._args: unknown[]) => false);
        const disabledReason = jest.fn((section: string) => `no ${section}`);
        const state = ribbonAction(
            { getCommand: () => ({}), isEnabled, getAllHandlers: () => [{ disabledReason }] },
            { ...action, args: ['composition'] },
        );
        expect(isEnabled).toHaveBeenCalledWith(action.command, 'composition');
        expect(disabledReason).toHaveBeenCalledWith('composition');
        expect(state?.title).toContain('no composition');
    });
});
