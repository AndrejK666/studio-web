// What this session is called, according to the portal.
//
// The IDE opens `/workspace`, so every surface that names the root by its
// directory says "workspace" — the Projects panel, the status line, the search
// scope. That is the container's word for it, not the product's: the person
// launched a project called "Studioweb" and is looking at a folder called
// workspace.
//
// Only the portal knows the real name, so it sends it with the handshake and
// this holds it. A LabelProviderContribution then answers for the root, which
// is what Theia's file navigator (the Projects panel) asks.
//
// Deliberately not derived from the workspace id or fetched from a gear: the
// portal has the name in hand when it mounts the session, and a second lookup
// would be a second source that can disagree.

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';
import URI from '@theia/core/lib/common/uri';
import { DidChangeLabelEvent, LabelProviderContribution } from '@theia/core/lib/browser/label-provider';
import { FileStatNode } from '@theia/filesystem/lib/browser/file-tree/file-tree';

@injectable()
export class StudioWorkspaceName implements LabelProviderContribution {

    protected readonly onDidChangeEmitter = new Emitter<DidChangeLabelEvent>();
    protected name: string | undefined;
    protected rootUri: string | undefined;

    get onDidChange(): Event<DidChangeLabelEvent> {
        return this.onDidChangeEmitter.event;
    }

    /** Told by the portal bridge, once per handshake. */
    setName(name: string | undefined, rootUri?: string): void {
        const next = name?.trim() || undefined;
        if (next === this.name && rootUri === this.rootUri) {
            return;
        }
        this.name = next;
        this.rootUri = rootUri ?? this.rootUri;
        // Everything already drawn with the directory's name has to be redrawn.
        this.onDidChangeEmitter.fire({ affects: () => true });
    }

    /** The label itself — what the Projects panel and the status line print. */
    getName(_element?: object): string | undefined {
        return this.name;
    }

    /**
     * Above the file label provider's own answer (101, see
     * `StudioFileTreeLabelProvider`) so the root's name wins, and only for the
     * root — every file below it keeps its filename.
     */
    canHandle(element: object): number {
        return this.name && this.isWorkspaceRoot(element) ? 200 : 0;
    }

    protected isWorkspaceRoot(element: object): boolean {
        const uri = FileStatNode.is(element) ? element.uri : element instanceof URI ? element : undefined;
        if (!uri) {
            return false;
        }
        // The root the portal named, when it said which; otherwise the one
        // directory the session ever opens.
        return this.rootUri
            ? uri.toString() === this.rootUri
            : uri.path.toString() === '/workspace';
    }
}
