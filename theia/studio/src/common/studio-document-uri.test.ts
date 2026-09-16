import URI from '@theia/core/lib/common/uri';
import {
    isStudioDocumentUri,
    parseStudioDocumentUri,
    studioDocumentSlug,
    studioDocumentUri,
    STUDIO_DOCUMENT_SCHEME
} from './studio-document-uri';

describe('studio document URIs', () => {
    const ref = {
        workspaceId: '9f1b0f4a-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
        documentId: '11112222-3333-4444-5555-666677778888'
    };

    it('addresses a document by workspace and id, with the title only as a label', () => {
        const uri = studioDocumentUri(ref, 'App Spec');
        expect(uri.toString()).toBe(
            `${STUDIO_DOCUMENT_SCHEME}:/${ref.workspaceId}/${ref.documentId}/app-spec.md`
        );
        expect(uri.path.base).toBe('app-spec.md');
        expect(parseStudioDocumentUri(uri)).toEqual(ref);
    });

    it('keeps the same identity when the title changes, so a rename does not orphan an open editor', () => {
        expect(parseStudioDocumentUri(studioDocumentUri(ref, 'Before')))
            .toEqual(parseStudioDocumentUri(studioDocumentUri(ref, 'After')));
    });

    it('always produces a resolvable .md name', () => {
        expect(studioDocumentSlug(undefined)).toBe('document');
        expect(studioDocumentSlug('   ')).toBe('document');
        expect(studioDocumentSlug('!!!')).toBe('document');
        expect(studioDocumentSlug('Release Notes — v2')).toBe('release-notes-v2');
        expect(studioDocumentSlug('x'.repeat(200)).length).toBe(60);
    });

    it('rejects URIs it does not own', () => {
        expect(parseStudioDocumentUri(new URI('file:///workspace/repo/readme.md'))).toBeUndefined();
        expect(isStudioDocumentUri(new URI('file:///workspace/repo/readme.md'))).toBe(false);
        // Scheme alone is not an address: both ids are required.
        expect(parseStudioDocumentUri(new URI(`${STUDIO_DOCUMENT_SCHEME}:/only-one-segment`))).toBeUndefined();
    });
});
