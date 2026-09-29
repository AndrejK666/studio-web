import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, CommandService } from '@theia/core/lib/common/command';
import { Disposable, DisposableCollection, Emitter, Event } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { ILogger, MessageService } from '@theia/core';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import type {
    ConfirmWorkspaceSyncRequest,
    CreateWorkspaceConfigRequest,
    DetectContainingWorkspaceRepositoryRequest,
    ReadWorkspaceRawTomlRequest,
    ReadWorkspaceRawTomlResponse,
    RemoveWorkspaceSourceRequest,
    RenameWorkspaceRequest,
    RetryWorkspaceJobRequest,
    SaveWorkspaceRawTomlRequest,
    StartWorkspaceSyncRequest,
    UpdateWorkspaceConfigRequest,
    UpdateWorkspaceSuggestionRequest,
    WorkspaceActivityEvent,
    WorkspaceConfigMutationResponse,
    WorkspaceMigrationActivateRequest,
    WorkspaceMigrationRequest,
    WorkspaceMigrationRollbackRequest,
    WorkspaceMigrationStatusResponse,
    WorkspaceRepositorySuggestion,
    WorkspaceScanRequest,
    WorkspaceScanResponse,
    WorkspaceSnapshot,
    WorkspaceSnapshotResponse,
    WorkspaceSyncResponse
} from '../common/workspace-protocol';
import { StudioRuntimeService, type StudioRuntimeSession } from '../common/studio-protocol';
import { WorkspaceSourceRootService } from './workspace-source-root-decorator';
import { WorkspaceSuggestionGate } from './workspace-suggestion-gate';

export const WorkspaceSourcesToggleCommand = {
    id: 'studio.workspace-sources:toggle',
    label: 'Workspace Sources'
};
export const WorkspaceSourcesOpenCommand = {
    id: 'studio.workspace-sources:open',
    label: 'Open Workspace Sources'
};
export const WorkspaceSourcesOpenRootCommand = {
    id: 'studio.workspace-sources:open-root',
    label: 'Open Workspace Sources'
};
export const WorkspaceSourcesRefreshCommand = {
    id: 'studio.workspace-sources:refresh',
    label: 'Refresh Workspace Sources'
};
export const WorkspaceSourcesCreateCommand = {
    id: 'studio.workspace-sources:create-canonical-config',
    label: 'Create Canonical Workspace Sources Config'
};
export const WorkspaceSourcesScanCommand = {
    id: 'studio.workspace-sources:scan',
    label: 'Scan Workspace Sources'
};
export const WorkspaceSourcesSyncCommand = {
    id: 'studio.workspace-sources:sync',
    label: 'Sync Workspace Sources'
};

type WorkspaceRuntimeProxyLike = Pick<
    StudioRuntimeService,
    | 'getSession'
    | 'getWorkspaceSnapshot'
    | 'createWorkspaceConfig'
    | 'addWorkspaceSource'
    | 'updateWorkspaceSource'
    | 'removeWorkspaceSource'
    | 'renameWorkspace'
    | 'readWorkspaceRawToml'
    | 'saveWorkspaceRawToml'
    | 'getWorkspaceMigrationStatus'
    | 'previewWorkspaceMigration'
    | 'applyWorkspaceMigration'
    | 'compareWorkspaceMigration'
    | 'activateWorkspaceMigration'
    | 'rollbackWorkspaceMigration'
    | 'scanWorkspaceSources'
    | 'detectContainingWorkspaceRepository'
    | 'ignoreWorkspaceSuggestion'
    | 'unignoreWorkspaceSuggestion'
    | 'startWorkspaceSync'
    | 'confirmWorkspaceSync'
    | 'cancelWorkspaceJob'
    | 'retryWorkspaceJob'
> & {
    onDidOpenConnection?: (listener: () => void) => { dispose(): void };
    onDidCloseConnection?: (listener: () => void) => { dispose(): void };
};

const OPEN_WORKSPACE_SOURCES_ACTION = 'Open Workspace Sources';
const IGNORE_ACTION = 'Ignore';
const BOUNDED_SCAN_REQUEST: Pick<WorkspaceScanRequest, 'roots' | 'maxDepth' | 'maxEntries'> = {
    roots: ['.'],
    maxDepth: 3,
    maxEntries: 100
};

@injectable()
export class WorkspaceSourcesFrontendController implements FrontendApplicationContribution, CommandContribution {
    @inject(WorkspaceService)
    protected readonly workspaceService!: WorkspaceService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(CommandService)
    protected readonly commandService!: CommandService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    @inject(WorkspaceSourceRootService)
    protected readonly sourceRootService!: WorkspaceSourceRootService;

    /** Bound only by a host that knows a folder needs no suggestion (the desktop's placeholder). */
    @inject(WorkspaceSuggestionGate) @optional()
    protected readonly suggestionGate: WorkspaceSuggestionGate | undefined;

    protected runtime: WorkspaceRuntimeProxyLike | undefined;
    protected session: StudioRuntimeSession | undefined;
    protected snapshot: WorkspaceSnapshot | undefined;
    protected activity: WorkspaceActivityEvent | undefined;
    protected connected = false;
    protected started = false;
    protected lastOpenedRootPath: string | undefined;
    protected readonly notifiedSuggestionKeys = new Set<string>();
    protected readonly onDidChangeEmitter = new Emitter<void>();
    protected readonly onDidRequestOpenViewEmitter = new Emitter<void>();
    protected readonly toDispose = new DisposableCollection(
        this.onDidChangeEmitter,
        this.onDidRequestOpenViewEmitter
    );

    get onDidChange(): Event<void> {
        return this.onDidChangeEmitter.event;
    }

    get onDidRequestOpenView(): Event<void> {
        return this.onDidRequestOpenViewEmitter.event;
    }

    bindRuntime(runtime: WorkspaceRuntimeProxyLike): void {
        if (this.runtime === runtime) {
            return;
        }
        this.runtime = runtime;
        this.connected = true;
        this.toDispose.push(runtime.onDidOpenConnection?.(() => {
            this.connected = true;
            this.refreshFromBackendInBackground('reconnect', true);
        }) ?? Disposable.NULL);
        this.toDispose.push(runtime.onDidCloseConnection?.(() => {
            this.connected = false;
            this.emitChange();
        }) ?? Disposable.NULL);
    }

    async onStart(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => {
            this.detectOpenedWorkspaceRootInBackground('workspace-roots-changed', false);
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceLocationChanged(() => {
            this.detectOpenedWorkspaceRootInBackground('workspace-location-changed', true);
        }));
        await this.refreshFromBackend('startup');
        await this.detectContainingRepositoryForOpenedRoot({ reason: 'startup', force: true });
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(WorkspaceSourcesToggleCommand, {
            execute: () => this.openWorkspaceSourcesView()
        });
        commands.registerCommand(WorkspaceSourcesOpenCommand, {
            execute: () => this.commandService.executeCommand(WorkspaceSourcesToggleCommand.id)
        });
        commands.registerCommand(WorkspaceSourcesOpenRootCommand, {
            isVisible: (candidate: unknown) => this.sourceRootService.isRootElement(candidate),
            execute: () => this.commandService.executeCommand(WorkspaceSourcesToggleCommand.id)
        });
        commands.registerCommand(WorkspaceSourcesRefreshCommand, {
            execute: async () => this.refresh()
        });
        commands.registerCommand(WorkspaceSourcesCreateCommand, {
            execute: async () => this.createCanonicalConfigFromSnapshot()
        });
        commands.registerCommand(WorkspaceSourcesScanCommand, {
            execute: async () => this.scanWorkspaceSourcesAndOpenView()
        });
        commands.registerCommand(WorkspaceSourcesSyncCommand, {
            execute: async () => this.startSyncPreview()
        });
    }

    getSnapshot(): WorkspaceSnapshot | undefined {
        return this.snapshot;
    }

    getActivity(): WorkspaceActivityEvent | undefined {
        return this.activity;
    }

    isConnected(): boolean {
        return this.connected;
    }

    async refresh(): Promise<void> {
        await this.refreshFromBackend('manual-refresh');
        await this.detectContainingRepositoryForOpenedRoot({ reason: 'manual-refresh', force: true });
    }

    onWorkspaceSnapshotChanged(snapshot: WorkspaceSnapshot): void {
        this.applySnapshot(snapshot);
    }

    onWorkspaceActivityEvent(event: WorkspaceActivityEvent): void {
        this.activity = event;
        if (this.snapshot && this.snapshot.config.revision === event.snapshotRevision) {
            const jobs = this.snapshot.jobs.filter(job => job.jobId !== event.job.jobId);
            this.snapshot = {
                ...this.snapshot,
                jobs: [...jobs, event.job]
            };
        }
        this.emitChange();
    }

    async createWorkspaceConfig(request: CreateWorkspaceConfigRequest): Promise<WorkspaceConfigMutationResponse | undefined> {
        const response = await this.runtime?.createWorkspaceConfig?.(request);
        if (response) {
            this.applyMutationResponse(response);
        }
        return response;
    }

    async addWorkspaceSource(request: UpdateWorkspaceConfigRequest): Promise<WorkspaceConfigMutationResponse | undefined> {
        const response = await this.runtime?.addWorkspaceSource?.(request);
        if (response) {
            this.applyMutationResponse(response);
        }
        return response;
    }

    async updateWorkspaceSource(request: UpdateWorkspaceConfigRequest): Promise<WorkspaceConfigMutationResponse | undefined> {
        const response = await this.runtime?.updateWorkspaceSource?.(request);
        if (response) {
            this.applyMutationResponse(response);
        }
        return response;
    }

    async removeWorkspaceSource(request: RemoveWorkspaceSourceRequest): Promise<WorkspaceConfigMutationResponse | undefined> {
        const response = await this.runtime?.removeWorkspaceSource?.(request);
        if (response) {
            this.applyMutationResponse(response);
        }
        return response;
    }

    async renameWorkspace(request: RenameWorkspaceRequest): Promise<WorkspaceConfigMutationResponse | undefined> {
        const response = await this.runtime?.renameWorkspace?.(request);
        if (response) {
            this.applyMutationResponse(response);
        }
        return response;
    }

    async readWorkspaceRawToml(request: ReadWorkspaceRawTomlRequest): Promise<ReadWorkspaceRawTomlResponse | undefined> {
        return this.runtime?.readWorkspaceRawToml?.(request);
    }

    async saveWorkspaceRawToml(request: SaveWorkspaceRawTomlRequest): Promise<WorkspaceConfigMutationResponse | undefined> {
        const response = await this.runtime?.saveWorkspaceRawToml?.(request);
        if (response) {
            this.applyMutationResponse(response);
        }
        return response;
    }

    async getWorkspaceMigrationStatus(request: WorkspaceMigrationRequest): Promise<WorkspaceMigrationStatusResponse | undefined> {
        return this.runtime?.getWorkspaceMigrationStatus?.(request);
    }

    async previewWorkspaceMigration(request: WorkspaceMigrationRequest): Promise<WorkspaceMigrationStatusResponse | undefined> {
        return this.runtime?.previewWorkspaceMigration?.(request);
    }

    async applyWorkspaceMigration(request: WorkspaceMigrationRequest): Promise<WorkspaceMigrationStatusResponse | undefined> {
        return this.runtime?.applyWorkspaceMigration?.(request);
    }

    async compareWorkspaceMigration(request: WorkspaceMigrationRequest): Promise<WorkspaceMigrationStatusResponse | undefined> {
        return this.runtime?.compareWorkspaceMigration?.(request);
    }

    async activateWorkspaceMigration(request: WorkspaceMigrationActivateRequest): Promise<WorkspaceMigrationStatusResponse | undefined> {
        return this.runtime?.activateWorkspaceMigration?.(request);
    }

    async rollbackWorkspaceMigration(request: WorkspaceMigrationRollbackRequest): Promise<WorkspaceMigrationStatusResponse | undefined> {
        return this.runtime?.rollbackWorkspaceMigration?.(request);
    }

    async scanWorkspaceSources(request: WorkspaceScanRequest): Promise<WorkspaceScanResponse | undefined> {
        const response = await this.runtime?.scanWorkspaceSources?.(request);
        if (response) {
            this.applyScanResponse(response);
        }
        return response;
    }

    async detectContainingWorkspaceRepository(
        request: DetectContainingWorkspaceRepositoryRequest
    ): Promise<WorkspaceRepositorySuggestion | undefined> {
        const suggestion = await this.runtime?.detectContainingWorkspaceRepository?.(request);
        if (suggestion) {
            this.scheduleSuggestionNotification(suggestion, request.workspaceId, request.configPath);
        }
        return suggestion;
    }

    async ignoreWorkspaceSuggestion(request: UpdateWorkspaceSuggestionRequest): Promise<WorkspaceSnapshotResponse | undefined> {
        const response = await this.runtime?.ignoreWorkspaceSuggestion?.(request);
        if (response) {
            this.applySnapshot(response.snapshot);
        }
        return response;
    }

    async unignoreWorkspaceSuggestion(request: UpdateWorkspaceSuggestionRequest): Promise<WorkspaceSnapshotResponse | undefined> {
        const response = await this.runtime?.unignoreWorkspaceSuggestion?.(request);
        if (response) {
            this.applySnapshot(response.snapshot);
        }
        return response;
    }

    async startWorkspaceSync(request: StartWorkspaceSyncRequest): Promise<WorkspaceSyncResponse | undefined> {
        const response = await this.runtime?.startWorkspaceSync?.(request);
        if (response) {
            this.applySyncResponse(response);
        }
        return response;
    }

    async confirmWorkspaceSync(request: ConfirmWorkspaceSyncRequest): Promise<WorkspaceSyncResponse | undefined> {
        const response = await this.runtime?.confirmWorkspaceSync?.(request);
        if (response) {
            this.applySyncResponse(response);
        }
        return response;
    }

    async cancelWorkspaceJob(request: { workspaceId?: string; configPath?: string; jobId: string }): Promise<WorkspaceSyncResponse | undefined> {
        const response = await this.runtime?.cancelWorkspaceJob?.(request);
        if (response) {
            this.applySyncResponse(response);
        }
        return response;
    }

    async retryWorkspaceJob(request: RetryWorkspaceJobRequest): Promise<WorkspaceSyncResponse | undefined> {
        const response = await this.runtime?.retryWorkspaceJob?.(request);
        if (response) {
            this.applySyncResponse(response);
        }
        return response;
    }

    protected async openWorkspaceSourcesView(): Promise<void> {
        this.onDidRequestOpenViewEmitter.fire();
    }

    protected async refreshFromBackend(reason: string): Promise<void> {
        if (!this.runtime) {
            return;
        }
        this.connected = true;
        this.session = await this.runtime.getSession();
        const response = await this.runtime.getWorkspaceSnapshot?.({
            workspaceId: this.session.workspaceId,
            configPath: this.snapshot?.identity.configPath
        });
        if (response?.snapshot) {
            this.applySnapshot(response.snapshot);
        } else {
            this.emitChange();
        }
        this.logger.debug?.(`Workspace sources frontend refreshed (${reason}).`);
    }

    protected refreshFromBackendInBackground(reason: string, forceRootDetection: boolean): void {
        void this.refreshFromBackend(reason)
            .then(() => this.detectContainingRepositoryForOpenedRoot({ reason, force: forceRootDetection }))
            .catch(error => this.logBackgroundError(`Workspace sources refresh failed during ${reason}`, error));
    }

    protected detectOpenedWorkspaceRootInBackground(reason: string, force: boolean): void {
        void this.detectContainingRepositoryForOpenedRoot({ reason, force })
            .catch(error => this.logBackgroundError(`Workspace sources root detection failed during ${reason}`, error));
    }

    protected async detectContainingRepositoryForOpenedRoot(options: { reason: string; force: boolean }): Promise<void> {
        const openedRootPath = await this.getExplicitOpenedRootPath();
        if (!openedRootPath) {
            this.lastOpenedRootPath = undefined;
            return;
        }
        if (!options.force && this.lastOpenedRootPath === openedRootPath) {
            return;
        }
        this.lastOpenedRootPath = openedRootPath;
        const identity = this.snapshot?.identity;
        if (!identity) {
            return;
        }
        await this.detectContainingWorkspaceRepository({
            workspaceId: identity.workspaceId,
            configPath: identity.configPath,
            openedPath: openedRootPath
        });
    }

    protected async getExplicitOpenedRootPath(): Promise<string | undefined> {
        await this.workspaceService.ready;
        const workspace = this.workspaceService.workspace;
        if (workspace?.isDirectory) {
            return workspace.resource.path.fsPath();
        }
        if (!this.workspaceService.opened || this.workspaceService.saved) {
            return undefined;
        }
        const roots = await this.workspaceService.roots;
        if (roots.length === 1) {
            return roots[0].resource.path.fsPath();
        }
        return undefined;
    }

    protected async createCanonicalConfigFromSnapshot(): Promise<void> {
        const snapshot = this.requireSnapshot();
        const session = await this.requireSession();
        if (snapshot.identity.workspaceId !== session.workspaceId) {
            throw new Error(`Workspace identity mismatch: snapshot=${snapshot.identity.workspaceId}, session=${session.workspaceId}`);
        }
        const configPath = snapshot.identity.configPath;
        if (new URI(configPath).path.base !== snapshot.identity.configFileName) {
            throw new Error(`Workspace config path must resolve to ${snapshot.identity.configFileName}.`);
        }
        await this.createWorkspaceConfig({
            workspaceId: snapshot.identity.workspaceId,
            configPath,
            revisionToken: snapshot.config.revision,
            sources: []
        });
    }

    protected async scanWorkspaceSourcesAndOpenView(): Promise<void> {
        const snapshot = this.requireSnapshot();
        await this.scanWorkspaceSources({
            workspaceId: snapshot.identity.workspaceId,
            configPath: snapshot.identity.configPath,
            ...BOUNDED_SCAN_REQUEST
        });
        await this.commandService.executeCommand(WorkspaceSourcesToggleCommand.id);
    }

    protected async startSyncPreview(): Promise<void> {
        const snapshot = this.requireSnapshot();
        await this.startWorkspaceSync({
            workspaceId: snapshot.identity.workspaceId,
            configPath: snapshot.identity.configPath,
            expectedRevision: snapshot.config.revision,
            trustConfirmed: false
        });
    }

    protected requireSnapshot(): WorkspaceSnapshot {
        if (!this.snapshot) {
            throw new Error('Workspace snapshot is not available.');
        }
        return this.snapshot;
    }

    protected async requireSession(): Promise<StudioRuntimeSession> {
        if (!this.session) {
            if (!this.runtime) {
                throw new Error('Workspace runtime is not bound.');
            }
            this.session = await this.runtime.getSession();
        }
        return this.session;
    }

    protected applyMutationResponse(response: WorkspaceConfigMutationResponse): void {
        if (response.sync) {
            this.applySyncResponse(response.sync);
            return;
        }
        this.applySnapshot(response.snapshot);
    }

    protected applySyncResponse(response: WorkspaceSyncResponse): void {
        this.activity = {
            schemaVersion: response.schemaVersion,
            eventId: `${response.job.jobId}:${response.job.updatedAt}`,
            job: response.job,
            snapshotRevision: response.snapshot.config.revision
        };
        this.applySnapshot(response.snapshot);
    }

    protected applyScanResponse(response: WorkspaceScanResponse): void {
        if (!this.snapshot) {
            return;
        }
        this.applySnapshot({
            ...this.snapshot,
            latestScan: response.preview,
            suggestions: response.suggestions,
            state: 'scan-preview'
        });
    }

    protected applySnapshot(snapshot: WorkspaceSnapshot): void {
        const previousRevision = this.snapshot?.config.revision;
        this.snapshot = snapshot;
        this.sourceRootService.updateSnapshot(snapshot);
        if (previousRevision !== snapshot.config.revision) {
            this.notifiedSuggestionKeys.clear();
        }
        this.emitChange();
        for (const suggestion of snapshot.suggestions) {
            this.scheduleSuggestionNotification(
                suggestion,
                snapshot.identity.workspaceId,
                snapshot.identity.configPath
            );
        }
    }

    protected scheduleSuggestionNotification(
        suggestion: WorkspaceRepositorySuggestion,
        workspaceId: string | undefined,
        configPath: string | undefined
    ): void {
        void this.showSuggestionNotification(suggestion, workspaceId, configPath)
            .catch(error => this.logBackgroundError('Workspace sources suggestion notification failed', error));
    }

    protected async showSuggestionNotification(
        suggestion: WorkspaceRepositorySuggestion,
        workspaceId: string | undefined,
        configPath: string | undefined
    ): Promise<void> {
        if (!workspaceId || !configPath || !this.shouldNotifySuggestion(suggestion)) {
            return;
        }
        const revision = this.snapshot?.config.revision ?? 'unknown';
        const notificationKey = `${revision}:${suggestion.suggestionId}:${suggestion.candidateId}`;
        if (this.notifiedSuggestionKeys.has(notificationKey)) {
            return;
        }
        if (this.suggestionGate && await this.suggestionGate.suppresses(suggestion)) {
            return;
        }
        this.notifiedSuggestionKeys.add(notificationKey);
        const action = await this.messageService.info(
            `Workspace source suggestion: ${suggestion.label} contains the opened folder and is not configured yet.`,
            { timeout: 0 },
            OPEN_WORKSPACE_SOURCES_ACTION,
            IGNORE_ACTION
        );
        if (action === OPEN_WORKSPACE_SOURCES_ACTION) {
            await this.commandService.executeCommand(WorkspaceSourcesToggleCommand.id);
            return;
        }
        if (action === IGNORE_ACTION) {
            await this.ignoreWorkspaceSuggestion({
                workspaceId,
                configPath,
                candidateId: suggestion.candidateId,
                rootPath: suggestion.rootPath
            });
        }
    }

    protected shouldNotifySuggestion(suggestion: WorkspaceRepositorySuggestion): boolean {
        if (suggestion.kind !== 'containing-repository' || suggestion.disposition !== 'new') {
            return false;
        }
        if (this.snapshot?.suggestions.some(existing =>
            existing.candidateId === suggestion.candidateId
            && existing.rootPath === suggestion.rootPath
            && existing.disposition !== 'new'
        )) {
            return false;
        }
        if (this.snapshot?.configuredSources.some(source => source.localPath === suggestion.localPath || source.sourceId === suggestion.sourceId)) {
            return false;
        }
        return true;
    }

    protected emitChange(): void {
        this.onDidChangeEmitter.fire();
    }

    protected logBackgroundError(message: string, error: unknown): void {
        this.logger.error(message, error);
    }
}
