import 'reflect-metadata';
import { StudioModeStatus } from './studio-mode-status';

/** The status bar, reduced to what it was asked to show. */
function statusBar() {
    const elements = new Map<string, any>();
    return {
        elements,
        setElement: jest.fn(async (id: string, entry: unknown) => void elements.set(id, entry)),
        removeElement: jest.fn(async (id: string) => void elements.delete(id)),
    };
}

function status(perspectives: unknown, bar = statusBar()) {
    const contribution = new StudioModeStatus();
    Object.defineProperty(contribution, 'statusBar', { value: bar });
    Object.defineProperty(contribution, 'perspectives', { value: perspectives });
    return { contribution, bar };
}

const TWO = [{ id: 'default', label: 'Workbench' }, { id: 'studio.documents', label: 'Documents' }];

function service(active: { id: string; label: string }, registered = TWO) {
    const listeners: (() => void)[] = [];
    return {
        listeners,
        getActivePerspective: () => active,
        getRegisteredPerspectives: () => registered,
        onDidChangePerspective: (fn: () => void) => {
            listeners.push(fn);
            return { dispose: () => undefined };
        },
    };
}

describe('the mode, where it can be seen', () => {
    it('names the mode you are in and switches on a click', async () => {
        const { contribution, bar } = status(service(TWO[1]));
        contribution.onDidInitializeLayout();
        await Promise.resolve();

        const entry = bar.elements.get('studio-workbench-mode');
        expect(entry.text).toContain('Documents');
        // Theia's own command — the one the palette hides behind
        // "Experimental", and the menu bar this session does not have.
        expect(entry.command).toBe('perspective.switch');
        expect(entry.tooltip).toMatch(/switch/i);
    });

    it('follows the mode when it changes', async () => {
        const perspectives = service(TWO[0]);
        const { contribution, bar } = status(perspectives);
        contribution.onDidInitializeLayout();
        await Promise.resolve();
        expect(bar.elements.get('studio-workbench-mode').text).toContain('Workbench');

        perspectives.getActivePerspective = () => TWO[1];
        perspectives.listeners.forEach(fn => fn());
        await Promise.resolve();
        expect(bar.elements.get('studio-workbench-mode').text).toContain('Documents');
    });

    it('says nothing when there is nothing to choose between', async () => {
        // One mode is not a choice, and an indicator for it is noise.
        const { contribution, bar } = status(service(TWO[0], [TWO[0]]));
        contribution.onDidInitializeLayout();
        await Promise.resolve();
        expect(bar.elements.has('studio-workbench-mode')).toBe(false);
    });

    it('stays quiet in an application without perspectives', () => {
        const { contribution, bar } = status(undefined);
        contribution.onDidInitializeLayout();
        expect(bar.setElement).not.toHaveBeenCalled();
    });
});
