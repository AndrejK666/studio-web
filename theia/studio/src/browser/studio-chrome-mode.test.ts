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
        // thing that puts the panel in the LAYOUT, and the attribute is what
        // overrides the product's blanket paint rule.
        expect(preferences.set).toHaveBeenCalledWith('window.menuBarVisibility', 'classic', expect.anything());
        expect(document.body.dataset.studioMode).toBe('workbench');
    });

    it('takes the menu bar away while writing, but keeps the row it was in', async () => {
        const { contribution, preferences } = chrome('studio.documents');
        contribution.onDidInitializeLayout();
        await Promise.resolve();
        const css = document.getElementById('studio-chrome-mode')?.textContent ?? '';

        // The panel stays in the LAYOUT in both modes now: the collaboration
        // strip mounts into it, and a panel Theia has hidden paints nothing
        // however many heartbeats the strip runs.
        expect(preferences.set).toHaveBeenCalledWith('window.menuBarVisibility', 'classic', expect.anything());
        expect(document.body.dataset.studioMode).toBe('documents');
        expect(css).toContain('body[data-studio-mode="documents"] #theia-top-panel > .lm-MenuBar');
    });

    it('follows a switch', async () => {
        const { contribution, perspectives, preferences, listeners } = chrome('default');
        contribution.onDidInitializeLayout();
        await Promise.resolve();

        perspectives.activeId = 'studio.documents';
        listeners.forEach(fn => fn());
        await Promise.resolve();

        expect(document.body.dataset.studioMode).toBe('documents');
        expect(preferences.set).toHaveBeenLastCalledWith('window.menuBarVisibility', 'classic', expect.anything());
    });

    it('gives Source Control back to the workbench and not to writing', () => {
        const { contribution } = chrome('default');
        contribution.onDidInitializeLayout();
        const css = document.getElementById('studio-chrome-mode')?.textContent ?? '';
        // The product hides the SCM tab along with Debug, Test, Search and
        // Explorer. Right for a document, wrong for someone who just edited
        // code and wants to commit it.
        expect(css).toContain('body[data-studio-mode="workbench"] #shell-tab-scm-view-container');
        // Explorer stays hidden — Projects replaces it — and the others are not
        // part of this question.
        expect(css).not.toContain('explorer-view-container');
        expect(css).not.toContain('shell-tab-debug');
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
