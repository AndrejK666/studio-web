// The Extensions tab comes back in the code modes of the desktop app.

import 'reflect-metadata';
import { Emitter } from '@theia/core/lib/common/event';
import { FULL_PERSPECTIVE_ID, DOCUMENTS_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID } from '../common/studio-modes';
import { DesktopExtensionsPlacement, EXTENSIONS_VIEW_CONTAINER_ID } from './desktop-extensions-placement';

function setup(active: string, left: string[] = []) {
    const changed = new Emitter<string>();
    let current = active;
    const leftIds = [...left];
    const view = { id: EXTENSIONS_VIEW_CONTAINER_ID };
    const shell = {
        getWidgets: jest.fn(() => leftIds.map(id => ({ id }))),
        addWidget: jest.fn(async (widget: { id: string }) => { leftIds.push(widget.id); }),
    };
    const widgets = { getOrCreateWidget: jest.fn(async () => view) };
    const perspectives = { getActivePerspectiveId: () => current, onDidChangePerspective: changed.event };
    const placement = new DesktopExtensionsPlacement();
    Object.defineProperty(placement, 'shell', { value: shell });
    Object.defineProperty(placement, 'widgets', { value: widgets });
    Object.defineProperty(placement, 'perspectives', { value: perspectives });
    const switchTo = (id: string): void => { current = id; changed.fire(id); };
    return { placement, shell, widgets, switchTo, leftIds };
}

describe('the Extensions view on the desktop', () => {
    it('is placed on the left, unopened, in Full when the layout lacks it', async () => {
        const { placement, shell } = setup(FULL_PERSPECTIVE_ID, ['explorer-view-container']);
        await placement.place();
        expect(shell.addWidget).toHaveBeenCalledWith({ id: EXTENSIONS_VIEW_CONTAINER_ID }, { area: 'left', rank: 500 });
    });

    it('is placed in Workbench too', async () => {
        const { placement, shell } = setup(WORKBENCH_PERSPECTIVE_ID);
        await placement.place();
        expect(shell.addWidget).toHaveBeenCalledTimes(1);
    });

    it('is left alone where it already is', async () => {
        const { placement, shell } = setup(FULL_PERSPECTIVE_ID, [EXTENSIONS_VIEW_CONTAINER_ID]);
        await placement.place();
        expect(shell.addWidget).not.toHaveBeenCalled();
    });

    it('is not added to the writing mode', async () => {
        const { placement, shell, widgets } = setup(DOCUMENTS_PERSPECTIVE_ID);
        await placement.place();
        expect(widgets.getOrCreateWidget).not.toHaveBeenCalled();
        expect(shell.addWidget).not.toHaveBeenCalled();
    });

    it('comes back after a switch into a code mode whose saved layout dropped it', async () => {
        const { placement, shell, switchTo } = setup(DOCUMENTS_PERSPECTIVE_ID);
        placement.onDidInitializeLayout();
        switchTo(FULL_PERSPECTIVE_ID);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(shell.addWidget).toHaveBeenCalledTimes(1);
        placement.onStop();
    });

    it('costs only a warning when the view cannot be made', async () => {
        const { placement, widgets, shell } = setup(FULL_PERSPECTIVE_ID);
        widgets.getOrCreateWidget.mockRejectedValueOnce(new Error('no factory'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        await expect(placement.place()).resolves.toBeUndefined();
        expect(shell.addWidget).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});
