import 'reflect-metadata';

// The handler's collaborators are the whole editor stack; what is under test is
// the NUMBER it answers with, which is how Theia picks between two editors.
jest.mock('./markdown-editor-widget', () => ({ MarkdownEditorWidget: class {} }));

import URI from '@theia/core/lib/common/uri';
import { DOCUMENTS_PERSPECTIVE_ID, MARKDOWN_PRIORITY, WORKBENCH_PERSPECTIVE_ID } from '../../common/studio-modes';
import { studioDocumentUri } from '../../common/studio-document-uri';
import { MarkdownEditorOpenHandler } from './markdown-editor-open-handler';

/** The competitors, as Theia sees them. */
const PRODUCT_EDITOR = 500; // studio-product-ext's handler, flat
const MONACO = 100;         // EditorManager.canHandle

function handlerIn(perspectiveId: string | undefined): MarkdownEditorOpenHandler {
    const handler = new MarkdownEditorOpenHandler();
    Object.defineProperty(handler, 'perspectives', {
        value: perspectiveId === undefined
            ? undefined
            : { getActivePerspectiveId: () => perspectiveId },
    });
    return handler;
}

const file = new URI('file:///workspace/repo/README.md');
const doc = studioDocumentUri(
    { workspaceId: '9f1b0f4a-2c3d-4e5f-8a9b-0c1d2e3f4a5b', documentId: '1111' },
    'App Spec',
);

describe('which editor takes a markdown file', () => {
    it('opens repository markdown itself in the workbench', () => {
        const priority = handlerIn(WORKBENCH_PERSPECTIVE_ID).canHandle(file);
        expect(priority).toBe(MARKDOWN_PRIORITY.preferred);
        expect(priority).toBeGreaterThan(PRODUCT_EDITOR);
    });

    it('stands aside for the product editor in the documents mode', () => {
        const priority = handlerIn(DOCUMENTS_PERSPECTIVE_ID).canHandle(file);
        expect(priority).toBe(MARKDOWN_PRIORITY.deferred);
        expect(priority).toBeLessThan(PRODUCT_EDITOR);
        // …but still ahead of plain text, so a build without the product
        // surface does not fall back to Monaco for documents.
        expect(priority).toBeGreaterThan(MONACO);
    });

    it('keeps a portal document in every mode', () => {
        // `studio-doc:` is not a file. Only this extension's resolver can read
        // one — the product handler matches the `.md` at the end of the URI and
        // would hand it to the file service, which has no provider for the
        // scheme.
        for (const mode of [WORKBENCH_PERSPECTIVE_ID, DOCUMENTS_PERSPECTIVE_ID]) {
            expect(handlerIn(mode).canHandle(doc)).toBe(MARKDOWN_PRIORITY.preferred);
        }
    });

    it('answers for markdown only', () => {
        expect(handlerIn(WORKBENCH_PERSPECTIVE_ID).canHandle(new URI('file:///workspace/a.ts'))).toBe(0);
        expect(handlerIn(WORKBENCH_PERSPECTIVE_ID).canHandle(new URI('file:///workspace/a.markdown')))
            .toBe(MARKDOWN_PRIORITY.preferred);
    });

    it('behaves as it always did where there are no perspectives at all', () => {
        expect(handlerIn(undefined).canHandle(file)).toBe(MARKDOWN_PRIORITY.preferred);
    });
});
