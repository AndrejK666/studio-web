import { inject, injectable } from '@theia/core/shared/inversify';
import { Navigatable } from '@theia/core/lib/browser/navigatable-types';
import { Saveable } from '@theia/core/lib/browser/saveable';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { DisposableCollection, Emitter, Event } from '@theia/core/lib/common';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextDocumentChangeEvent, TextEditor } from '@theia/editor/lib/browser/editor';

export type AnalyzeMetricKey = 'readiness' | 'gap' | 'contradiction' | 'bloat' | 'checklist';
export type AnalyzeMetricDirection = 'higher-better' | 'lower-better';
export type AnalyzeStatus = 'empty' | 'loading' | 'stale' | 'current';
export type AnalyzeMetricLevel = 'Good' | 'Attention' | 'Risk';

export interface AnalyzeTrendPoint {
    readonly date: string;
    readonly value: number;
}

export interface AnalyzeMetric {
    readonly key: AnalyzeMetricKey;
    readonly label: string;
    readonly score: number;
    readonly unit: '%';
    readonly direction: AnalyzeMetricDirection;
    readonly level: AnalyzeMetricLevel;
    readonly definition: string;
    readonly interpretation: string;
    readonly ariaText: string;
    readonly trend: readonly AnalyzeTrendPoint[];
}

export interface AnalyzeViewModel {
    readonly status: AnalyzeStatus;
    readonly analysisLabel: 'Mock analysis';
    readonly documentUri?: string;
    readonly documentLabel?: string;
    readonly analyzedAt?: string;
    readonly emptyStateTitle?: string;
    readonly emptyStateDescription?: string;
    readonly tokenUsage: number;
    readonly metrics: readonly AnalyzeMetric[];
}

type EditorLike = {
    readonly uri?: { toString(): string };
    readonly document?: { uri?: { toString(): string } };
    readonly onDocumentContentChanged?: (listener: (event: TextDocumentChangeEvent) => void) => { dispose(): void };
};

type WidgetLike = {
    readonly id?: string;
};

type DocumentLike = {
    readonly widget: unknown;
    readonly uri: string;
    readonly label: string;
    onContentChanged(listener: () => void): { dispose(): void };
};

export interface AnalyzeApplicationShellLike {
    readonly activeWidget: unknown;
    onDidChangeActiveWidget(listener: () => void): { dispose(): void };
}

export const AnalyzeApplicationShellProvider = Symbol('AnalyzeApplicationShellProvider');
export type AnalyzeApplicationShellProvider = () => AnalyzeApplicationShellLike;

type PersistedAnalyzeState = {
    status: Exclude<AnalyzeStatus, 'empty' | 'loading'>;
    analyzedAt: string;
};

type PendingAnalyzeRequest = {
    readonly generation: number;
    readonly documentUri: string;
    readonly resolve: () => void;
    readonly timer: ReturnType<typeof setTimeout>;
};

const ANALYZE_DELAY_MS = 120;
export const ANALYZE_WIDGET_ID = 'studio:analyze';
const METRIC_DEFINITIONS: ReadonlyArray<{
    key: AnalyzeMetricKey;
    label: string;
    direction: AnalyzeMetricDirection;
    min: number;
    max: number;
    definition: string;
}> = [
    { key: 'readiness', label: 'Readiness', direction: 'higher-better', min: 61, max: 96, definition: 'Actionability of the current document.' },
    { key: 'gap', label: 'Gap', direction: 'lower-better', min: 9, max: 38, definition: 'Distance between the current draft and expected coverage.' },
    { key: 'contradiction', label: 'Contradiction', direction: 'lower-better', min: 6, max: 24, definition: 'Conflict pressure between claims in the document.' },
    { key: 'bloat', label: 'Bloat', direction: 'lower-better', min: 12, max: 44, definition: 'Amount of excess material relative to the stated scope.' },
    { key: 'checklist', label: 'Checklist', direction: 'higher-better', min: 68, max: 99, definition: 'Completion of explicit review and delivery criteria.' }
];

@injectable()
export class AnalyzeFrontendController implements FrontendApplicationContribution {
    @inject(EditorManager)
    protected readonly editorManager!: EditorManager;

    @inject(AnalyzeApplicationShellProvider)
    protected readonly applicationShellProvider!: AnalyzeApplicationShellProvider;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    protected readonly toDispose = new DisposableCollection(this.onDidChangeEmitter);
    protected readonly editorListener = new DisposableCollection();
    protected documentListener = new DisposableCollection();
    protected readonly persistedStateByUri = new Map<string, PersistedAnalyzeState>();
    protected currentDocument: DocumentLike | undefined;
    protected currentGeneration = 0;
    protected pendingRequest: PendingAnalyzeRequest | undefined;
    protected started = false;
    protected stopped = false;
    protected viewModel: AnalyzeViewModel = this.createEmptyViewModel();

    get onDidChange(): Event<void> {
        return this.onDidChangeEmitter.event;
    }

    async onStart(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        this.stopped = false;
        this.toDispose.push(this.editorListener);
        this.toDispose.push(this.documentListener);
        this.editorListener.push(this.editorManager.onCurrentEditorChanged(() => this.syncActiveEditor()));
        this.editorListener.push(this.applicationShellProvider().onDidChangeActiveWidget(() => this.syncActiveEditor()));
        this.syncActiveEditor();
    }

    onStop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.currentGeneration += 1;
        this.clearPendingRequest();
        this.toDispose.dispose();
    }

    getViewModel(): AnalyzeViewModel {
        return this.viewModel;
    }

    async analyze(): Promise<void> {
        const document = this.currentDocument;
        if (!document) {
            this.setViewModel(this.createEmptyViewModel());
            return;
        }
        const documentUri = document.uri;
        const persistedState = this.getOrCreatePersistedState(documentUri);
        const generation = ++this.currentGeneration;
        this.clearPendingRequest();
        this.setViewModel({
            ...this.createDocumentViewModel(document, persistedState),
            status: 'loading',
            analyzedAt: persistedState.analyzedAt
        });

        await new Promise<void>(resolve => {
            const request: PendingAnalyzeRequest = {
                generation,
                documentUri,
                resolve,
                timer: setTimeout(() => {
                    if (this.pendingRequest !== request) {
                        return;
                    }
                    this.pendingRequest = undefined;
                    const nextPersistedState = this.getOrCreatePersistedState(documentUri);
                    nextPersistedState.status = 'current';
                    nextPersistedState.analyzedAt = new Date().toISOString();
                    if (!this.stopped
                        && generation === this.currentGeneration
                        && this.currentDocument
                        && this.currentDocument.uri === documentUri) {
                        this.setViewModel(this.createDocumentViewModel(this.currentDocument, nextPersistedState));
                    }
                    resolve();
                }, ANALYZE_DELAY_MS)
            };
            this.pendingRequest = request;
        });
    }

    protected syncActiveEditor(): void {
        this.handleDocumentChangedFromShell(this.resolveActiveDocument());
    }

    protected resolveActiveDocument(): DocumentLike | undefined {
        const activeWidget = this.applicationShellProvider().activeWidget;
        if (this.isAnalyzeWidget(activeWidget)) {
            return this.currentDocument;
        }
        const activeDocument = this.normalizeDocument(activeWidget);
        if (activeDocument) {
            return activeDocument;
        }
        if (!activeWidget) {
            return this.normalizeDocument(this.editorManager.currentEditor);
        }
        return undefined;
    }

    protected handleDocumentChangedFromShell(document: DocumentLike | undefined): void {
        if (this.currentDocument?.widget === document?.widget) {
            return;
        }
        this.currentGeneration += 1;
        this.clearPendingRequest();
        this.resetDocumentListener();
        this.currentDocument = document;
        if (!document) {
            this.setViewModel(this.createEmptyViewModel());
            return;
        }
        const persistedState = this.getOrCreatePersistedState(document.uri);
        this.documentListener.push(document.onContentChanged(() => this.handleTrackedDocumentChanged(document)));
        this.setViewModel(this.createDocumentViewModel(document, persistedState));
    }

    protected handleTrackedDocumentChanged(document: DocumentLike): void {
        if (this.stopped || this.currentDocument?.widget !== document.widget || this.viewModel.status === 'empty') {
            return;
        }
        const persistedState = this.getOrCreatePersistedState(document.uri);
        persistedState.status = 'stale';
        this.currentGeneration += 1;
        this.clearPendingRequest();
        this.setViewModel(this.createDocumentViewModel(document, persistedState));
    }

    protected setViewModel(next: AnalyzeViewModel): void {
        this.viewModel = next;
        this.onDidChangeEmitter.fire(undefined);
    }

    protected createEmptyViewModel(): AnalyzeViewModel {
        return {
            status: 'empty',
            analysisLabel: 'Mock analysis',
            emptyStateTitle: 'No active text document',
            emptyStateDescription: 'Open a text editor to inspect mock analysis.',
            metrics: [],
            tokenUsage: 0
        };
    }

    protected createDocumentViewModel(document: DocumentLike, persistedState: PersistedAnalyzeState): AnalyzeViewModel {
        const seed = this.hashString(document.uri);
        return {
            status: persistedState.status,
            analysisLabel: 'Mock analysis',
            documentUri: document.uri,
            documentLabel: document.label,
            analyzedAt: persistedState.analyzedAt,
            tokenUsage: 700 + seed % 1800,
            metrics: METRIC_DEFINITIONS.map((definition, index) => {
                const metricSeed = this.rotateSeed(seed, index + 1);
                const score = this.scale(metricSeed, definition.min, definition.max);
                const level = this.getMetricLevel(score, definition.direction);
                const interpretation = this.buildInterpretation(definition.key, score, level, definition.direction);
                return {
                    key: definition.key,
                    label: definition.label,
                    unit: '%',
                    direction: definition.direction,
                    score,
                    level,
                    definition: definition.definition,
                    interpretation,
                    ariaText: this.buildMetricAriaText(definition.label, score, level, definition.direction, definition.definition, interpretation),
                    trend: this.buildTrend(score, definition.direction, metricSeed)
                };
            })
        };
    }

    protected buildTrend(score: number, direction: AnalyzeMetricDirection, seed: number): readonly AnalyzeTrendPoint[] {
        const dates = this.buildWeeklyDates();
        const volatility = 18 + seed % 12;
        return dates.map((date, index) => {
            if (index === dates.length - 1) {
                return { date, value: score };
            }
            const distance = dates.length - 1 - index;
            const baseline = direction === 'higher-better'
                ? score - distance * 3
                : score + distance * 3;
            const wave = ((seed >>> (index % 16)) & 0b111) - 3;
            const adjustment = Math.round((distance / dates.length) * volatility * 0.35) + wave;
            const rawValue = direction === 'higher-better'
                ? baseline - adjustment
                : baseline + adjustment;
            return {
                date,
                value: Math.max(0, Math.min(100, rawValue))
            };
        });
    }

    protected buildWeeklyDates(): readonly string[] {
        const current = new Date();
        const end = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()));
        return Array.from({ length: 12 }, (_, index) => {
            const pointDate = new Date(end);
            pointDate.setUTCDate(end.getUTCDate() - (11 - index) * 7);
            return pointDate.toISOString().slice(0, 10);
        });
    }

    protected getMetricLevel(score: number, direction: AnalyzeMetricDirection): AnalyzeMetricLevel {
        if (direction === 'higher-better') {
            if (score <= 49) {
                return 'Risk';
            }
            if (score <= 74) {
                return 'Attention';
            }
            return 'Good';
        }
        if (score <= 24) {
            return 'Good';
        }
        if (score <= 49) {
            return 'Attention';
        }
        return 'Risk';
    }

    protected buildInterpretation(
        key: AnalyzeMetricKey,
        score: number,
        level: AnalyzeMetricLevel,
        direction: AnalyzeMetricDirection
    ): string {
        switch (key) {
            case 'readiness':
                return level === 'Good'
                    ? 'Strong readiness across the last 12 weekly checkpoints.'
                    : level === 'Attention'
                        ? 'Readiness is improving but still needs reinforcement before delivery.'
                        : 'Readiness remains too low for a confident handoff.';
            case 'gap':
                return level === 'Good'
                    ? 'Coverage gaps are limited and still trending down.'
                    : level === 'Attention'
                        ? 'Coverage gaps remain visible and should be closed soon.'
                        : 'Coverage gaps are still materially above the target range.';
            case 'contradiction':
                return level === 'Good'
                    ? 'Contradictions are low and continue to fall.'
                    : level === 'Attention'
                        ? 'Contradictions are manageable but still need cleanup.'
                        : 'Contradictions are high enough to threaten document trust.';
            case 'bloat':
                return level === 'Good'
                    ? 'Scope remains controlled with little excess material.'
                    : level === 'Attention'
                        ? 'Bloat is improving but still above the good threshold.'
                        : 'Bloat is high enough to obscure the core message.';
            case 'checklist':
                return level === 'Good'
                    ? 'Checklist completion is consistently strong.'
                    : level === 'Attention'
                        ? 'Checklist completion is uneven and should be tightened.'
                        : 'Checklist completion is too low to support release confidence.';
            default:
                return direction === 'higher-better'
                    ? `This score is ${score}% and still below the desired range.`
                    : `This score is ${score}% and still above the desired range.`;
        }
    }

    protected buildMetricAriaText(
        label: string,
        score: number,
        level: AnalyzeMetricLevel,
        direction: AnalyzeMetricDirection,
        definition: string,
        interpretation: string
    ): string {
        return `${label}: ${score}% (${level}). ${direction === 'higher-better' ? 'Higher is better.' : 'Lower is better.'} ${definition} ${interpretation}`;
    }

    protected scale(seed: number, min: number, max: number): number {
        return min + seed % (max - min + 1);
    }

    protected hashString(value: string): number {
        let hash = 0;
        for (let index = 0; index < value.length; index += 1) {
            hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
        }
        return hash;
    }

    protected rotateSeed(seed: number, offset: number): number {
        return ((seed >>> offset) ^ (seed << (32 - offset))) >>> 0;
    }

    protected getDocumentLabel(uri: string): string {
        const segments = uri.split('/');
        return decodeURIComponent(segments[segments.length - 1] || uri);
    }

    protected getOrCreatePersistedState(documentUri: string): PersistedAnalyzeState {
        const existing = this.persistedStateByUri.get(documentUri);
        if (existing) {
            return existing;
        }
        const created: PersistedAnalyzeState = {
            status: 'current',
            analyzedAt: new Date().toISOString()
        };
        this.persistedStateByUri.set(documentUri, created);
        return created;
    }

    protected isAnalyzeWidget(candidate: unknown): boolean {
        return Boolean(candidate && typeof candidate === 'object' && (candidate as WidgetLike).id === ANALYZE_WIDGET_ID);
    }

    protected clearPendingRequest(): void {
        const pendingRequest = this.pendingRequest;
        if (!pendingRequest) {
            return;
        }
        this.pendingRequest = undefined;
        clearTimeout(pendingRequest.timer);
        pendingRequest.resolve();
    }

    protected resetDocumentListener(): void {
        this.documentListener.dispose();
        this.documentListener = new DisposableCollection();
        this.toDispose.push(this.documentListener);
    }

    protected normalizeDocument(candidate: unknown): DocumentLike | undefined {
        const textEditor = this.normalizeTextEditor(candidate);
        if (textEditor) {
            const uri = textEditor.document.uri.toString();
            return {
                widget: textEditor,
                uri,
                label: this.getDocumentLabel(uri),
                onContentChanged: listener => textEditor.onDocumentContentChanged(() => listener())
            };
        }

        if (candidate && Navigatable.is(candidate)) {
            const resourceUri = candidate.getResourceUri();
            const saveable = Saveable.get(candidate);
            if (resourceUri && saveable) {
                const uri = resourceUri.toString();
                return {
                    widget: candidate,
                    uri,
                    label: this.getDocumentLabel(uri),
                    onContentChanged: listener => saveable.onContentChanged(() => listener())
                };
            }
        }

        return undefined;
    }

    /**
     * A widget's text editor, if that is what it has.
     *
     * THE FIRST BRANCH USED TO TRUST THE NAME. `if (editorLike.editor) return
     * editorLike.editor` accepts whatever a widget happens to call `editor`,
     * and the caller immediately reads `.document.uri` off it — so a widget
     * whose `editor` is something else throws `Cannot read properties of
     * undefined (reading 'uri')`. The product has exactly such a widget: the
     * Markdown editor's `this.editor` is a TipTap `Editor`, which keeps its
     * document at `state.doc` and has no `document` at all.
     *
     * It threw on every activation of a Markdown tab, which is most of what
     * this product opens — nine times in one session on the dev stand, from
     * `onActiveChanged`. Nothing downstream noticed, because the throw
     * happened before there was anything to notice with.
     *
     * So both branches now ask the same question, which is the one the second
     * branch was already asking: does this thing have a `document` and can it
     * report a change to it? A Markdown widget answers no and is left alone —
     * it is not a `TextEditor`, and it was never going to be analyzed as one.
     */
    protected normalizeTextEditor(candidate: unknown): TextEditor | undefined {
        if (!candidate || typeof candidate !== 'object') {
            return undefined;
        }
        const editorLike = candidate as EditorLike & { readonly editor?: unknown };
        return this.asTextEditor(editorLike.editor) ?? this.asTextEditor(candidate);
    }

    /** A `TextEditor` by what it carries, never by what it is called. */
    protected asTextEditor(candidate: unknown): TextEditor | undefined {
        if (!candidate || typeof candidate !== 'object') {
            return undefined;
        }
        const editorLike = candidate as EditorLike;
        return editorLike.document && typeof editorLike.onDocumentContentChanged === 'function'
            ? (candidate as TextEditor)
            : undefined;
    }
}
