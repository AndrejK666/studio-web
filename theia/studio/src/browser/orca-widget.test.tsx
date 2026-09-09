// The Agents panel's Changes section: it is the only place that says what an
// agent actually did, and the click on a row is the only way out of the panel
// into the code. Both are asserted here, and the click deliberately checks the
// path that reaches the opener — a `file://${path}` template would send a
// Windows drive letter through as a host and open nothing.

import 'reflect-metadata';
// Same reason the other widget tests do this: the real module imports the
// @theia/core/lib/browser barrel, whose common-frontend-contribution calls
// document.queryCommandSupported at load time — absent from this jsdom.
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class {}
}));
import * as React from '@theia/core/shared/react';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { MessageService } from '@theia/core/lib/common/message-service';
import { OpenerService } from '@theia/core/lib/browser/opener-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import URI from '@theia/core/lib/common/uri';
import { OrcaService, type OrcaWorktree, type OrcaWorktreeChange } from '../common/orca-protocol';
import { OrcaWidget } from './orca-widget';

const worktree: OrcaWorktree = {
    id: 'wt-1',
    path: '/workspace/.orca/feature-x',
    branch: 'feature-x',
    displayName: 'feature-x',
    comment: 'add the thing',
    status: 'in-progress',
    isMain: false
};

describe('OrcaWidget changes', () => {
    let widget: OrcaWidget;
    let opened: URI[];
    let changes: OrcaWorktreeChange[];
    const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let previousReactActEnvironment: boolean | undefined;

    beforeAll(() => {
        previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(async () => {
        opened = [];
        changes = [
            { code: ' M', path: 'src/app.ts', absolutePath: '/workspace/.orca/feature-x/src/app.ts' },
            { code: '??', path: 'docs/notes.md', absolutePath: '/workspace/.orca/feature-x/docs/notes.md' }
        ];
        const orca = {
            status: async () => ({ reachable: true, state: 'ready', desktopRunning: false }),
            currentWorktree: async () => undefined,
            listWorktrees: async () => [worktree],
            listTerminals: async () => [],
            changes: async (path: string) => (path === worktree.path ? changes : []),
            registerWorkspace: async () => undefined,
            createTask: async () => undefined,
            startAgent: async () => undefined,
            send: async () => undefined,
            interrupt: async () => undefined,
            waitForIdle: async () => 'idle' as const,
            read: async () => ''
        };
        const module = new ContainerModule(bind => {
            bind(OrcaService).toConstantValue(orca as never);
            bind(MessageService).toConstantValue({ error: jest.fn(), info: jest.fn() } as never);
            bind(WorkspaceService).toConstantValue({ roots: Promise.resolve([]) } as never);
            bind(OpenerService).toConstantValue({
                getOpener: async (uri: URI) => ({ open: async () => opened.push(uri) })
            } as never);
            bind(OrcaWidget).toSelf();
        });
        const container = new Container();
        container.load(module);
        React.act(() => {
            widget = container.resolve<OrcaWidget>(OrcaWidget);
            MessageLoop.flush();
        });
        // The panel loads on attach; nothing is attached in a unit test, so the
        // load is driven directly and the render asserted against its result.
        await React.act(async () => {
            await (widget as unknown as { refresh(): Promise<void> }).refresh();
            MessageLoop.flush();
        });
    });

    afterEach(() => {
        React.act(() => {
            widget.dispose();
            MessageLoop.flush();
        });
    });

    afterAll(() => {
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
    });

    it('lists what the agent changed in the selected worktree', () => {
        const text = widget.node.textContent ?? '';
        expect(text).toContain('src/app.ts');
        expect(text).toContain('docs/notes.md');
        // The porcelain code is shown trimmed, so ' M' reads as 'M'.
        const codes = Array.from(widget.node.querySelectorAll('.studio-orca-change-code'))
            .map(node => node.textContent);
        expect(codes).toEqual(['M', '??']);
    });

    it('opens the file the row names, by its absolute path', async () => {
        const rows = widget.node.querySelectorAll<HTMLElement>('.studio-orca-changes > li');
        expect(rows).toHaveLength(2);

        await React.act(async () => {
            rows[0].click();
            MessageLoop.flush();
        });

        expect(opened).toHaveLength(1);
        // The path, in its POSIX form: `fsPath()` would answer with backslashes
        // when the test itself runs on Windows, which says nothing about what
        // the editor was asked to open.
        expect(opened[0].path.toString()).toBe('/workspace/.orca/feature-x/src/app.ts');
        expect(opened[0].scheme).toBe('file');
    });

    it('says a clean worktree is clean instead of rendering an empty list', async () => {
        changes = [];
        await React.act(async () => {
            await (widget as unknown as { loadSelection(): Promise<void> }).loadSelection();
            widget.update();
            MessageLoop.flush();
        });

        expect(widget.node.textContent).toContain('Nothing uncommitted');
        expect(widget.node.querySelectorAll('.studio-orca-changes > li')).toHaveLength(0);
    });
});
