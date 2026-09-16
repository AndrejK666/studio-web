import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { Disposable, DisposableCollection } from '@theia/core';
import { NavigatableWidgetOpenHandler, NavigatableWidgetOptions, OpenWithService, OpenWithHandler, WidgetOpenerOptions } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { isStudioDocumentUri } from '../../common/studio-document-uri';
import { DOCUMENTS_PERSPECTIVE_ID, MARKDOWN_PRIORITY } from '../../common/studio-modes';
import { MarkdownEditorWidget } from './markdown-editor-widget';

@injectable()
export class MarkdownEditorOpenHandler extends NavigatableWidgetOpenHandler<MarkdownEditorWidget> {
    static readonly ID = 'studio.markdownEditor';
    static readonly LABEL = 'Markdown WYSIWYG Editor';

    readonly id = MarkdownEditorOpenHandler.ID;

    // Optional so the handler still works in a shell that has no perspective
    // service at all — a test harness, or an application built without it.
    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    protected openWithDisposable: { dispose(): void } | undefined;
    protected readonly toDispose = new DisposableCollection();

    get currentWidget(): MarkdownEditorWidget | undefined {
        const current = this.shell.currentWidget;
        return current instanceof MarkdownEditorWidget ? current : undefined;
    }

    canHandle(uri: URI): number {
        // A portal document is not a file: only this extension's resolver can
        // read one, in any mode. See MARKDOWN_PRIORITY.
        if (isStudioDocumentUri(uri)) {
            return MARKDOWN_PRIORITY.preferred;
        }
        if (!this.canOpen(uri)) {
            return 0;
        }
        return this.perspectives?.getActivePerspectiveId() === DOCUMENTS_PERSPECTIVE_ID
            ? MARKDOWN_PRIORITY.deferred
            : MARKDOWN_PRIORITY.preferred;
    }

    async registerOpenWith(openWithService: OpenWithService): Promise<void> {
        this.openWithDisposable?.dispose();
        this.openWithDisposable = openWithService.registerHandler(this.createOpenWithHandler());
        this.toDispose.push(Disposable.create(() => {
            this.openWithDisposable?.dispose();
            this.openWithDisposable = undefined;
        }));
    }

    protected createOpenWithHandler(): OpenWithHandler {
        return {
            id: this.id,
            label: MarkdownEditorOpenHandler.LABEL,
            providerName: 'Studio',
            canHandle: uri => this.canHandle(uri),
            getOrder: uri => this.canHandle(uri) + 1000,
            open: uri => this.open(uri)
        };
    }

    protected override createWidgetOptions(uri: URI, options?: WidgetOpenerOptions): NavigatableWidgetOptions {
        return super.createWidgetOptions(uri, options);
    }

    protected canOpen(uri: URI): boolean {
        // A portal document is markdown by definition — it has no other form,
        // so the scheme alone decides (its URI does end in `.md`, but that is
        // a display detail of the address, not a claim about a file on disk).
        if (isStudioDocumentUri(uri)) {
            return true;
        }
        if (uri.scheme !== 'file') {
            return false;
        }
        const extension = uri.path.ext.toLowerCase();
        return extension === '.md' || extension === '.markdown';
    }

    dispose(): void {
        this.toDispose.dispose();
    }
}
