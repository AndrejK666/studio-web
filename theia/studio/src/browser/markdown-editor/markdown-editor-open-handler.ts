import { injectable } from '@theia/core/shared/inversify';
import { Disposable, DisposableCollection } from '@theia/core';
import { NavigatableWidgetOpenHandler, NavigatableWidgetOptions, OpenWithService, OpenWithHandler, WidgetOpenerOptions } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { isStudioDocumentUri } from '../../common/studio-document-uri';
import { MarkdownEditorWidget } from './markdown-editor-widget';

@injectable()
export class MarkdownEditorOpenHandler extends NavigatableWidgetOpenHandler<MarkdownEditorWidget> {
    static readonly ID = 'studio.markdownEditor';
    static readonly LABEL = 'Markdown WYSIWYG Editor';

    readonly id = MarkdownEditorOpenHandler.ID;

    protected openWithDisposable: { dispose(): void } | undefined;
    protected readonly toDispose = new DisposableCollection();

    get currentWidget(): MarkdownEditorWidget | undefined {
        const current = this.shell.currentWidget;
        return current instanceof MarkdownEditorWidget ? current : undefined;
    }

    canHandle(uri: URI): number {
        return this.canOpen(uri) ? 600 : 0;
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
