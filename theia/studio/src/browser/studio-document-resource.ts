// `studio-doc:` — portal documents as ordinary editable resources.
//
// The IDE reads and writes them straight through the `studio-documents` gear
// (same session gate, same portal-issued token as every other Studio call), so
// there is no local copy, no export/import step and nothing to reconcile: the
// portal's document list and the IDE's editor are two views of one row.
//
// That is the whole point of the seam this removes. Editing a document used to
// mean "open the IDE" and then, separately, "edit the document" — in the
// portal, in a textarea, because the IDE had no way to address the thing. With
// a resolver it is one gesture from either side.
//
// Conflicts: the gear's PUT carries no version, so this resource does not
// claim optimistic concurrency. It reports `version` from the row's
// `updated_at` for the editor's own external-change detection (the markdown
// editor compares it and offers Compare / Reload / Keep Local), and last
// write wins if two sessions really do race.

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';
import URI from '@theia/core/lib/common/uri';
import { Resource, ResourceError, ResourceResolver, ResourceVersion } from '@theia/core/lib/common/resource';
import { parseStudioDocumentUri, StudioDocumentRef } from '../common/studio-document-uri';
import { StudioApi } from './studio-api';

/** The slice of the gear's document DTO this resource needs. */
interface StudioDocumentDto {
    readonly id: string;
    readonly content?: string;
    readonly updated_at?: string;
}

/** `updated_at` as the editor's opaque version marker. */
interface StudioDocumentVersion extends ResourceVersion {
    readonly updatedAt: string | undefined;
}

function documentPath(ref: StudioDocumentRef): string {
    return `/studio-documents/v1/workspaces/${encodeURIComponent(ref.workspaceId)}` +
        `/documents/${encodeURIComponent(ref.documentId)}`;
}

/**
 * Wait for the portal's API token before the first request.
 *
 * A hand-off always arrives after `studio.init`, so the token is there. A tab
 * RESTORED from the saved layout is not: Theia rebuilds it on load, which can
 * beat the portal's handshake, and an unauthenticated read would leave a
 * permanently broken editor where a moment's wait gives a working one.
 */
async function awaitPortalToken(timeoutMs = 30_000, pollMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!StudioApi.token && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
    }
}

export class StudioDocumentResource implements Resource {

    protected lastVersion: StudioDocumentVersion | undefined;

    constructor(
        readonly uri: URI,
        protected readonly ref: StudioDocumentRef,
        protected readonly onSaved: (ref: StudioDocumentRef) => void,
    ) { }

    get version(): ResourceVersion | undefined {
        return this.lastVersion;
    }

    async readContents(): Promise<string> {
        await awaitPortalToken();
        const response = await StudioApi.fetch(documentPath(this.ref));
        if (response.status === 404) {
            throw ResourceError.NotFound({
                message: `Studio document ${this.ref.documentId} no longer exists.`,
                data: { uri: this.uri }
            });
        }
        if (!response.ok) {
            throw new Error(`Could not read Studio document (HTTP ${response.status}).`);
        }
        const document = await response.json() as StudioDocumentDto;
        this.lastVersion = { updatedAt: document.updated_at };
        return document.content ?? '';
    }

    async saveContents(content: string): Promise<void> {
        await awaitPortalToken();
        const response = await StudioApi.fetch(documentPath(this.ref), {
            method: 'PUT',
            body: JSON.stringify({ content }),
        });
        if (response.status === 404) {
            throw ResourceError.NotFound({
                message: `Studio document ${this.ref.documentId} no longer exists.`,
                data: { uri: this.uri }
            });
        }
        if (!response.ok) {
            // 403 is the expected shape here: a document inherited from the
            // workspace is read-only where it is shown.
            throw new Error(`Could not save Studio document (HTTP ${response.status}).`);
        }
        const document = await response.json().catch(() => undefined) as StudioDocumentDto | undefined;
        this.lastVersion = { updatedAt: document?.updated_at };
        this.onSaved(this.ref);
    }

    dispose(): void {
        /* nothing held open — every read and write is a request */
    }
}

@injectable()
export class StudioDocumentResourceResolver implements ResourceResolver {

    protected readonly onDidSaveDocumentEmitter = new Emitter<StudioDocumentRef>();

    /** Fires after the IDE has written a document back to the gear. The portal
     *  bridge forwards it so the portal re-reads the row instead of showing
     *  the copy it had before the hand-off. */
    readonly onDidSaveDocument: Event<StudioDocumentRef> = this.onDidSaveDocumentEmitter.event;

    resolve(uri: URI): Resource {
        const ref = parseStudioDocumentUri(uri);
        if (!ref) {
            // Contract: a resolver rejects what it does not own, so the next
            // one in the chain gets its turn.
            throw new Error(`Not a Studio document URI: ${uri.toString()}`);
        }
        return new StudioDocumentResource(uri, ref, saved => this.onDidSaveDocumentEmitter.fire(saved));
    }
}
