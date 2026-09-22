import 'reflect-metadata';
jest.mock('@theia/core/lib/browser', () => ({
    ApplicationShell: class ApplicationShell {}
}));
jest.mock('@theia/editor/lib/browser/editor-manager', () => ({
    EditorManager: class EditorManager {}
}));
import URI from '@theia/core/lib/common/uri';
import { Emitter } from '@theia/core/lib/common';
import type { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextEditor, TextDocumentChangeEvent } from '@theia/editor/lib/browser/editor';
import type { AnalyzeMetricKey, AnalyzeViewModel } from './analyze-controller';
import { ANALYZE_WIDGET_ID, AnalyzeFrontendController } from './analyze-controller';

type GaugeLevel = 'Good' | 'Attention' | 'Risk';

type GaugeTrendPoint = {
    readonly date: string;
    readonly value: number;
};

type GaugeMetric = {
    readonly key: AnalyzeMetricKey;
    readonly label: string;
    readonly score: number;
    readonly unit: '%';
    readonly direction: 'higher-better' | 'lower-better';
    readonly level: GaugeLevel;
    readonly definition: string;
    readonly interpretation: string;
    readonly ariaText: string;
    readonly trend: readonly GaugeTrendPoint[];
};

type GaugeAnalyzeViewModel = Omit<AnalyzeViewModel, 'metrics'> & {
    readonly metrics: readonly GaugeMetric[];
};

describe('AnalyzeFrontendController', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-28T09:00:00.000Z'));
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    it('selects deterministic mock analysis by editor URI and updates when the current editor changes', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const firstEditor = createEditor('file:///workspace/alpha.md');
        const secondEditor = createEditor('file:///workspace/beta.md');
        const shell = createShell(activeWidgetEvents, firstEditor.editor);
        const editorManager = createEditorManager(editorEvents, firstEditor.editor);
        const controller = createController(editorManager, shell);

        await controller.onStart();

        const firstSnapshot = controller.getViewModel();
        expect(firstSnapshot.status).toBe('current');
        expect(firstSnapshot.analysisLabel).toBe('Mock analysis');
        expect(firstSnapshot.documentUri).toBe(firstEditor.uri.toString());
        expect(firstSnapshot.documentLabel).toBe('alpha.md');

        const gaugeSnapshot = firstSnapshot as unknown as GaugeAnalyzeViewModel;
        expect(gaugeSnapshot.metrics).toHaveLength(5);
        expect(gaugeSnapshot.metrics.map(metric => metric.key)).toEqual([
            'readiness',
            'gap',
            'contradiction',
            'bloat',
            'checklist'
        ]);
        expectGaugeMetric(gaugeSnapshot.metrics[0], {
            key: 'readiness',
            label: 'Readiness',
            direction: 'higher-better',
            expectedLevel: 'Good'
        });
        expectGaugeMetric(gaugeSnapshot.metrics[1], {
            key: 'gap',
            label: 'Gap',
            direction: 'lower-better',
            expectedLevel: 'Good'
        });
        expectGaugeMetric(gaugeSnapshot.metrics[2], {
            key: 'contradiction',
            label: 'Contradiction',
            direction: 'lower-better',
            expectedLevel: 'Good'
        });
        expectGaugeMetric(gaugeSnapshot.metrics[3], {
            key: 'bloat',
            label: 'Bloat',
            direction: 'lower-better',
            expectedLevel: 'Attention'
        });
        expectGaugeMetric(gaugeSnapshot.metrics[4], {
            key: 'checklist',
            label: 'Checklist',
            direction: 'higher-better',
            expectedLevel: 'Good'
        });
        expect(gaugeSnapshot.metrics[0].trend.map(point => point.date)).toEqual([
            '2026-05-12',
            '2026-05-19',
            '2026-05-26',
            '2026-06-02',
            '2026-06-09',
            '2026-06-16',
            '2026-06-23',
            '2026-06-30',
            '2026-07-07',
            '2026-07-14',
            '2026-07-21',
            '2026-07-28'
        ]);
        expect(gaugeSnapshot.metrics[0].trend[gaugeSnapshot.metrics[0].trend.length - 1]).toEqual({
            date: '2026-07-28',
            value: gaugeSnapshot.metrics[0].score
        });

        shell.activeWidget = secondEditor.editor;
        editorManager.currentEditor = secondEditor.editor;
        editorEvents.fire(secondEditor.editor);
        activeWidgetEvents.fire();

        const secondSnapshot = controller.getViewModel();
        expect(secondSnapshot.status).toBe('current');
        expect(secondSnapshot.documentUri).toBe(secondEditor.uri.toString());
        expect(secondSnapshot.documentLabel).toBe('beta.md');
        expect(secondSnapshot.metrics).not.toEqual(firstSnapshot.metrics);
        expect(secondSnapshot.tokenUsage).not.toBe(firstSnapshot.tokenUsage);

        shell.activeWidget = firstEditor.editor;
        editorManager.currentEditor = firstEditor.editor;
        editorEvents.fire(firstEditor.editor);
        activeWidgetEvents.fire();

        const restoredSnapshot = controller.getViewModel();
        expect(restoredSnapshot.documentUri).toBe(firstEditor.uri.toString());
        expect(restoredSnapshot.metrics).toEqual(firstSnapshot.metrics);
        expect(restoredSnapshot.tokenUsage).toBe(firstSnapshot.tokenUsage);
    });

    it('marks analysis stale after document changes and refreshes through loading to a new timestamp', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const activeEditor = createEditor('file:///workspace/spec.md');
        const shell = createShell(activeWidgetEvents, activeEditor.editor);
        const editorManager = createEditorManager(editorEvents, activeEditor.editor);
        const controller = createController(editorManager, shell);

        await controller.onStart();
        const initialTimestamp = controller.getViewModel().analyzedAt;

        jest.setSystemTime(new Date('2026-07-28T09:05:00.000Z'));
        activeEditor.changeEvents.fire(createDocumentChangeEvent(activeEditor.document, 'changed'));

        expect(controller.getViewModel().status).toBe('stale');

        const refreshPromise = controller.analyze();
        expect(controller.getViewModel().status).toBe('loading');

        jest.runOnlyPendingTimers();
        await refreshPromise;

        const refreshed = controller.getViewModel();
        expect(refreshed.status).toBe('current');
        expect(refreshed.analyzedAt).not.toBe(initialTimestamp);
        expect(refreshed.analyzedAt).toBe('2026-07-28T09:05:00.120Z');
        expect(refreshed.documentUri).toBe(activeEditor.uri.toString());
    });

    it('reports an honest empty state when there is no current text editor', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const shell = createShell(activeWidgetEvents, undefined);
        const editorManager = createEditorManager(editorEvents, undefined);
        const controller = createController(editorManager, shell);

        await controller.onStart();

        expect(controller.getViewModel()).toMatchObject({
            status: 'empty',
            analysisLabel: 'Mock analysis',
            emptyStateTitle: 'No active text document',
            emptyStateDescription: 'Open a text editor to inspect mock analysis.'
        });
        expect(controller.getViewModel().documentUri).toBeUndefined();
        expect(controller.getViewModel().documentLabel).toBeUndefined();
    });

    it('shows empty for unrelated non-editor widgets but retains the document while the analyze widget is active', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const activeEditor = createEditor('file:///workspace/spec.md');
        const shell = createShell(activeWidgetEvents, activeEditor.editor);
        const editorManager = createEditorManager(editorEvents, activeEditor.editor);
        const controller = createController(editorManager, shell);

        await controller.onStart();
        expect(controller.getViewModel().documentUri).toBe(activeEditor.uri.toString());

        shell.activeWidget = { id: ANALYZE_WIDGET_ID };
        activeWidgetEvents.fire();
        expect(controller.getViewModel().documentUri).toBe(activeEditor.uri.toString());
        expect(controller.getViewModel().status).toBe('current');

        shell.activeWidget = { id: 'terminal' };
        activeWidgetEvents.fire();
        expect(controller.getViewModel().status).toBe('empty');
        expect(controller.getViewModel().documentUri).toBeUndefined();
    });

    /* The product's OWN Markdown editor, which is not the fixture above: it is a
       plain Widget whose `editor` is a TipTap `Editor`, and it implements
       neither Navigatable nor Saveable. Reading `.document.uri` off whatever a
       widget calls `editor` threw on every activation of a Markdown tab — nine
       times in one session on the dev stand — and the analyze panel is not even
       the thing that broke, because the throw beat it to the question. */
    it('leaves alone a widget whose "editor" is not a text editor', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const tiptapLike = { id: 'studio-md:file:///workspace/AGENTS.md', editor: { state: { doc: {} }, commands: {} } };
        const shell = createShell(activeWidgetEvents, tiptapLike);
        const editorManager = createEditorManager(editorEvents, undefined);
        const controller = createController(editorManager, shell);

        await expect(controller.onStart()).resolves.not.toThrow();
        expect(controller.getViewModel().status).toBe('empty');
        expect(controller.getViewModel().documentUri).toBeUndefined();
    });

    it('recognizes a markdown-like navigatable saveable widget and tracks stale changes', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const markdownWidget = createMarkdownLikeWidget('file:///workspace/notes.md');
        const shell = createShell(activeWidgetEvents, markdownWidget.widget);
        const editorManager = createEditorManager(editorEvents, undefined);
        const controller = createController(editorManager, shell);

        await controller.onStart();

        expect(controller.getViewModel().status).toBe('current');
        expect(controller.getViewModel().documentUri).toBe(markdownWidget.uri.toString());
        expect(controller.getViewModel().documentLabel).toBe('notes.md');

        markdownWidget.changeEvents.fire(undefined);

        expect(controller.getViewModel().status).toBe('stale');
        expect(markdownWidget.listenerDisposable.dispose).not.toHaveBeenCalled();
    });

    it('disposes markdown-like widget subscriptions when switching away and on stop', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const markdownWidget = createMarkdownLikeWidget('file:///workspace/notes.md');
        const textEditor = createEditor('file:///workspace/spec.md');
        const shell = createShell(activeWidgetEvents, markdownWidget.widget);
        const editorManager = createEditorManager(editorEvents, textEditor.editor);
        const controller = createController(editorManager, shell);

        await controller.onStart();

        shell.activeWidget = textEditor.editor;
        activeWidgetEvents.fire();
        expect(markdownWidget.listenerDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(controller.getViewModel().documentUri).toBe(textEditor.uri.toString());

        controller.onStop();

        expect(textEditor.listenerDisposable.dispose).toHaveBeenCalledTimes(1);
    });

    it('settles superseded analyze requests and canceled requests deterministically', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const activeEditor = createEditor('file:///workspace/spec.md');
        const shell = createShell(activeWidgetEvents, activeEditor.editor);
        const editorManager = createEditorManager(editorEvents, activeEditor.editor);
        const controller = createController(editorManager, shell);

        await controller.onStart();

        let firstSettled = false;
        const firstAnalyze = controller.analyze().then(() => {
            firstSettled = true;
        });
        const secondAnalyze = controller.analyze();

        await Promise.resolve();
        expect(controller.getViewModel().status).toBe('loading');
        await expect(firstAnalyze).resolves.toBeUndefined();
        expect(firstSettled).toBe(true);

        shell.activeWidget = { id: 'navigator' };
        activeWidgetEvents.fire();
        await secondAnalyze;

        expect(controller.getViewModel().status).toBe('empty');
        await firstAnalyze;
    });

    it('persists stale freshness when switching away from and back to a document', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const firstEditor = createEditor('file:///workspace/alpha.md');
        const secondEditor = createEditor('file:///workspace/beta.md');
        const shell = createShell(activeWidgetEvents, firstEditor.editor);
        const editorManager = createEditorManager(editorEvents, firstEditor.editor);
        const controller = createController(editorManager, shell);

        await controller.onStart();

        firstEditor.changeEvents.fire(createDocumentChangeEvent(firstEditor.document, 'changed'));
        expect(controller.getViewModel().status).toBe('stale');

        shell.activeWidget = secondEditor.editor;
        editorManager.currentEditor = secondEditor.editor;
        editorEvents.fire(secondEditor.editor);
        activeWidgetEvents.fire();
        expect(controller.getViewModel().documentUri).toBe(secondEditor.uri.toString());
        expect(controller.getViewModel().status).toBe('current');

        shell.activeWidget = firstEditor.editor;
        editorManager.currentEditor = firstEditor.editor;
        editorEvents.fire(firstEditor.editor);
        activeWidgetEvents.fire();
        expect(controller.getViewModel().documentUri).toBe(firstEditor.uri.toString());
        expect(controller.getViewModel().status).toBe('stale');
    });

    it('invalidates edit-during-loading so the in-flight analysis settles without publishing current', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const activeEditor = createEditor('file:///workspace/spec.md');
        const shell = createShell(activeWidgetEvents, activeEditor.editor);
        const editorManager = createEditorManager(editorEvents, activeEditor.editor);
        const controller = createController(editorManager, shell);

        await controller.onStart();

        const analyzePromise = controller.analyze();
        expect(controller.getViewModel().status).toBe('loading');

        jest.advanceTimersByTime(60);
        activeEditor.changeEvents.fire(createDocumentChangeEvent(activeEditor.document, 'edited while loading'));
        await analyzePromise;

        expect(controller.getViewModel().status).toBe('stale');
        jest.runOnlyPendingTimers();
        expect(controller.getViewModel().status).toBe('stale');
    });

    it('disposes editor subscriptions when switching editors and stopping', async () => {
        const editorEvents = new Emitter<TextEditor | undefined>();
        const activeWidgetEvents = new Emitter<void>();
        const firstEditor = createEditor('file:///workspace/first.md');
        const secondEditor = createEditor('file:///workspace/second.md');
        const shell = createShell(activeWidgetEvents, firstEditor.editor);
        const editorManager = createEditorManager(editorEvents, firstEditor.editor);
        const controller = createController(editorManager, shell);

        await controller.onStart();

        shell.activeWidget = secondEditor.editor;
        editorManager.currentEditor = secondEditor.editor;
        editorEvents.fire(secondEditor.editor);
        activeWidgetEvents.fire();
        expect(firstEditor.listenerDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(secondEditor.listenerDisposable.dispose).not.toHaveBeenCalled();

        controller.onStop();

        expect(editorManager.listenerDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(shell.listenerDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(secondEditor.listenerDisposable.dispose).toHaveBeenCalledTimes(1);

        secondEditor.changeEvents.fire(createDocumentChangeEvent(secondEditor.document, 'ignored after stop'));
        expect(controller.getViewModel().status).toBe('current');
    });
});

function createController(
    editorManager: ReturnType<typeof createEditorManager>,
    applicationShell: ReturnType<typeof createShell>
): AnalyzeFrontendController {
    const controller = new AnalyzeFrontendController();
    Object.defineProperty(controller, 'editorManager', { value: editorManager as unknown as EditorManager });
    Object.defineProperty(controller, 'applicationShellProvider', { value: () => applicationShell });
    return controller;
}

function createShell(activeWidgetEvents: Emitter<void>, activeWidget: unknown) {
    const listenerDisposable = { dispose: jest.fn() };
    return {
        activeWidget,
        listenerDisposable,
        onDidChangeActiveWidget: jest.fn(listener => {
            const disposable = activeWidgetEvents.event(listener);
            return {
                dispose: jest.fn(() => {
                    disposable.dispose();
                    listenerDisposable.dispose();
                })
            };
        })
    };
}

function createEditorManager(editorEvents: Emitter<TextEditor | undefined>, currentEditor: TextEditor | undefined) {
    const listenerDisposable = { dispose: jest.fn() };
    return {
        currentEditor,
        listenerDisposable,
        onCurrentEditorChanged: jest.fn(listener => {
            const disposable = editorEvents.event(listener);
            return {
                dispose: jest.fn(() => {
                    disposable.dispose();
                    listenerDisposable.dispose();
                })
            };
        })
    };
}

function createEditor(uriString: string) {
    const uri = new URI(uriString);
    const changeEvents = new Emitter<TextDocumentChangeEvent>();
    const listenerDisposable = { dispose: jest.fn() };
    const document = {
        uri,
        getText: () => '# Document',
        dispose: jest.fn()
    };
    const editor: Partial<TextEditor> = {
        uri,
        document: document as unknown as TextEditor['document'],
        onDocumentContentChanged: listener => {
            const disposable = changeEvents.event(listener);
            return {
                dispose: jest.fn(() => {
                    disposable.dispose();
                    listenerDisposable.dispose();
                })
            };
        }
    };
    return {
        uri,
        document,
        editor: editor as TextEditor,
        changeEvents,
        listenerDisposable
    };
}

function createMarkdownLikeWidget(uriString: string) {
    const uri = new URI(uriString);
    const changeEvents = new Emitter<void>();
    const listenerDisposable = { dispose: jest.fn() };
    const onContentChanged = jest.fn(listener => {
        const disposable = changeEvents.event(listener);
        return {
            dispose: jest.fn(() => {
                disposable.dispose();
                listenerDisposable.dispose();
            })
        };
    });
    const saveable = {
        dirty: false,
        onDirtyChanged: jest.fn(() => ({ dispose: jest.fn() })),
        onContentChanged
    };
    return {
        uri,
        changeEvents,
        listenerDisposable,
        widget: {
            saveable,
            getResourceUri: () => uri,
            createMoveToUri: (resourceUri: URI) => resourceUri
        }
    };
}

function createDocumentChangeEvent(
    document: ReturnType<typeof createEditor>['document'],
    text: string
): TextDocumentChangeEvent {
    return {
        document: document as unknown as TextDocumentChangeEvent['document'],
        contentChanges: [{ range: undefined as never, rangeLength: 0, text }]
    };
}

function expectGaugeMetric(
    metric: GaugeMetric,
    expectation: {
        readonly key: AnalyzeMetricKey;
        readonly label: string;
        readonly direction: 'higher-better' | 'lower-better';
        readonly expectedLevel: GaugeLevel;
    }
): void {
    expect(metric.key).toBe(expectation.key);
    expect(metric.label).toBe(expectation.label);
    expect(metric.unit).toBe('%');
    expect(metric.direction).toBe(expectation.direction);
    expect(metric.level).toBe(expectation.expectedLevel);
    expect(metric.definition).toMatch(/\.$/);
    expect(metric.interpretation).toMatch(/\.$/);
    expect(metric.ariaText).toContain(metric.label);
    expect(metric.ariaText).toContain(`${metric.score}%`);
    expect(metric.ariaText).toContain(expectation.expectedLevel);
    expect(metric.ariaText).toContain(expectation.direction === 'higher-better' ? 'Higher is better' : 'Lower is better');
    expect(metric.trend).toHaveLength(12);
    expect(metric.trend.every(point => /\d{4}-\d{2}-\d{2}/.test(point.date))).toBe(true);
    expect(metric.trend.every((point, index, all) => index === 0 || Date.parse(point.date) - Date.parse(all[index - 1].date) === 7 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(metric.trend[metric.trend.length - 1]?.value).toBe(metric.score);

    if (expectation.direction === 'higher-better') {
        expect(metric.level).toBe(metric.score <= 49 ? 'Risk' : metric.score <= 74 ? 'Attention' : 'Good');
    } else {
        expect(metric.level).toBe(metric.score <= 24 ? 'Good' : metric.score <= 49 ? 'Attention' : 'Risk');
    }
}
