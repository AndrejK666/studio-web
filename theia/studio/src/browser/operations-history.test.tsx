import 'reflect-metadata';
jest.mock('@theia/core/lib/browser/shell/view-contribution', () => ({
    AbstractViewContribution: class<T> {
        constructor(..._args: unknown[]) {}
        async openView(): Promise<T> {
            throw new Error('not used in this test');
        }
        registerCommands(): void {}
        registerMenus(): void {}
    }
}));
jest.mock('./audit-controller', () => ({
    AuditFrontendController: class {}
}));
import * as React from '@theia/core/shared/react';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { OperationsWidget } from './operations-widget';
import { OperationsCommand, OperationsContribution, OperationsFilterCommandPrefix } from './operations-contribution';
import { GitOperationsFrontendController } from './git-operations-contribution';
import { AuditFrontendController } from './audit-controller';

describe('OperationsWidget', () => {
    let widget: OperationsWidget;
    const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let previousReactActEnvironment: boolean | undefined;

    beforeAll(() => {
        previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        const controller = {
            onDidChange: jest.fn(() => ({ dispose() {} })),
            getEntries: jest.fn(() => [
                {
                    sequence: 4,
                    relativePath: 'docs/spec.md',
                    contentHash: 'a'.repeat(64),
                    sha: 'b'.repeat(40),
                    time: '2026-07-28T08:00:00.000Z',
                    outcome: 'failed'
                },
                {
                    sequence: 3,
                    relativePath: 'docs/pushed.md',
                    contentHash: 'c'.repeat(64),
                    sha: '',
                    time: '2026-07-28T07:00:00.000Z',
                    outcome: 'pushed'
                }
            ])
        };
        const module = new ContainerModule(bind => {
            bind(AuditFrontendController).toConstantValue(controller as unknown as AuditFrontendController);
            /* The panel carries the queue half too. This suite is about the
             * journal, so the queue is bound empty — it renders "No operations
             * yet" and stays out of the way. */
            bind(GitOperationsFrontendController).toConstantValue({
                onDidChange: () => ({ dispose: () => undefined }),
                getOperations: () => [],
                getRepositories: () => [],
                getSelectedRepository: () => undefined,
                isConnected: () => true,
                isScmUnavailable: () => false
            } as unknown as GitOperationsFrontendController);
            bind(OperationsWidget).toSelf();
        });
        const container = new Container();
        container.load(module);
        React.act(() => {
            widget = container.resolve<OperationsWidget>(OperationsWidget);
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

    it('renders only sanitized audit DTO fields and shows safe SHA absence', () => {
        const text = widget.node.textContent ?? '';
        expect(text).toContain('docs/spec.md');
        expect(text).toContain('b'.repeat(40));
        expect(text).toContain('Unavailable');
        expect(text).toContain('Failed');
        expect(text).not.toContain('token secret leaked');
        expect(text).not.toContain('op-1');
    });

    it('keeps the All badge equal to the sanitized entry count and filters by outcome', () => {
        expect(widget.node.querySelector('[data-testid="audit-badge-all"]')?.textContent).toBe('2');
        expect(widget.node.querySelector('[data-testid="audit-badge-failed"]')?.textContent).toBe('1');

        React.act(() => {
            widget.setFilter('failed');
            MessageLoop.flush();
        });

        expect(widget.node.querySelector('[data-testid="audit-row-4"]')).toBeTruthy();
        expect(widget.node.querySelector('[data-testid="audit-outcome-4"]')?.textContent).toBe('Failed');
        expect(widget.node.querySelector('[data-testid="audit-row-3"]')).toBeFalsy();
    });

    it('registers stable, labeled Audit commands that remain keyboard-command accessible', async () => {
        const contribution = new OperationsContribution(
            { bindRuntime: jest.fn() } as never,
            {} as never
        );
        const openView = jest.spyOn(contribution, 'openView').mockResolvedValue(widget);
        const commands = { registerCommand: jest.fn() };

        contribution.registerCommands(commands as never);

        const registered = commands.registerCommand.mock.calls.map(([command]) => command);
        expect(registered).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: `${OperationsFilterCommandPrefix}failed`, label: 'Operations: Failed' })
        ]));
        expect(OperationsCommand).toEqual({ id: 'studio:operations:toggle', label: 'Operations' });

        const [, handler] = commands.registerCommand.mock.calls.find(
            ([command]) => command.id === `${OperationsFilterCommandPrefix}failed`
        ) ?? [];
        await handler.execute();

        expect(openView).toHaveBeenCalledWith({ activate: false, reveal: true });
        expect(widget.getFilter()).toBe('failed');
    });
});
