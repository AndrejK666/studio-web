import { injectable, inject } from '@theia/core/shared/inversify';
import { Saveable, SaveOptions, SaveReason } from '@theia/core/lib/browser/saveable';
import { LanguageService } from '@theia/core/lib/browser/language-service';
import { FilesystemSaveableService } from '@theia/filesystem/lib/browser/filesystem-saveable-service';
import URI from '@theia/core/lib/common/uri';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { GitOperationsFrontendController } from './git-operations-contribution';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';

export const ApplicationShellProvider = Symbol('ApplicationShellProvider');
export type ApplicationShellProvider = () => ApplicationShell;

@injectable()
export class StudioSaveableService extends FilesystemSaveableService {
    @inject(GitOperationsFrontendController)
    protected readonly operationsController: GitOperationsFrontendController;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(LanguageService)
    protected readonly languageService: LanguageService;

    @inject(ApplicationShellProvider)
    protected readonly applicationShellProvider: ApplicationShellProvider;

    protected closeSaveDepth = 0;
    protected preparationTail: Promise<void> = Promise.resolve();
    protected saveAttemptSequence = 0;

    override onDidInitializeLayout(app: Parameters<FilesystemSaveableService['onDidInitializeLayout']>[0]): void {
        super.onDidInitializeLayout(app);
        this.autoSave = 'off';
    }

    protected override updateAutoSaveMode(): void {
        super.updateAutoSaveMode('off');
    }

    protected override async closeWithSaving(widget: Parameters<FilesystemSaveableService['closeWithSaving']>[0], options?: Parameters<FilesystemSaveableService['closeWithSaving']>[1]): Promise<void> {
        this.closeSaveDepth += 1;
        try {
            await super.closeWithSaving(widget, options);
        } finally {
            this.closeSaveDepth -= 1;
        }
    }

    override async save(widget: Parameters<FilesystemSaveableService['save']>[0], options?: SaveOptions): Promise<URI | undefined> {
        const completePreparation = this.reservePostSavePreparation();
        try {
            const wasDirty = Saveable.isDirty(widget);
            const result = await super.save(widget, options);
            if (!result || !wasDirty || !this.shouldEnqueue(options)) {
                completePreparation(async () => undefined);
                return result;
            }
            // MonacoEditorModel exposes a synchronous snapshot. Capture it before the
            // first post-save preparation await so a subsequent edit cannot change this save's identity.
            const savedContent = this.captureSavedContent(widget);
            completePreparation(() => this.preparePostSave(widget, options, result, savedContent));
            return result;
        } catch (error) {
            completePreparation(async () => undefined);
            throw error;
        }
    }

    protected reservePostSavePreparation(): (worker: () => Promise<void>) => void {
        let resolveWorker: (worker: () => Promise<void>) => void = () => undefined;
        const workerReady = new Promise<() => Promise<void>>(resolve => {
            resolveWorker = resolve;
        });
        const task = this.preparationTail.then(async () => {
            const worker = await workerReady;
            await worker();
        });
        this.preparationTail = task.catch(() => undefined);
        void task.catch(error => {
            console.error('Studio post-save preparation failed', error);
        });
        let completed = false;
        return worker => {
            if (!completed) {
                completed = true;
                resolveWorker(worker);
            }
        };
    }

    protected async preparePostSave(
        widget: Parameters<FilesystemSaveableService['save']>[0],
        options: SaveOptions | undefined,
        result: URI,
        savedContent: BinaryBuffer | undefined
    ): Promise<void> {
        if (result.scheme !== 'file') {
            // A portal document (`studio-doc:`) is stored by the documents gear,
            // not by any checkout — there is no repository path to journal and
            // nothing for the git operation queue to commit.
            return;
        }
        const runtimeSession = await this.operationsController.getSession();
        if (!runtimeSession?.workspaceId || !runtimeSession.features.allowGitMutations) {
            return;
        }
        const workspaceRelativePath = this.getRelativePath(result);
        const resolvedResource = workspaceRelativePath
            ? undefined
            : await this.operationsController.resolveWorkspaceResource(result.toString());
        const relativePath = workspaceRelativePath ?? resolvedResource?.relativePath;
        if (!relativePath) {
            return;
        }
        const languageId = this.detectMarkdownLanguageId(result);
        if (!languageId) {
            return;
        }
        const savedAt = new Date().toISOString();
        const contentHash = await this.hashSavedContent(result, savedContent);
        const repository = resolvedResource?.repository
            ?? await this.operationsController.resolveRepository(relativePath);
        if (!repository) {
            return;
        }
        const saveAttemptId = `${savedAt}:${++this.saveAttemptSequence}`;
        const idempotencyKey = await this.computeIdempotencyKey(
            runtimeSession.workspaceId,
            repository.repositoryId,
            relativePath,
            contentHash,
            saveAttemptId
        );
        try {
            await this.operationsController.enqueueOperation({
                workspaceId: runtimeSession.workspaceId,
                repositoryId: repository.repositoryId,
                relativePath,
                languageId,
                contentHash,
                idempotencyKey,
                savedAt
            });
        } catch (error) {
            console.error('Studio post-save enqueue failed', error);
            return;
        }
        if (this.shouldSelectRepository(widget, options)) {
            await this.operationsController.selectRepository(repository.repositoryId);
        }
    }

    protected shouldEnqueue(options?: SaveOptions): boolean {
        if (this.closeSaveDepth > 0) {
            return true;
        }
        return options?.saveReason === undefined || SaveReason.isManual(options.saveReason);
    }

    protected shouldSelectRepository(
        widget: Parameters<FilesystemSaveableService['save']>[0],
        options?: SaveOptions
    ): boolean {
        return this.closeSaveDepth === 0
            && this.applicationShellProvider().currentWidget === widget
            && (options?.saveReason === undefined || SaveReason.isManual(options.saveReason));
    }

    protected getRelativePath(uri: URI): string | undefined {
        const root = this.workspaceService.getWorkspaceRootUri(uri);
        const relative = root?.relative(uri)?.toString();
        if (!relative) {
            return undefined;
        }
        return relative.replace(/^\/+/, '');
    }

    protected detectMarkdownLanguageId(uri: URI): 'markdown' | undefined {
        return this.languageService.detectLanguage(uri)?.id === 'markdown' ? 'markdown' : undefined;
    }

    protected captureSavedContent(widget: Parameters<FilesystemSaveableService['save']>[0]): BinaryBuffer | undefined {
        const snapshot = Saveable.get(widget)?.createSnapshot?.();
        const value = snapshot && Saveable.Snapshot.read(snapshot);
        return value === undefined ? undefined : BinaryBuffer.fromString(value);
    }

    protected async hashSavedContent(uri: URI, savedContent?: BinaryBuffer): Promise<string> {
        const content = savedContent ?? (await this.fileService.readFile(uri)).value;
        const digest = await crypto.subtle.digest('SHA-256', content.buffer);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    protected async computeIdempotencyKey(
        workspaceId: string,
        repositoryId: string,
        relativePath: string,
        contentHash: string,
        saveAttemptId: string
    ): Promise<string> {
        const payload = BinaryBuffer.fromString([
            workspaceId,
            repositoryId,
            relativePath,
            contentHash,
            saveAttemptId
        ].join('\n'));
        const digest = await crypto.subtle.digest('SHA-256', payload.buffer);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
}
