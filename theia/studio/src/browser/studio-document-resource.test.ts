import 'reflect-metadata';
import URI from '@theia/core/lib/common/uri';
import { ResourceError } from '@theia/core/lib/common/resource';
import { studioDocumentUri, STUDIO_DOCUMENT_SCHEME } from '../common/studio-document-uri';
import { StudioDocumentResourceResolver } from './studio-document-resource';
import { StudioApi } from './studio-api';

const ref = {
    workspaceId: '9f1b0f4a-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
    documentId: '11112222-3333-4444-5555-666677778888'
};
const expectedPath = `/studio-documents/v1/workspaces/${ref.workspaceId}/documents/${ref.documentId}`;

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    } as Response;
}

describe('StudioDocumentResourceResolver', () => {
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
        StudioApi.token = 'portal-token';
        fetchSpy = jest.spyOn(StudioApi, 'fetch');
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        StudioApi.token = '';
    });

    it('reads a document straight from the documents gear', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({ id: ref.documentId, content: '# Spec\n', updated_at: 't1' }));
        const resource = new StudioDocumentResourceResolver().resolve(studioDocumentUri(ref, 'App Spec'));

        await expect(resource.readContents()).resolves.toBe('# Spec\n');
        expect(fetchSpy).toHaveBeenCalledWith(expectedPath);
        expect(resource.version).toEqual({ updatedAt: 't1' });
    });

    it('writes the edited markdown back and reports the save', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({ id: ref.documentId, updated_at: 't2' }));
        const resolver = new StudioDocumentResourceResolver();
        const saved: unknown[] = [];
        resolver.onDidSaveDocument(event => saved.push(event));
        const resource = resolver.resolve(studioDocumentUri(ref, 'App Spec'));

        await resource.saveContents!('# Edited\n');

        expect(fetchSpy).toHaveBeenCalledWith(expectedPath, {
            method: 'PUT',
            body: JSON.stringify({ content: '# Edited\n' })
        });
        // The portal reloads the row off this event — without it the document
        // list keeps showing the copy it had before the hand-off.
        expect(saved).toEqual([ref]);
        expect(resource.version).toEqual({ updatedAt: 't2' });
    });

    it('reports a deleted document as NotFound, so the editor offers its conflict actions', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({}, 404));
        const resource = new StudioDocumentResourceResolver().resolve(studioDocumentUri(ref));

        expect.assertions(1);
        await resource.readContents().catch(error => {
            expect(ResourceError.NotFound.is(error)).toBe(true);
        });
    });

    it('fails a rejected save instead of reporting one that did not happen', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({}, 403));
        const resolver = new StudioDocumentResourceResolver();
        const saved: unknown[] = [];
        resolver.onDidSaveDocument(event => saved.push(event));
        const resource = resolver.resolve(studioDocumentUri(ref));

        await expect(resource.saveContents!('# Edited\n')).rejects.toThrow('HTTP 403');
        expect(saved).toEqual([]);
    });

    it('rejects a URI it does not own so the next resolver gets its turn', () => {
        const resolver = new StudioDocumentResourceResolver();
        expect(() => resolver.resolve(new URI('file:///workspace/repo/readme.md'))).toThrow();
        expect(() => resolver.resolve(new URI(`${STUDIO_DOCUMENT_SCHEME}:/incomplete`))).toThrow();
    });
});
