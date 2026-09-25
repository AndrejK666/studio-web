import 'reflect-metadata';

import { DOCUMENTS_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID, ORCA_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID } from '../common/studio-modes';
import { ARCHITECT_PERSPECTIVE_ID, MODES, roleOf } from './studio-mode-bar';

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
