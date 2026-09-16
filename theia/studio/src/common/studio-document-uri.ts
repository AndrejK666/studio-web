// Addressing for a **portal document** inside the IDE.
//
// A document is not a file. It lives in the `studio-documents` gear, keyed by
// (workspace tenant, document id), and the portal used to be the only place
// that could edit one — a plain textarea, next to an IDE that could not reach
// it. Giving the document a URI is what lets the IDE treat it as an ordinary
// editable resource (`studio-doc:` resolver in
// `browser/studio-document-resource.ts`) and open it in the markdown editor,
// so "edit this document" stops being a different tool from "edit this file".
//
// Layout: `studio-doc:/{workspaceId}/{documentId}/{slug}.md`
//
// The trailing filename carries no identity — it exists so the tab shows the
// document's title and so `.md`-based editor routing works unchanged. Identity
// is the first two segments, which is why a rename never invalidates an open
// editor's address.
//
// In `common/` because both the resource resolver and the markdown editor's
// open handler need it, and a shared constant is cheaper than a cycle.

import URI from '@theia/core/lib/common/uri';

export const STUDIO_DOCUMENT_SCHEME = 'studio-doc';

/** How the documents gear addresses a document. */
export interface StudioDocumentRef {
    /** The workspace TENANT that stores the document — not the project tenant
     *  the session was opened against; a project shows documents that belong
     *  to its parent workspace. */
    readonly workspaceId: string;
    readonly documentId: string;
}

/** Filename-safe stem for a document title. Never empty, so the URI always
 *  ends in a resolvable `<name>.md`. */
export function studioDocumentSlug(title: string | undefined): string {
    const slug = (title ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug || 'document';
}

/** Build the editor address for a document. */
export function studioDocumentUri(ref: StudioDocumentRef, title?: string): URI {
    const workspaceId = encodeURIComponent(ref.workspaceId);
    const documentId = encodeURIComponent(ref.documentId);
    return new URI(`${STUDIO_DOCUMENT_SCHEME}:/${workspaceId}/${documentId}/${studioDocumentSlug(title)}.md`);
}

/** The inverse — `undefined` for any URI this scheme does not own, so callers
 *  can use it as the membership test as well. */
export function parseStudioDocumentUri(uri: URI): StudioDocumentRef | undefined {
    if (uri.scheme !== STUDIO_DOCUMENT_SCHEME) {
        return undefined;
    }
    const segments = uri.path.toString().split('/').filter(segment => segment.length > 0);
    if (segments.length < 2) {
        return undefined;
    }
    const workspaceId = decodeURIComponent(segments[0]);
    const documentId = decodeURIComponent(segments[1]);
    if (!workspaceId || !documentId) {
        return undefined;
    }
    return { workspaceId, documentId };
}

/** True for any URI the documents resolver owns. */
export function isStudioDocumentUri(uri: URI): boolean {
    return parseStudioDocumentUri(uri) !== undefined;
}
