import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { Disposable, ILogger } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { GitCommandError, GitExecutor } from './git-executor';
import { RepositoryRegistration, RepositoryRegistry } from './repository-registry';
import { StudioRuntimeConfig } from './studio-runtime-config';
import { StudioRepositoryGitDescriptor } from '../common/studio-protocol';
import { isSupportedRemoteUrl } from './git-remote-policy';

const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);
const RESCAN_DEBOUNCE_MS = 250;
const MAX_SCANNED_DIRECTORIES = 50_000;

export interface RepositoryDiscoveryInitializeOptions {
    readonly mode?: 'legacy' | 'single-folder' | 'canonical';
    readonly initialRegistrations?: readonly RepositoryRegistration[];
    /**
     * Called, debounced, when a Git marker appears or disappears under the
     * workspace root while the session is running.
     *
     * Canonical mode does not scan the filesystem for repositories — the
     * manifest is authoritative — but it does RESOLVE the manifest's sources
     * against disk, and a source whose checkout is not there yet resolves to
     * nothing. The session entrypoint now clones behind the running IDE
     * precisely so a document need not wait for it, which makes "not there
     * yet" an ordinary startup state rather than an error. This is how the
     * caller learns to resolve again.
     */
    readonly onWorkspaceContentChanged?: () => void;
}

@injectable()
export class RepositoryDiscoveryService implements Disposable {
    protected watcher: fs.FSWatcher | undefined;
    protected rescanTimer: NodeJS.Timeout | undefined;
    protected config: StudioRuntimeConfig | undefined;
    protected rescanChain: Promise<void> = Promise.resolve();
    protected discoveryGeneration = 0;
    protected disposed = false;
    protected initializationMode: 'legacy' | 'single-folder' | 'canonical' = 'legacy';

    constructor(
        @inject(GitExecutor) protected readonly git: GitExecutor,
        @inject(RepositoryRegistry) protected readonly registry: RepositoryRegistry,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    async initialize(
        config: StudioRuntimeConfig,
        options: RepositoryDiscoveryInitializeOptions = {}
    ): Promise<void> {
        this.stopBackgroundDiscovery();
        this.discoveryGeneration += 1;
        this.config = config;
        this.initializationMode = options.mode ?? 'legacy';
        await this.registry.initialize(config.workspaceRoot, config.repositoryRoot);
        if (this.initializationMode === 'canonical') {
            if (options.initialRegistrations && options.initialRegistrations.length > 0) {
                await this.registry.replace(options.initialRegistrations, {
                    allowConfiguredExternalRoots: [config.repositoryRoot]
                });
            }
            // No scan — the manifest is authoritative here. The watcher only
            // tells the caller that the disk changed, so it can resolve the
            // manifest's sources again and pick up a checkout that has just
            // landed.
            const onChanged = options.onWorkspaceContentChanged;
            if (onChanged) {
                this.startWatcher(config.workspaceRoot, onChanged);
            }
            return;
        }
        if (this.initializationMode === 'single-folder') {
            await this.initializeConfiguredRepository(config);
            return;
        }
        await this.initializeConfiguredRepository(config);
        this.startWatcher(config.workspaceRoot, () =>
            this.rescanInBackground('nested Git repository rescan')
        );
        this.rescanInBackground('initial nested repository discovery');
    }

    async discover(
        workspaceRoot: string,
        configuredRepositoryRoot?: string
    ): Promise<readonly RepositoryRegistration[]> {
        const canonicalWorkspaceRoot = await fsPromises.realpath(workspaceRoot);
        const candidateRoots = [...await findGitMarkerParents(canonicalWorkspaceRoot)];
        if (configuredRepositoryRoot) {
            const canonicalConfiguredRoot = await fsPromises.realpath(configuredRepositoryRoot);
            if (!isWithin(canonicalConfiguredRoot, canonicalWorkspaceRoot)) {
                throw new Error('Configured workspace root must be inside the configured repository root');
            }
            if (!samePath(canonicalConfiguredRoot, canonicalWorkspaceRoot)
                && !candidateRoots.some(candidate => samePath(candidate, canonicalConfiguredRoot))) {
                candidateRoots.push(canonicalConfiguredRoot);
            }
        }
        const registrations: RepositoryRegistration[] = [];
        const canonicalRoots = new Set<string>();

        for (const candidateRoot of candidateRoots) {
            try {
                const [repositoryRoot, gitDirectory, commonDirectory] = await Promise.all([
                    this.git.revParseTopLevel(candidateRoot),
                    this.git.revParseAbsoluteGitDir(candidateRoot),
                    this.git.revParseGitCommonDir(candidateRoot)
                ]);
                const canonicalRoot = await fsPromises.realpath(repositoryRoot);
                const comparisonKey = normalizeForComparison(canonicalRoot);
                if (canonicalRoots.has(comparisonKey)) {
                    continue;
                }
                canonicalRoots.add(comparisonKey);
                registrations.push({
                    repositoryRoot: canonicalRoot,
                    gitDirectory,
                    commonDirectory,
                    git: await this.readGitDescriptor(canonicalRoot)
                });
            } catch (error) {
                if (error instanceof GitCommandError || isMissingFileError(error)) {
                    this.logger.warn(`Ignoring invalid Git repository candidate ${candidateRoot}: ${error.message}`);
                    continue;
                }
                throw error;
            }
        }
        return registrations;
    }

    async refreshRepository(repositoryId: string): Promise<StudioRepositoryGitDescriptor> {
        const repository = this.registry.requireRepository(repositoryId);
        const git = await this.readGitDescriptor(repository.canonicalRoot);
        this.registry.updateGitDescriptor(repositoryId, git);
        return git;
    }

    async rescan(): Promise<void> {
        if (this.initializationMode !== 'legacy') {
            throw new Error(`Repository discovery rescan is disabled in ${this.initializationMode} mode; use WorkspaceDiscoveryService.scan instead`);
        }
        const generation = this.discoveryGeneration;
        const config = this.requireConfig();
        const scan = async (): Promise<void> => {
            if (!this.isCurrentLegacyGeneration(generation)) {
                return;
            }
            const registrations = await this.discover(config.workspaceRoot, config.repositoryRoot);
            if (!this.isCurrentLegacyGeneration(generation)) {
                return;
            }
            await this.registry.replace(registrations);
        };
        this.rescanChain = this.rescanChain.then(scan, scan);
        return this.rescanChain;
    }

    async discoverConfiguredRepositoryRegistration(): Promise<RepositoryRegistration> {
        return this.discoverConfiguredRepository(this.requireConfig());
    }

    dispose(): void {
        this.disposed = true;
        this.discoveryGeneration += 1;
        this.stopBackgroundDiscovery();
    }

    protected stopBackgroundDiscovery(): void {
        if (this.rescanTimer) {
            clearTimeout(this.rescanTimer);
            this.rescanTimer = undefined;
        }
        this.watcher?.close();
        this.watcher = undefined;
    }

    protected startWatcher(workspaceRoot: string, onMarkerChanged: () => void): void {
        try {
            this.watcher = fs.watch(workspaceRoot, { recursive: true }, (_eventType, filename) => {
                if (filename && isGitMarkerPath(filename.toString())) {
                    this.scheduleTrigger(onMarkerChanged);
                }
            });
            this.watcher.on('error', error => {
                this.logger.warn(`Nested Git repository watcher stopped: ${error.message}`);
                this.watcher?.close();
                this.watcher = undefined;
            });
        } catch (error) {
            this.logger.warn(`Nested Git repository watcher is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Coalesce a burst of marker events — a clone writes many — into one run. */
    protected scheduleTrigger(run: () => void): void {
        if (this.disposed) {
            return;
        }
        if (this.rescanTimer) {
            clearTimeout(this.rescanTimer);
        }
        this.rescanTimer = setTimeout(() => {
            this.rescanTimer = undefined;
            run();
        }, RESCAN_DEBOUNCE_MS);
    }

    protected async initializeConfiguredRepository(config: StudioRuntimeConfig): Promise<void> {
        const registration = await this.discoverConfiguredRepository(config);
        await this.registry.replace([registration]);
    }

    protected async discoverConfiguredRepository(config: StudioRuntimeConfig): Promise<RepositoryRegistration> {
        const repositoryRoot = await this.git.revParseTopLevel(config.repositoryRoot);
        const [canonicalRoot, gitDirectory, commonDirectory] = await Promise.all([
            fsPromises.realpath(repositoryRoot),
            this.git.revParseAbsoluteGitDir(config.repositoryRoot),
            this.git.revParseGitCommonDir(config.repositoryRoot)
        ]);
        return {
            repositoryRoot: canonicalRoot,
            gitDirectory,
            commonDirectory,
            git: await this.readGitDescriptor(canonicalRoot)
        };
    }

    protected rescanInBackground(reason: string): void {
        void this.rescan().catch(error =>
            this.logger.error(`${reason} failed: ${error instanceof Error ? error.message : String(error)}`)
        );
    }

    protected requireConfig(): StudioRuntimeConfig {
        if (!this.config) {
            throw new Error('Repository discovery service is not initialized');
        }
        return this.config;
    }

    protected isCurrentLegacyGeneration(generation: number): boolean {
        return !this.disposed
            && this.initializationMode === 'legacy'
            && this.discoveryGeneration === generation;
    }

    protected async readGitDescriptor(repositoryRoot: string): Promise<StudioRepositoryGitDescriptor> {
        if (!this.config) {
            return disabledGitDescriptor('Repository discovery service is not initialized');
        }
        const runtimeGit = this.config.git;
        if (runtimeGit.mode === 'disabled') {
            return disabledGitDescriptor('Git publish is disabled');
        }

        const branch = await this.git.revParseAbbrevHead(repositoryRoot);
        if (branch === 'HEAD') {
            return disabledGitDescriptor('Detached HEAD is not allowed');
        }
        const remote = runtimeGit.remote;
        const fetchSourceUrl = await this.git.getConfigValue(repositoryRoot, `remote.${remote}.url`);
        const pushSourceUrl = await this.git.getConfigValue(repositoryRoot, `remote.${remote}.pushurl`)
            ?? fetchSourceUrl;
        const resolvedFetchUrl = await this.git.getResolvedRemoteUrl(repositoryRoot, remote);
        const resolvedPushUrl = await this.git.getResolvedRemoteUrl(repositoryRoot, remote, true)
            ?? resolvedFetchUrl;
        const authorName = await this.git.getConfigValue(repositoryRoot, 'user.name')
            ?? runtimeGit.authorName;
        const authorEmail = await this.git.getConfigValue(repositoryRoot, 'user.email')
            ?? runtimeGit.authorEmail;
        if (!fetchSourceUrl || !pushSourceUrl || !resolvedFetchUrl || !resolvedPushUrl) {
            return disabledGitDescriptor(`Remote ${remote} is not configured`);
        }
        if (!authorName || !authorEmail) {
            return disabledGitDescriptor('Git author identity is not configured');
        }

        const configuredRoot = await fsPromises.realpath(this.config.repositoryRoot);
        const isConfiguredRoot = normalizeForComparison(configuredRoot) === normalizeForComparison(repositoryRoot);
        const fetchUrl = isConfiguredRoot ? runtimeGit.fetchUrl : resolvedFetchUrl;
        const pushUrl = isConfiguredRoot ? runtimeGit.pushUrl : resolvedPushUrl;
        const supportsRemote = (value: string): boolean => this.git.isSupportedRemoteUrl?.(value) ?? isSupportedRemoteUrl(value);
        if (![fetchSourceUrl, pushSourceUrl, fetchUrl, pushUrl].every(supportsRemote)) {
            return disabledGitDescriptor('Git remote transport is unsupported');
        }
        const descriptor = {
            mode: runtimeGit.mode,
            branch,
            remote,
            fetchSourceUrl,
            pushSourceUrl,
            fetchUrl,
            pushUrl,
            authorName,
            authorEmail,
            publishEnabled: true
        } as const;
        return {
            configRevision: hashConfig(descriptor),
            ...descriptor
        };
    }
}

function disabledGitDescriptor(reason: string): StudioRepositoryGitDescriptor {
    return {
        configRevision: hashConfig({ mode: 'disabled', reason }),
        mode: 'disabled',
        publishEnabled: false,
        disabledReason: reason
    };
}

function hashConfig(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function findGitMarkerParents(workspaceRoot: string): Promise<readonly string[]> {
    const candidates: string[] = [];
    const directories = [workspaceRoot];
    let scannedDirectories = 0;

    while (directories.length > 0) {
        const directory = directories.pop()!;
        scannedDirectories += 1;
        if (scannedDirectories > MAX_SCANNED_DIRECTORIES) {
            throw new Error(`Repository discovery exceeded ${MAX_SCANNED_DIRECTORIES} directories`);
        }
        const entries = await fsPromises.readdir(directory, { withFileTypes: true });
        if (entries.some(entry => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
            candidates.push(directory);
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRECTORY_NAMES.has(entry.name)) {
                continue;
            }
            directories.push(path.join(directory, entry.name));
        }
    }
    return candidates;
}

function isGitMarkerPath(filename: string): boolean {
    const normalized = filename.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized === '.git' || normalized.endsWith('/.git');
}

function normalizeForComparison(candidate: string): string {
    return process.platform === 'win32' || process.platform === 'darwin'
        ? candidate.toLocaleLowerCase()
        : candidate;
}

function samePath(left: string, right: string): boolean {
    return normalizeForComparison(left) === normalizeForComparison(right);
}

function isWithin(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === 'object' && error !== null && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
