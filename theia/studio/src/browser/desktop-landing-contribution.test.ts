// When the landing page is put in the main area and taken away, Help → Welcome,
// and the placeholder's quiet about workspace source suggestions.

import 'reflect-metadata';
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class {}
}));
jest.mock('./portal-bridge-contribution', () => ({
    IDENTITY_VIEWER_COMMAND_ID: 'studio.identity.viewer'
}));
import { DesktopLandingContribution, DesktopStartFolderGate, DesktopWelcomeCommand } from './desktop-landing-contribution';
import type { WorkspaceRepositorySuggestion } from '../common/workspace-protocol';

const START = 'C:\\Users\\me\\ConstructorStudio\\workspace';

function fakeStatus(body: unknown | undefined): void {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => (body === undefined
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => body }) as Response);
}

function workspaceAt(root: string | undefined) {
    return {
        tryGetRoots: () => (root ? [{ resource: { path: { fsPath: () => root } } }] : []),
        onWorkspaceChanged: jest.fn(),
    };
}

function harness(root: string | undefined) {
    const widget = {
        id: 'studio.desktop.landing',
        isAttached: false,
        title: { closable: true },
        close: jest.fn(),
        showOnboarding: jest.fn(),
        disposed: { connect: jest.fn() },
    };
    let created = false;
    const contribution = new DesktopLandingContribution();
    const shell = {
        addWidget: jest.fn(async () => { widget.isAttached = true; }),
        activateWidget: jest.fn(async () => widget),
    };
    Object.assign(contribution as object, {
        widgets: {
            tryGetWidget: () => (created ? widget : undefined),
            getOrCreateWidget: async () => { created = true; return widget; },
        },
        shell,
        workspaceService: workspaceAt(root),
    });
    const commands = new Map<string, { execute: () => Promise<void> }>();
    contribution.registerCommands({ registerCommand: (c: { id: string }, h: { execute: () => Promise<void> }) => commands.set(c.id, h) } as never);
    return { contribution, widget, shell, run: (id: string) => commands.get(id)!.execute(), setCreated: () => { created = true; } };
}

describe('the landing in the main area', () => {
    it('takes the main area in the placeholder, focused, and cannot be closed there', async () => {
        fakeStatus({ enabled: true, state: 'signed-out', startFolder: START });
        const h = harness(START);
        await h.contribution.ensure(true);
        expect(h.shell.addWidget).toHaveBeenCalledWith(h.widget, { area: 'main' });
        expect(h.shell.activateWidget).toHaveBeenCalledWith('studio.desktop.landing');
        expect(h.widget.title.closable).toBe(false);
    });

    it('is taken away when a real project is open, so the start page is back', async () => {
        fakeStatus({ enabled: true, state: 'signed-in', startFolder: START });
        const h = harness('C:\\Users\\me\\ConstructorStudio\\workspaces\\Gears');
        h.setCreated(); // restored with the last layout
        await h.contribution.ensure(true);
        expect(h.shell.addWidget).not.toHaveBeenCalled();
        expect(h.widget.close).toHaveBeenCalled();
    });

    it('is put back after a mode switch dropped it, without taking the focus', async () => {
        fakeStatus({ enabled: true, state: 'signed-in', startFolder: START });
        const h = harness(START);
        await h.contribution.ensure(false);
        expect(h.shell.addWidget).toHaveBeenCalledTimes(1);
        expect(h.shell.activateWidget).not.toHaveBeenCalled();
    });

    it('Help → Welcome opens it in a project too, closable there, with the onboarding back', async () => {
        fakeStatus({ enabled: true, state: 'signed-in', startFolder: START });
        const h = harness('D:\\code\\my-app');
        await h.run(DesktopWelcomeCommand.id);
        expect(h.shell.activateWidget).toHaveBeenCalled();
        expect(h.widget.title.closable).toBe(true);
        expect(h.widget.showOnboarding).toHaveBeenCalled();
        // Opened by hand: a folder change does not take it away.
        await h.contribution.ensure(false);
        expect(h.widget.close).not.toHaveBeenCalled();
    });
});

describe('the workspace source suggestion in the placeholder', () => {
    const suggestion = (rootPath: string): WorkspaceRepositorySuggestion => ({
        suggestionId: 's', kind: 'containing-repository', candidateId: 'c', label: 'workspace',
        localPath: rootPath, rootPath, disposition: 'new', reason: '',
    });
    const gate = (root: string) => Object.assign(new DesktopStartFolderGate(), { workspaceService: workspaceAt(root) });

    it('is not raised for the placeholder folder', async () => {
        fakeStatus({ enabled: true, state: 'signed-out', startFolder: START });
        expect(await gate(START).suppresses(suggestion(START))).toBe(true);
    });

    it('is raised for any other folder, and wherever the desktop does not name a start folder', async () => {
        fakeStatus({ enabled: true, state: 'signed-out', startFolder: START });
        expect(await gate('D:\\code\\my-app').suppresses(suggestion('D:\\code'))).toBe(false);
        fakeStatus(undefined);
        expect(await gate(START).suppresses(suggestion(START))).toBe(false);
    });
});
