import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct, LazyServiceIdentifier } from '@theia/core/shared/inversify';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { GitOperationsFrontendController } from './git-operations-contribution';
import { AuditFrontendController } from './audit-controller';
import type { StudioAuditEntry } from '../common/studio-protocol';

/*
 * What happened to the work, in one place.
 *
 * This was two panels — "Git Operations" and "Audit" — and they were the same
 * subject twice. One showed the queue a change is passing through right now,
 * with a Retry on whatever is stuck; the other showed where changes ENDED UP,
 * as a filterable log of outcomes. A person asking "did my change go through?"
 * had to know which of the two to look in, and the answer was "both".
 *
 * WHY IT IS CALLED OPERATIONS AND NOT GIT.
 *
 * Theia's own Source Control came back, and it answers "what have I changed".
 * A second panel with a Git name beside it reads as a competing Git and invites
 * the question of which one is telling the truth. This one answers a different
 * question — what became of it — and the name now says so. Nothing here stages,
 * commits or diffs; that is SCM's job and it does it better.
 *
 * The two sections keep the class names and every `data-testid` they had. The
 * markup is PORTED, not redesigned: this change is about there being one
 * surface, and a merge that also restyles everything cannot be reviewed for
 * either.
 */

export type AuditFilter = 'all' | 'modified' | 'committed' | 'pushing' | 'pushed' | 'pending' | 'failed' | 'blocked';
export type AuditOutcome = Exclude<AuditFilter, 'all'>;

export interface AuditEntryViewModel {
    readonly sequence: number;
    readonly relativePath: string;
    readonly contentHash: string;
    readonly sha: string;
    readonly time: string;
    readonly outcome: AuditOutcome;
}

export const AUDIT_FILTERS: ReadonlyArray<{ id: AuditFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'modified', label: 'Modified' },
    { id: 'committed', label: 'Committed' },
    { id: 'pushing', label: 'Pushing' },
    { id: 'pushed', label: 'Pushed' },
    { id: 'pending', label: 'Pending' },
    { id: 'failed', label: 'Failed' },
    { id: 'blocked', label: 'Blocked' }
];

@injectable()
export class OperationsWidget extends ReactWidget {
    static readonly ID = 'studio:operations';
    static readonly LABEL = 'Operations';

    @inject(new LazyServiceIdentifier(() => GitOperationsFrontendController))
    protected readonly operations: GitOperationsFrontendController;

    @inject(new LazyServiceIdentifier(() => AuditFrontendController))
    protected readonly audit: AuditFrontendController;

    protected activeFilter: AuditFilter = 'all';

    @postConstruct()
    protected init(): void {
        this.id = OperationsWidget.ID;
        this.title.label = OperationsWidget.LABEL;
        this.title.caption = OperationsWidget.LABEL;
        this.title.closable = true;
        // History rather than source-control: the icon says which of the two
        // questions this panel answers, beside an SCM that answers the other.
        this.title.iconClass = 'codicon codicon-history';
        this.toDispose.push(this.operations.onDidChange(() => this.update()));
        this.toDispose.push(this.audit.onDidChange(() => this.update()));
        this.node.tabIndex = 0;
        this.update();
    }

    setFilter(filter: AuditFilter): void {
        if (this.activeFilter === filter) {
            return;
        }
        this.activeFilter = filter;
        this.update();
    }

    getFilter(): AuditFilter {
        return this.activeFilter;
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }

    protected render(): React.ReactNode {
        return (
            <div className='studio-operations' data-testid='operations-widget'>
                {this.renderInFlight()}
                {this.renderHistory()}
            </div>
        );
    }

    /** What is passing through the pipeline now, and what can be retried. */
    protected renderInFlight(): React.ReactNode {
        const operations = this.operations.getOperations();
        const repositories = this.operations.getRepositories();
        const selectedRepository = this.operations.getSelectedRepository();
        const repositoriesById = new Map(repositories.map(repository => [repository.repositoryId, repository]));
        const operationGroups = new Map<string, typeof operations>();
        for (const operation of operations) {
            const groupId = operation.repositoryId ?? 'legacy';
            const group = operationGroups.get(groupId) ?? [];
            group.push(operation);
            operationGroups.set(groupId, group);
        }
        const latest = operations[0];
        return (
            <div className='studio-git-operations' data-testid='git-operations-widget'>
                <div className='studio-git-operations__header'>
                    <h2>In flight</h2>
                    <div className='studio-git-operations__status' data-testid='git-operations-status'>
                        <span>{repositories.length} repositories</span>
                        <span>{selectedRepository?.label ?? 'no repository selected'}</span>
                        <span>{selectedRepository?.git.branch ?? 'no branch'}</span>
                        <span>{selectedRepository?.git.mode ?? 'mixed'}</span>
                        <span>{this.operations.isConnected() ? (latest?.state ?? 'idle') : 'offline'}</span>
                    </div>
                </div>
                <div className='studio-git-operations__list' data-testid='git-operations-list'>
                    {operations.length === 0 ? (
                        <div className='studio-git-operations__empty' data-testid='git-operations-empty'>No operations yet.</div>
                    ) : [...operationGroups].map(([repositoryId, repositoryOperations]) => {
                        const repository = repositoriesById.get(repositoryId);
                        return (
                            <section className='studio-git-operations__repository' key={repositoryId}>
                                <div className='studio-git-operations__repository-header'>
                                    <strong className='studio-git-operations__repository-label'>{repository?.label ?? 'Legacy operations'}</strong>
                                    <span
                                        className='studio-git-operations__repository-path'
                                        title={repository?.workspaceRelativeRoot ?? 'unknown repository'}
                                    >
                                        {repository?.workspaceRelativeRoot ?? 'unknown repository'}
                                    </span>
                                    {repository ? (
                                        <span className='studio-git-operations__repository-branch'>{repository.git.branch ?? 'no branch'}</span>
                                    ) : undefined}
                                    {repository ? (
                                        <span className='studio-git-operations__repository-mode'>{repository.git.mode}</span>
                                    ) : undefined}
                                    {repository && this.operations.isScmUnavailable(repository.repositoryId)
                                        ? <span className='studio-git-operations__repository-status'>SCM unavailable</span>
                                        : undefined}
                                    {repository && !repository.git.publishEnabled
                                        ? <span className='studio-git-operations__repository-status'>{repository.git.disabledReason ?? 'publish disabled'}</span>
                                        : undefined}
                                </div>
                                {repositoryOperations.map(operation => {
                                    const retryable = operation.state === 'push-pending' || operation.state === 'blocked' || operation.state === 'failed';
                                    return (
                                        <div
                                            key={operation.operationId}
                                            className='studio-git-operations__row'
                                            data-testid={`git-operation-row-${operation.operationId}`}
                                        >
                                            <div className='studio-git-operations__main'>
                                                <span className='studio-git-operations__path'>{operation.repositoryRelativePath}</span>
                                                <span
                                                    className={`studio-git-operations__badge studio-git-operations__badge--${operation.state}`}
                                                    data-testid={`git-operation-state-${operation.operationId}`}
                                                >
                                                    {operation.state}
                                                </span>
                                            </div>
                                            {operation.failureReason ? (
                                                <div className='studio-git-operations__detail'>{operation.failureReason}</div>
                                            ) : undefined}
                                            {retryable ? (
                                                <button
                                                    className='theia-button secondary'
                                                    data-testid={`git-operation-retry-${operation.operationId}`}
                                                    onClick={() => void this.operations.retryOperation(operation.operationId)}
                                                >
                                                    Retry
                                                </button>
                                            ) : undefined}
                                        </div>
                                    );
                                })}
                            </section>
                        );
                    })}
                </div>
            </div>
        );
    }

    /** Where changes ended up — the journal this panel exists for. */
    protected renderHistory(): React.ReactNode {
        const entries = this.getVisibleEntries();
        const counts = this.getCounts();
        return (
            <div className='studio-audit' data-testid='audit-widget'>
                <header className='studio-audit__header'>
                    <div>
                        <div className='studio-audit__eyebrow'>Sanitized browser audit</div>
                        <h2>History</h2>
                    </div>
                    <div className='studio-audit__summary' data-testid='audit-summary'>
                        <span>{counts.total} entries</span>
                        <span>{counts.latestTime ?? 'No activity yet'}</span>
                    </div>
                </header>
                <nav className='studio-audit__filters' aria-label='Audit filters' data-testid='audit-filters'>
                    {AUDIT_FILTERS.map(filter => {
                        const active = this.activeFilter === filter.id;
                        return (
                            <button
                                key={filter.id}
                                className={`theia-button secondary studio-audit__filter${active ? ' studio-audit__filter--active' : ''}`}
                                data-testid={`audit-filter-${filter.id}`}
                                aria-pressed={active}
                                onClick={() => this.setFilter(filter.id)}
                            >
                                <span>{filter.label}</span>
                                <span className='studio-audit__filter-count' data-testid={`audit-badge-${filter.id}`}>
                                    {counts.byFilter.get(filter.id) ?? 0}
                                </span>
                            </button>
                        );
                    })}
                </nav>
                <div className='studio-audit__list' data-testid='audit-list'>
                    {entries.length === 0 ? (
                        <div className='studio-audit__empty' data-testid='audit-empty'>No matching audit entries.</div>
                    ) : entries.map(entry => (
                        <article
                            key={`${entry.sequence}:${entry.relativePath}:${entry.contentHash}`}
                            className='studio-audit__row'
                            data-testid={`audit-row-${entry.sequence}`}
                        >
                            <div className='studio-audit__row-top'>
                                <div className='studio-audit__path-group'>
                                    <span className='studio-audit__sequence'>#{entry.sequence}</span>
                                    <span className='studio-audit__path'>{entry.relativePath}</span>
                                </div>
                                <span
                                    className={`studio-status-badge studio-status-badge--${entry.outcome}`}
                                    data-testid={`audit-outcome-${entry.sequence}`}
                                >
                                    {formatOutcomeLabel(entry.outcome)}
                                </span>
                            </div>
                            <dl className='studio-audit__meta'>
                                <div>
                                    <dt>Hash</dt>
                                    <dd>{entry.contentHash}</dd>
                                </div>
                                <div>
                                    <dt>SHA</dt>
                                    <dd>{entry.sha}</dd>
                                </div>
                                <div>
                                    <dt>Time</dt>
                                    <dd>{entry.time}</dd>
                                </div>
                            </dl>
                        </article>
                    ))}
                </div>
            </div>
        );
    }

    protected getVisibleEntries(): AuditEntryViewModel[] {
        const entries = this.getAuditEntries();
        if (this.activeFilter === 'all') {
            return entries;
        }
        return entries.filter(entry => entry.outcome === this.activeFilter);
    }

    protected getCounts(): { total: number; latestTime?: string; byFilter: Map<AuditFilter, number> } {
        const entries = this.getAuditEntries();
        const byFilter = new Map<AuditFilter, number>(AUDIT_FILTERS.map(filter => [filter.id, 0]));
        for (const entry of entries) {
            byFilter.set(entry.outcome, (byFilter.get(entry.outcome) ?? 0) + 1);
        }
        return {
            total: entries.length,
            latestTime: entries[0]?.time,
            byFilter: byFilter.set('all', entries.length)
        };
    }

    protected getAuditEntries(): AuditEntryViewModel[] {
        return this.audit.getEntries().map(toViewModel);
    }
}

function toViewModel(entry: StudioAuditEntry): AuditEntryViewModel {
    return {
        sequence: entry.sequence,
        relativePath: entry.relativePath,
        contentHash: entry.contentHash,
        sha: entry.sha || 'Unavailable',
        time: entry.time,
        outcome: entry.outcome
    };
}

function formatOutcomeLabel(outcome: AuditOutcome): string {
    switch (outcome) {
        case 'modified':
            return 'Modified';
        case 'committed':
            return 'Committed';
        case 'pushing':
            return 'Pushing';
        case 'pushed':
            return 'Pushed';
        case 'pending':
            return 'Pending';
        case 'failed':
            return 'Failed';
        case 'blocked':
            return 'Blocked';
        default:
            return 'Modified';
    }
}
