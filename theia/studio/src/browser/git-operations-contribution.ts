import { injectable, inject } from '@theia/core/shared/inversify';
import { DisposableCollection, Emitter, Event } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';
import { CommandService } from '@theia/core/lib/common/command';
import { ILogger } from '@theia/core';
import URI from '@theia/core/lib/common/uri';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import {
    type StudioOperationSnapshot,
    type StudioRepositoryDescriptor,
    type StudioRuntimeSession,
    type StudioWorkspaceLocation,
    type StudioWorkspaceRequest
} from '../common/studio-protocol';

export const GitOperationsCommand: Command = { id: 'studio.git-operations:toggle' };

export interface StudioRuntimeClientLike {
    onOperationEvent(event: unknown): void;
    onRepositoriesChanged(repositories: readonly StudioRepositoryDescriptor[]): void;
}

type StudioRuntimeProxyLike = {
    getSession(): Promise<StudioRuntimeSession & { git?: { mode?: string; branch?: string } }>;
    getRepositories?(): Promise<readonly StudioRepositoryDescriptor[]>;
    resolveWorkspacePath?(request: StudioWorkspaceRequest): Promise<StudioWorkspaceLocation>;
    getOperationDeltas?(request: { afterSequence: number }): Promise<{ lastSequence: number; events: readonly unknown[] }>;
    retryOperation?(request: { operationId: string }): Promise<unknown>;
    enqueueOperation?(request: { workspaceId: string; repositoryId: string; relativePath: string; languageId: 'markdown'; contentHash: string; idempotencyKey: string; savedAt: string }): Promise<unknown>;
    onDidOpenConnection?: (listener: () => void) => { dispose(): void };
    onDidCloseConnection?: (listener: () => void) => { dispose(): void };
};

export interface GitOperationRecord extends StudioOperationSnapshot {}

const MAX_RETAINED_OPERATIONS = 200;
const REPOSITORY_OPEN_CONCURRENCY = 1;

@injectable()
export class GitOperationsFrontendController implements FrontendApplicationContribution, StudioRuntimeClientLike {
    @inject(StatusBar)
    protected readonly statusBar: StatusBar;

    @inject(ILogger)
    protected readonly logger: ILogger;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(CommandRegistry)
    protected readonly commandRegistry: CommandRegistry;

    @inject(ScmService)
    protected readonly scmService: ScmService;

    protected runtime: StudioRuntimeProxyLike | undefined;
    protected session: (StudioRuntimeSession & { git?: { mode?: string; branch?: string } }) | undefined;
    protected operations = new Map<string, GitOperationRecord>();
    protected operationOrder: string[] = [];
    protected repositories = new Map<string, StudioRepositoryDescriptor>();
    protected repositoryOrder: string[] = [];
    protected lastSequence = 0;
    protected connected = false;
    protected statusBarRenderPending = false;
    protected statusBarRenderQueued = false;
    protected statusBarRenderNeedsLayoutRetry = false;
    protected readonly onDidChangeEmitter = new Emitter<void>();
    protected readonly toDispose = new DisposableCollection(this.onDidChangeEmitter);
    protected readonly openingRepositories = new Set<string>();
    protected readonly queuedRepositories = new Set<string>();
    protected readonly scmUnavailableRepositories = new Set<string>();
    protected readonly repositoryOpenWaiters = new Map<string, Array<() => void>>();
    protected repositoryOpenQueue: string[] = [];
    protected repositoryQueueDrain: Promise<void> | undefined;
    protected activeRepositoryOpens = 0;
    protected scmListenersInitialized = false;

    get onDidChange(): Event<void> {
        return this.onDidChangeEmitter.event;
    }

    bindRuntime(runtime: StudioRuntimeProxyLike): void {
        if (this.runtime === runtime) {
            return;
        }
        this.runtime = runtime;
        const opened = runtime.onDidOpenConnection?.(() => {
            this.connected = true;
            this.refreshFromBackendInBackground('reconnect');
        });
        const closed = runtime.onDidCloseConnection?.(() => {
            this.connected = false;
            this.scheduleStatusBarRender();
            this.onDidChangeEmitter.fire();
        });
        if (opened) {
            this.toDispose.push(opened);
        }
        if (closed) {
            this.toDispose.push(closed);
        }
    }

    async onStart(): Promise<void> {
        this.connected = true;
        if (!this.scmListenersInitialized) {
            this.scmListenersInitialized = true;
            this.toDispose.push(this.scmService.onDidAddRepository(repository => {
                const rootUri = new URI(repository.provider.rootUri).normalizePath().toString();
                let matchingDescriptor: StudioRepositoryDescriptor | undefined;
                for (const candidate of this.repositories.values()) {
                    if (new URI(candidate.rootUri).normalizePath().toString() === rootUri) {
                        this.scmUnavailableRepositories.delete(candidate.repositoryId);
                        matchingDescriptor = candidate;
                    }
                }
                // vscode.git can register a repository after openRepository's
                // command promise has already settled. Select the preferred
                // configured source when that asynchronous registration
                // arrives so Graph and SCM never open in an unscoped state.
                const preferred = prioritizeRepositories(this.getRepositories())[0];
                if (!this.scmService.selectedRepository
                    && matchingDescriptor?.repositoryId === preferred?.repositoryId) {
                    this.scmService.selectedRepository = repository;
                }
                this.scheduleStatusBarRender();
                this.onDidChangeEmitter.fire();
            }));
            this.toDispose.push(this.scmService.onDidChangeSelectedRepository(() => {
                this.scheduleStatusBarRender();
                this.onDidChangeEmitter.fire();
            }));
            this.toDispose.push(this.scmService.onDidRemoveRepository(() => {
                this.reconcileScmRepositories();
            }));
            this.toDispose.push(this.commandRegistry.onCommandsChanged(() => {
                if (this.isGitOpenRepositoryAvailable()) {
                    this.reconcileScmRepositories();
                }
            }));
        }
        await this.refreshFromBackend();
    }

    onDidInitializeLayout(): void {
        if (!this.statusBarRenderNeedsLayoutRetry) {
            return;
        }
        this.statusBarRenderNeedsLayoutRetry = false;
        this.scheduleStatusBarRender();
    }

    onStop(): void {
        this.resolveAllRepositoryOpenWaiters();
        this.toDispose.dispose();
    }

    async enqueueOperation(request: { workspaceId: string; repositoryId: string; relativePath: string; languageId: 'markdown'; contentHash: string; idempotencyKey: string; savedAt: string }): Promise<void> {
        await this.runtime?.enqueueOperation?.(request);
    }

    async resolveRepository(relativePath: string): Promise<Pick<StudioRepositoryDescriptor, 'repositoryId'> | undefined> {
        const location = await this.runtime?.resolveWorkspacePath?.({
            relativePath,
            requireExists: true
        });
        return location?.repositoryId
            ? (this.repositories.get(location.repositoryId) ?? { repositoryId: location.repositoryId })
            : undefined;
    }

    async resolveWorkspaceResource(resourceUri: string): Promise<{
        relativePath: string;
        repository: Pick<StudioRepositoryDescriptor, 'repositoryId'>;
    } | undefined> {
        const location = await this.runtime?.resolveWorkspacePath?.({
            resourceUri,
            requireExists: true
        });
        return location?.repositoryId
            ? {
                relativePath: location.relativePath,
                repository: this.repositories.get(location.repositoryId) ?? { repositoryId: location.repositoryId }
            }
            : undefined;
    }

    async retryOperation(operationId: string): Promise<void> {
        const operation = this.operations.get(operationId);
        if (!operation || !isRetryable(operation.state)) {
            return;
        }
        await this.runtime?.retryOperation?.({ operationId });
    }

    async getSession(): Promise<(StudioRuntimeSession & { git?: { mode?: string; branch?: string } }) | undefined> {
        if (!this.session) {
            this.session = await this.runtime?.getSession();
        }
        return this.session;
    }

    getOperations(): GitOperationRecord[] {
        return this.operationOrder
            .map(operationId => this.operations.get(operationId))
            .filter((operation): operation is GitOperationRecord => Boolean(operation));
    }

    getRepositories(): readonly StudioRepositoryDescriptor[] {
        return this.repositoryOrder
            .map(repositoryId => this.repositories.get(repositoryId))
            .filter((repository): repository is StudioRepositoryDescriptor => Boolean(repository));
    }

    getSelectedRepository(): StudioRepositoryDescriptor | undefined {
        const selected = this.scmService.selectedRepository;
        if (!selected) {
            return undefined;
        }
        const selectedRootUri = new URI(selected.provider.rootUri).normalizePath().toString();
        return this.getRepositories().find(repository =>
            new URI(repository.rootUri).normalizePath().toString() === selectedRootUri
        );
    }

    isScmUnavailable(repositoryId: string): boolean {
        return this.scmUnavailableRepositories.has(repositoryId);
    }

    async selectRepository(repositoryId: string): Promise<void> {
        const descriptor = this.repositories.get(repositoryId);
        if (!descriptor) {
            return;
        }
        await this.requestScmRepository(descriptor, { priority: true, selectWhenReady: true });
        const repository = this.findScmRepository(descriptor.rootUri);
        if (repository) {
            this.scmService.selectedRepository = repository;
        }
    }

    getSessionSnapshot(): StudioRuntimeSession | undefined {
        return this.session;
    }

    isConnected(): boolean {
        return this.connected;
    }

    onOperationEvent(event: unknown): void {
        this.applyEvent(event);
    }

    onRepositoriesChanged(repositories: readonly StudioRepositoryDescriptor[]): void {
        this.repositories = new Map(repositories.map(repository => [repository.repositoryId, repository]));
        this.repositoryOrder = repositories.map(repository => repository.repositoryId);
        const knownRepositoryIds = new Set(this.repositoryOrder);
        this.repositoryOpenQueue = this.repositoryOpenQueue.filter(repositoryId => knownRepositoryIds.has(repositoryId));
        for (const repositoryId of [...this.repositoryOpenWaiters.keys()]) {
            if (!knownRepositoryIds.has(repositoryId)) {
                this.resolveRepositoryOpenWaiters(repositoryId);
            }
        }
        for (const repositoryId of [...this.queuedRepositories]) {
            if (!knownRepositoryIds.has(repositoryId)) {
                this.queuedRepositories.delete(repositoryId);
            }
        }
        this.scheduleStatusBarRender();
        this.onDidChangeEmitter.fire();
        this.reconcileScmRepositories();
    }

    protected async refreshFromBackend(): Promise<void> {
        if (!this.runtime) {
            return;
        }
        this.session = await this.runtime.getSession();
        this.onRepositoriesChanged(await this.runtime.getRepositories?.() ?? []);
        const delta = await this.runtime.getOperationDeltas?.({ afterSequence: this.lastSequence });
        for (const event of delta?.events ?? []) {
            this.applyEvent(event);
        }
        this.scheduleStatusBarRender();
        this.onDidChangeEmitter.fire();
    }

    protected reconcileScmRepositories(): void {
        if (!this.isGitOpenRepositoryAvailable()) {
            return;
        }
        const prioritized = prioritizeRepositories(this.getRepositories());
        prioritized.forEach((repository, index) => {
            void this.requestScmRepository(repository, {
                priority: index === 0,
                selectWhenReady: index === 0
            });
        });
    }

    protected async requestScmRepository(
        descriptor: StudioRepositoryDescriptor,
        options?: { priority?: boolean; selectWhenReady?: boolean }
    ): Promise<void> {
        if (!this.isGitOpenRepositoryAvailable()) {
            return;
        }
        if (this.findScmRepository(descriptor.rootUri)) {
            this.scmUnavailableRepositories.delete(descriptor.repositoryId);
            if (options?.selectWhenReady && !this.scmService.selectedRepository) {
                const repository = this.findScmRepository(descriptor.rootUri);
                if (repository) {
                    this.scmService.selectedRepository = repository;
                }
            }
            return;
        }
        const pending = this.waitForRepositoryOpen(descriptor.repositoryId);
        if (!this.openingRepositories.has(descriptor.repositoryId) && !this.queuedRepositories.has(descriptor.repositoryId)) {
            if (options?.priority) {
                this.repositoryOpenQueue.unshift(descriptor.repositoryId);
            } else {
                this.repositoryOpenQueue.push(descriptor.repositoryId);
            }
            this.queuedRepositories.add(descriptor.repositoryId);
        } else if (options?.priority) {
            this.repositoryOpenQueue = [
                descriptor.repositoryId,
                ...this.repositoryOpenQueue.filter(repositoryId => repositoryId !== descriptor.repositoryId)
            ];
        }
        this.scheduleRepositoryQueueDrain(options?.selectWhenReady ? descriptor.repositoryId : undefined);
        await pending;
    }

    protected scheduleRepositoryQueueDrain(selectRepositoryId?: string): void {
        if (this.repositoryQueueDrain) {
            return;
        }
        this.repositoryQueueDrain = this.drainRepositoryQueue(selectRepositoryId).finally(() => {
            this.repositoryQueueDrain = undefined;
            if (this.repositoryOpenQueue.length > 0) {
                this.scheduleRepositoryQueueDrain();
            }
        });
    }

    protected async drainRepositoryQueue(selectRepositoryId?: string): Promise<void> {
        while (this.activeRepositoryOpens < REPOSITORY_OPEN_CONCURRENCY && this.repositoryOpenQueue.length > 0) {
            const repositoryId = this.repositoryOpenQueue.shift()!;
            this.queuedRepositories.delete(repositoryId);
            const descriptor = this.repositories.get(repositoryId);
            if (!descriptor || this.findScmRepository(descriptor.rootUri) || this.openingRepositories.has(repositoryId)) {
                this.resolveRepositoryOpenWaiters(repositoryId);
                continue;
            }
            this.activeRepositoryOpens += 1;
            this.openingRepositories.add(repositoryId);
            try {
                await this.openScmRepository(descriptor, selectRepositoryId === repositoryId);
            } finally {
                this.openingRepositories.delete(repositoryId);
                this.activeRepositoryOpens -= 1;
                this.resolveRepositoryOpenWaiters(repositoryId);
                await yieldToUi();
            }
        }
    }

    protected async openScmRepository(descriptor: StudioRepositoryDescriptor, selectWhenReady: boolean): Promise<void> {
        try {
            const repositoryPath = new URI(descriptor.rootUri).path.fsPath();
            await this.commandService.executeCommand('git.openRepository', repositoryPath);
            const repository = this.findScmRepository(descriptor.rootUri);
            if (repository) {
                this.scmUnavailableRepositories.delete(descriptor.repositoryId);
                if (selectWhenReady && !this.scmService.selectedRepository) {
                    this.scmService.selectedRepository = repository;
                }
            } else {
                this.scmUnavailableRepositories.add(descriptor.repositoryId);
            }
        } catch (error) {
            this.scmUnavailableRepositories.add(descriptor.repositoryId);
            void this.logger.warn(
                `SCM unavailable for ${descriptor.workspaceRelativeRoot}: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            this.onDidChangeEmitter.fire();
        }
    }

    protected waitForRepositoryOpen(repositoryId: string): Promise<void> {
        return new Promise(resolve => {
            const waiters = this.repositoryOpenWaiters.get(repositoryId) ?? [];
            waiters.push(resolve);
            this.repositoryOpenWaiters.set(repositoryId, waiters);
        });
    }

    protected resolveRepositoryOpenWaiters(repositoryId: string): void {
        const waiters = this.repositoryOpenWaiters.get(repositoryId);
        if (!waiters) {
            return;
        }
        this.repositoryOpenWaiters.delete(repositoryId);
        waiters.forEach(resolve => resolve());
    }

    protected resolveAllRepositoryOpenWaiters(): void {
        for (const repositoryId of [...this.repositoryOpenWaiters.keys()]) {
            this.resolveRepositoryOpenWaiters(repositoryId);
        }
        this.repositoryOpenQueue = [];
        this.queuedRepositories.clear();
    }

    protected isGitOpenRepositoryAvailable(): boolean {
        return this.commandRegistry.getAllHandlers('git.openRepository').length > 0;
    }

    protected findScmRepository(rootUri: string) {
        const normalizedRootUri = new URI(rootUri).normalizePath().toString();
        return this.scmService.repositories.find(repository =>
            new URI(repository.provider.rootUri).normalizePath().toString() === normalizedRootUri
        );
    }

    protected applyEvent(event: unknown): void {
        if (!isOperationEvent(event) || event.sequence <= this.lastSequence) {
            return;
        }
        this.lastSequence = event.sequence;
        const previous = this.operations.get(event.operationId);
        const next: GitOperationRecord = {
            journalSchemaVersion: event.journalSchemaVersion ?? 1,
            ...(event.repositoryId ? { repositoryId: event.repositoryId } : {}),
            ...(event.repositoryFingerprint ? { repositoryFingerprint: event.repositoryFingerprint } : {}),
            ...(event.repositoryConfigRevision ? { repositoryConfigRevision: event.repositoryConfigRevision } : {}),
            operationId: event.operationId,
            workspaceId: event.workspaceId,
            relativePath: event.relativePath,
            repositoryRelativePath: event.repositoryRelativePath,
            languageId: event.languageId,
            contentHash: event.contentHash,
            idempotencyKey: event.idempotencyKey,
            savedAt: event.savedAt,
            state: event.state,
            createdAt: previous?.createdAt ?? event.timestamp,
            updatedAt: event.timestamp,
            createdSequence: previous?.createdSequence ?? event.sequence,
            lastSequence: event.sequence,
            ...(event.commitSha
                ? { commitSha: event.commitSha }
                : previous?.commitSha
                    ? { commitSha: previous.commitSha }
                    : {}),
            ...(event.failureReason ? { failureReason: event.failureReason } : {})
        };
        this.operations.set(event.operationId, next);
        this.operationOrder = [
            event.operationId,
            ...this.operationOrder.filter(operationId => operationId !== event.operationId)
        ].slice(0, MAX_RETAINED_OPERATIONS);
        for (const operationId of [...this.operations.keys()]) {
            if (!this.operationOrder.includes(operationId)) {
                this.operations.delete(operationId);
            }
        }
        this.scheduleStatusBarRender();
        this.onDidChangeEmitter.fire();
    }

    protected scheduleStatusBarRender(): void {
        if (this.statusBarRenderPending) {
            this.statusBarRenderQueued = true;
            return;
        }
        this.statusBarRenderPending = true;
        void this.flushStatusBarRender();
    }

    protected refreshFromBackendInBackground(reason: 'reconnect'): void {
        void this.refreshFromBackend().catch(error => {
            void this.logger.error(`Failed to refresh Studio Git operations after ${reason}.`, error);
        });
    }

    protected async flushStatusBarRender(): Promise<void> {
        try {
            do {
                this.statusBarRenderQueued = false;
                await this.renderStatusBar();
            } while (this.statusBarRenderQueued);
        } catch (error) {
            this.statusBarRenderNeedsLayoutRetry = true;
            void this.logger.error('Failed to render Studio Git operations status bar.', error);
        } finally {
            this.statusBarRenderPending = false;
            if (this.statusBarRenderQueued) {
                this.scheduleStatusBarRender();
            }
        }
    }

    protected async renderStatusBar(): Promise<void> {
        const selectedRepository = this.getSelectedRepository();
        const gitMode = selectedRepository?.git.mode;
        const gitBranch = selectedRepository?.git.branch;
        const latest = this.operationOrder.length > 0 ? this.operations.get(this.operationOrder[0]) : undefined;
        await this.statusBar.setElement('studio.status.mode', {
            alignment: StatusBarAlignment.LEFT,
            text: selectedRepository
                ? `$(git-branch) ${selectedRepository.label} • ${gitMode}`
                : `$(repo) Studio • ${this.repositories.size} repositories`,
            tooltip: selectedRepository
                ? `Selected repository: ${selectedRepository.workspaceRelativeRoot}`
                : 'Select a repository in Source Control',
            command: GitOperationsCommand.id,
            priority: 50
        });
        if (gitBranch) {
            await this.statusBar.setElement('studio.status.branch', {
                alignment: StatusBarAlignment.LEFT,
                text: gitBranch,
                tooltip: `${selectedRepository?.label ?? 'Selected repository'} branch`,
                priority: 49
            });
        } else {
            await this.statusBar.removeElement('studio.status.branch');
        }
        await this.statusBar.setElement('studio.status.operation', {
            alignment: StatusBarAlignment.RIGHT,
            text: latest ? formatOperationStatus(latest.state, this.connected) : (this.connected ? 'Studio idle' : 'Studio offline'),
            tooltip: latest ? `${latest.relativePath} • ${latest.state} — open Git Operations` : 'Open Studio Git Operations',
            command: GitOperationsCommand.id,
            priority: 100
        });
    }
}

function isOperationEvent(event: unknown): event is {
    journalSchemaVersion?: 1 | 2;
    sequence: number;
    operationId: string;
    workspaceId: string;
    repositoryId?: string;
    repositoryFingerprint?: string;
    repositoryConfigRevision?: string;
    relativePath: string;
    repositoryRelativePath: string;
    languageId: 'markdown';
    contentHash: string;
    idempotencyKey: string;
    savedAt: string;
    state: GitOperationRecord['state'];
    timestamp: string;
    commitSha?: string;
    failureReason?: string;
} {
    if (typeof event !== 'object' || event === null) {
        return false;
    }
    const candidate = event as Record<string, unknown>;
    return Number.isSafeInteger(candidate.sequence)
        && (candidate.sequence as number) > 0
        && typeof candidate.operationId === 'string'
        && typeof candidate.workspaceId === 'string'
        && typeof candidate.relativePath === 'string'
        && typeof candidate.repositoryRelativePath === 'string'
        && candidate.languageId === 'markdown'
        && typeof candidate.contentHash === 'string'
        && typeof candidate.idempotencyKey === 'string'
        && typeof candidate.savedAt === 'string'
        && typeof candidate.state === 'string'
        && typeof candidate.timestamp === 'string'
        && (candidate.commitSha === undefined || typeof candidate.commitSha === 'string');
}

function isRetryable(state: GitOperationRecord['state']): boolean {
    return state === 'push-pending' || state === 'blocked' || state === 'failed';
}

function formatOperationStatus(state: GitOperationRecord['state'], connected: boolean): string {
    const prefix = connected ? 'Studio' : 'Studio offline';
    return `${prefix}: ${state}`;
}

function prioritizeRepositories(repositories: readonly StudioRepositoryDescriptor[]): readonly StudioRepositoryDescriptor[] {
    return [...repositories].sort((left, right) => repositoryPriority(right) - repositoryPriority(left));
}

function repositoryPriority(repository: StudioRepositoryDescriptor): number {
    if (repository.workspaceRelativeRoot === '.') {
        return 2;
    }
    return 1;
}

async function yieldToUi(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
}
