import { inject, injectable, named, optional, postConstruct } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import URI from '@theia/core/lib/common/uri';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { DidChangeLabelEvent } from '@theia/core/lib/browser/label-provider';
import { FileStatNode } from '@theia/filesystem/lib/browser/file-tree/file-tree';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileChangesEvent, FileOperationEvent } from '@theia/filesystem/lib/common/files';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { DOCUMENTS_PERSPECTIVE_ID } from '../common/studio-modes';

export type ExplorerMode = 'markdown' | 'all';

const EXPLORER_MODE_STORAGE_KEY = 'studio.explorer.mode';

/**
 * The Explorer each mode opens with, until somebody toggles it there.
 *
 * Doc editing is the one mode whose Explorer is a list of documents titled by
 * their own H1 - the list its perspective was designed around
 * (studio-perspectives.ts). Every other mode is for working on code, and a code
 * mode whose file tree hides `src/` cannot be used for that: the markdown
 * default predates the modes, when the session had only the one Explorer.
 * Without a perspective service there are no modes, and the Explorer is what it
 * always was.
 */
export function defaultExplorerMode(perspectiveId: string | undefined): ExplorerMode {
    return perspectiveId === undefined || perspectiveId === DOCUMENTS_PERSPECTIVE_ID ? 'markdown' : 'all';
}

/** Where a mode's own choice is kept: a toggle in one mode is not a toggle in the others. */
export function explorerModeStorageKey(perspectiveId: string | undefined): string {
    return perspectiveId === undefined ? EXPLORER_MODE_STORAGE_KEY : `${EXPLORER_MODE_STORAGE_KEY}.${perspectiveId}`;
}

function isExplorerMode(value: unknown): value is ExplorerMode {
    return value === 'markdown' || value === 'all';
}
const MARKDOWN_HEADING_READ_LIMIT = 64 * 1024;

/**
 * The document types shown in the documents mode, where a project chose none:
 * the types this product edits. The same list as product-ext's
 * `file-type-settings.js` (DEFAULT_ON), whose Project page sets the project's
 * own list in `<root>/.studio/settings.json` (`visibleExtensions`).
 */
export const DEFAULT_SHOWN_EXTENSIONS: readonly string[] = ['md', 'html', 'txt', 'json', 'csv', 'tsv'];
const SETTINGS_PATH = '.studio/settings.json';

/** The extensions a settings document names, lower case and without the dot; the defaults when it names none. */
export function shownExtensionsFrom(settings: unknown): Set<string> {
    const listed = (settings as { visibleExtensions?: unknown } | undefined)?.visibleExtensions;
    return new Set((Array.isArray(listed) ? listed : DEFAULT_SHOWN_EXTENSIONS)
        .filter((e): e is string => typeof e === 'string')
        .map(e => e.toLowerCase().replace(/^\./, '')));
}

@injectable()
export class ExplorerPresentationService implements FrontendApplicationContribution {
    protected readonly toDispose = new DisposableCollection();
    protected readonly onDidChangeEmitter = new Emitter<readonly URI[] | undefined>();
    protected readonly onDidChangeLabelsEmitter = new Emitter<DidChangeLabelEvent>();
    protected readonly titleCache = new Map<string, string | undefined>();
    protected readonly pendingTitleLoads = new Map<string, number>();
    protected nextTitleLoadId = 0;
    protected modeUpdate = Promise.resolve();
    protected stopped = false;

    /** The mode in front; `undefined` while there is no perspective service. */
    protected perspectiveId: string | undefined;
    /** Each mode's choice, by storage key: read back from storage, or just made. */
    protected readonly chosenModes = new Map<string, ExplorerMode>();
    /** Keys a toggle has written to in this window: a later read of storage does not undo it. */
    protected readonly setKeys = new Set<string>();
    /** Keys whose stored choice has been asked for. */
    protected readonly restoredKeys = new Set<string>();

    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    /** The workspace roots, to know whose settings a file answers to. */
    @inject(WorkspaceService) @optional()
    protected readonly workspaceService: WorkspaceService | undefined;

    /** Each root's shown extensions, read from its settings once and kept until they change. */
    protected readonly shownByRoot = new Map<string, Promise<Set<string>>>();

    constructor(
        @inject(FileService) protected readonly fileService: FileService,
        @inject(StorageService) protected readonly storageService: StorageService,
        @inject(ILogger) @named('studio:ExplorerPresentationService') protected readonly logger: ILogger
    ) {}

    @postConstruct()
    protected init(): void {
        this.toDispose.push(this.onDidChangeEmitter);
        this.toDispose.push(this.onDidChangeLabelsEmitter);
        this.toDispose.push(this.fileService.onDidFilesChange(event => this.handleFilesChanged(event)));
        this.toDispose.push(this.fileService.onDidRunOperation(event => this.handleFileOperation(event)));
        if (this.perspectives) {
            this.toDispose.push(this.perspectives.onDidChangePerspective(id => this.enterPerspective(id)));
            this.perspectiveId = this.perspectives.getActivePerspectiveId();
        }
        this.restoreMode(this.storageKey());
    }

    /**
     * A restored layout names its perspective without announcing a switch
     * (`setActivePerspectiveId`), so the mode is read again once the layout is in.
     */
    onDidInitializeLayout(): void {
        if (this.perspectives) {
            this.enterPerspective(this.perspectives.getActivePerspectiveId());
        }
    }

    protected enterPerspective(perspectiveId: string | undefined): void {
        if (this.stopped || perspectiveId === this.perspectiveId) {
            return;
        }
        const before = this.getMode();
        this.perspectiveId = perspectiveId;
        this.restoreMode(this.storageKey());
        if (this.getMode() !== before) {
            this.firePresentationChanged();
        }
    }

    protected storageKey(): string {
        return explorerModeStorageKey(this.perspectiveId);
    }

    protected modeFor(key: string, perspectiveId: string | undefined): ExplorerMode {
        return this.chosenModes.get(key) ?? defaultExplorerMode(perspectiveId);
    }

    onStop(): void {
        this.stopped = true;
        this.pendingTitleLoads.clear();
        this.toDispose.dispose();
    }

    get onDidChange(): Event<readonly URI[] | undefined> {
        return this.onDidChangeEmitter.event;
    }

    get onDidChangeLabels(): Event<DidChangeLabelEvent> {
        return this.onDidChangeLabelsEmitter.event;
    }

    getMode(): ExplorerMode {
        return this.modeFor(this.storageKey(), this.perspectiveId);
    }

    isMarkdownMode(): boolean {
        return this.getMode() === 'markdown';
    }

    isMarkdownUri(uri: URI): boolean {
        const extension = uri.path.ext.toLowerCase();
        return extension === '.md' || extension === '.markdown';
    }

    /**
     * Is this file one of the document types its project shows (Project
     * settings → Files shown)? Markdown is always a document. A file outside
     * every root answers by the defaults.
     */
    async isShownUri(uri: URI): Promise<boolean> {
        if (this.isMarkdownUri(uri)) {
            return true;
        }
        const extension = uri.path.ext.toLowerCase().replace(/^\./, '');
        if (!extension) {
            return false;
        }
        return (await this.shownExtensions(uri)).has(extension);
    }

    protected shownExtensions(uri: URI): Promise<Set<string>> {
        const root = this.workspaceService?.tryGetRoots().map(r => r.resource).find(r => r.isEqualOrParent(uri));
        if (!root) {
            return Promise.resolve(new Set(DEFAULT_SHOWN_EXTENSIONS));
        }
        const key = root.toString();
        let shown = this.shownByRoot.get(key);
        if (!shown) {
            shown = this.fileService.read(root.resolve(SETTINGS_PATH))
                .then(content => shownExtensionsFrom(JSON.parse(content.value)))
                .catch(() => shownExtensionsFrom(undefined));
            this.shownByRoot.set(key, shown);
        }
        return shown;
    }

    /** Toggles the Explorer of the mode in front, and only that mode's. */
    async toggleMode(): Promise<void> {
        await this.enqueueModeUpdate(current => current === 'markdown' ? 'all' : 'markdown');
    }

    async setMode(mode: ExplorerMode): Promise<void> {
        await this.enqueueModeUpdate(() => mode);
    }

    protected async enqueueModeUpdate(resolveMode: (current: ExplorerMode) => ExplorerMode): Promise<void> {
        // The mode the toggle was made in, even if another is in front by the time it is written.
        const key = this.storageKey();
        const perspectiveId = this.perspectiveId;
        this.setKeys.add(key);
        const update = this.modeUpdate.catch(() => undefined).then(async () => {
            const current = this.modeFor(key, perspectiveId);
            const mode = resolveMode(current);
            if (current === mode) {
                return;
            }
            try {
                await this.storageService.setData(key, mode);
            } catch (error) {
                await this.logger.warn(`Failed to persist the Explorer mode '${mode}'.`, error);
                throw error;
            }
            this.chosenModes.set(key, mode);
            if (this.storageKey() === key) {
                this.firePresentationChanged();
            }
        });
        this.modeUpdate = update;
        await update;
    }

    getDisplayName(node: FileStatNode, fallback: string): string {
        if (this.stopped || !this.isMarkdownMode() || !this.isMarkdownUri(node.uri)) {
            return fallback;
        }
        const cacheKey = node.uri.toString();
        if (this.titleCache.has(cacheKey)) {
            return this.titleCache.get(cacheKey) || fallback;
        }
        this.scheduleTitleLoad(node.uri);
        return fallback;
    }

    /** Reads a mode's stored choice once; a toggle made meanwhile wins. */
    protected restoreMode(key: string): void {
        if (this.restoredKeys.has(key)) {
            return;
        }
        this.restoredKeys.add(key);
        void this.storageService.getData<unknown>(key).then(storedMode => {
            if (this.stopped || this.setKeys.has(key) || !isExplorerMode(storedMode)) {
                return;
            }
            const inFront = this.storageKey() === key;
            const before = inFront ? this.getMode() : undefined;
            this.chosenModes.set(key, storedMode);
            if (inFront && before !== storedMode) {
                this.firePresentationChanged();
            }
        }).catch(error => this.logger.warn('Failed to restore the Explorer mode.', error));
    }

    protected handleFilesChanged(event: FileChangesEvent): void {
        // A project's Files shown changed: its whole tree is filtered anew.
        if (event.changes.some(change => change.resource.path.toString().endsWith('/' + SETTINGS_PATH))) {
            this.shownByRoot.clear();
            this.firePresentationChanged();
        }
        this.invalidateUris(event.changes.map(change => change.resource));
    }

    protected handleFileOperation(event: FileOperationEvent): void {
        this.invalidateUris([
            event.resource,
            ...(event.target ? [event.target.resource] : [])
        ]);
    }

    protected invalidateUris(uris: readonly URI[]): void {
        const changedUris = [...new Map(uris.map(uri => [uri.toString(), uri])).values()];
        for (const cacheKey of this.titleCache.keys()) {
            if (changedUris.some(uri => uri.isEqualOrParent(new URI(cacheKey)))) {
                this.titleCache.delete(cacheKey);
            }
        }
        for (const cacheKey of this.pendingTitleLoads.keys()) {
            if (changedUris.some(uri => uri.isEqualOrParent(new URI(cacheKey)))) {
                this.pendingTitleLoads.delete(cacheKey);
            }
        }
        this.onDidChangeEmitter.fire(changedUris);
        this.onDidChangeLabelsEmitter.fire({
            affects: element => FileStatNode.is(element)
                && changedUris.some(uri => uri.isEqualOrParent(element.uri) || element.uri.isEqualOrParent(uri))
        });
    }

    protected firePresentationChanged(): void {
        this.onDidChangeEmitter.fire(undefined);
        this.onDidChangeLabelsEmitter.fire({
            affects: element => FileStatNode.is(element)
        });
    }

    protected scheduleTitleLoad(uri: URI): void {
        const cacheKey = uri.toString();
        if (this.pendingTitleLoads.has(cacheKey)) {
            return;
        }
        const loadId = this.nextTitleLoadId += 1;
        this.pendingTitleLoads.set(cacheKey, loadId);
        void this.fileService.read(uri, {
            acceptTextOnly: true,
            length: MARKDOWN_HEADING_READ_LIMIT
        }).then(content => {
            if (this.stopped || this.pendingTitleLoads.get(cacheKey) !== loadId) {
                return;
            }
            const nextTitle = extractPrimaryMarkdownHeading(content.value);
            const previousTitle = this.titleCache.get(cacheKey);
            this.titleCache.set(cacheKey, nextTitle);
            if (previousTitle !== nextTitle) {
                this.onDidChangeLabelsEmitter.fire({
                    affects: element => FileStatNode.is(element) && element.uri.toString() === cacheKey
                });
            }
        }).catch(error => {
            if (!this.stopped && this.pendingTitleLoads.get(cacheKey) === loadId) {
                void this.logger.warn(`Failed to read the Markdown title for '${uri.toString()}'.`, error);
            }
        }).finally(() => {
            if (this.pendingTitleLoads.get(cacheKey) === loadId) {
                this.pendingTitleLoads.delete(cacheKey);
            }
        });
    }
}

export function extractPrimaryMarkdownHeading(content: string): string | undefined {
    const lines = content.split(/\r?\n/);
    let startIndex = 0;
    if (lines[0]?.replace(/^\uFEFF/, '').trim() === '---') {
        const frontMatterEnd = lines.findIndex((line, index) =>
            index > 0 && (line.trim() === '---' || line.trim() === '...')
        );
        if (frontMatterEnd !== -1) {
            startIndex = frontMatterEnd + 1;
        }
    }
    for (let index = startIndex; index < lines.length; index += 1) {
        const line = lines[index];
        const atxMatch = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
        if (atxMatch) {
            return atxMatch[1].trim();
        }

        const nextLine = lines[index + 1];
        const candidate = line.trim();
        if (!candidate || nextLine === undefined) {
            continue;
        }
        if (/^\s*=+\s*$/.test(nextLine) || /^\s*-+\s*$/.test(nextLine)) {
            return candidate;
        }
    }
    return undefined;
}
