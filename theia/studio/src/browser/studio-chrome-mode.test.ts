import 'reflect-metadata';
import { StudioChromeMode } from './studio-chrome-mode';

function chrome(activeId: string) {
    const listeners: (() => void)[] = [];
    const perspectives = {
        activeId,
        getActivePerspectiveId(): string { return this.activeId; },
        onDidChangePerspective: (fn: () => void) => {
            listeners.push(fn);
            return { dispose: () => undefined };
        },
    };
    const preferences = { set: jest.fn(async () => undefined) };
    const contribution = new StudioChromeMode();
    Object.defineProperty(contribution, 'perspectives', { value: perspectives });
    Object.defineProperty(contribution, 'preferences', { value: preferences });
    return { contribution, perspectives, preferences, listeners };
}

afterEach(() => {
    document.getElementById('studio-chrome-mode')?.remove();
    delete document.body.dataset.studioMode;
});

describe('the chrome a mode implies', () => {
    it('keeps Theia’s own menu bar in the workbench', async () => {
        const { contribution, preferences } = chrome('default');
        contribution.onDidInitializeLayout();
        await Promise.resolve();

        // Both levers, because two systems decide: the preference is the only
        // thing that puts the panel back in the LAYOUT, and the attribute is
        // what overrides the product's blanket paint rule.
        expect(preferences.set).toHaveBeenCalledWith('window.menuBarVisibility', 'classic', expect.anything());
        expect(document.body.dataset.studioMode).toBe('workbench');
    });

    it('takes it away while writing, layout and all', async () => {
        const { contribution, preferences } = chrome('studio.documents');
        contribution.onDidInitializeLayout();
        await Promise.resolve();

        expect(preferences.set).toHaveBeenCalledWith('window.menuBarVisibility', 'hidden', expect.anything());
        expect(document.body.dataset.studioMode).toBe('documents');
    });

    it('follows a switch', async () => {
        const { contribution, perspectives, preferences, listeners } = chrome('default');
        contribution.onDidInitializeLayout();
        await Promise.resolve();

        perspectives.activeId = 'studio.documents';
        listeners.forEach(fn => fn());
        await Promise.resolve();

        expect(document.body.dataset.studioMode).toBe('documents');
        expect(preferences.set).toHaveBeenLastCalledWith('window.menuBarVisibility', 'hidden', expect.anything());
    });

    it('beats the product’s paint rule on specificity, not on order', () => {
        const { contribution } = chrome('default');
        contribution.onDidInitializeLayout();
        const css = document.getElementById('studio-chrome-mode')?.textContent ?? '';
        // (0,2,1) against #theia-top-panel's (0,1,0): whichever stylesheet is
        // injected first, this one decides.
        expect(css).toContain('body[data-studio-mode="workbench"] #theia-top-panel');
        expect(css).toContain('display: flex !important');
    });

    it('does nothing in an application without perspectives', () => {
        const contribution = new StudioChromeMode();
        Object.defineProperty(contribution, 'perspectives', { value: undefined });
        contribution.onDidInitializeLayout();
        expect(document.getElementById('studio-chrome-mode')).toBeNull();
    });
});
