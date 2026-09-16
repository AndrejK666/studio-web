// The IDE half of the portal's "Edit in Studio" gesture: turn a document
// reference into an open markdown editor.
//
// Separate from the `studio-doc:` resolver on purpose. The resolver is pure
// transport (gear in, gear out) and stays clear of Theia's browser barrel, so
// it can be reasoned about — and tested — without a shell; opening is where the
// editor comes in.

import { inject, injectable } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core';
import { studioDocumentUri, StudioDocumentRef } from '../common/studio-document-uri';
import { MarkdownEditorOpenHandler } from './markdown-editor/markdown-editor-open-handler';

@injectable()
export class StudioDocumentOpener {

    @inject(MarkdownEditorOpenHandler)
    protected readonly markdownEditor: MarkdownEditorOpenHandler;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    /**
     * Deliberately bypasses `OpenerService`: the hand-off means "edit this
     * document", and the WYSIWYG markdown editor is what the portal promised —
     * not whichever handler happens to win the priority vote for a `.md` URI.
     */
    async open(ref: StudioDocumentRef, title?: string): Promise<void> {
        const uri = studioDocumentUri(ref, title);
        try {
            await this.markdownEditor.open(uri);
        } catch (error) {
            // The portal has already switched to this space, so failing
            // silently would look like the hand-off simply did nothing.
            const reason = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Studio: could not open the document — ${reason}`);
            throw error;
        }
    }
}
