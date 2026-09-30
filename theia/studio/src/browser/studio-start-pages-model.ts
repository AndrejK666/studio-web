// What the Development, Agent development and Full functionality start pages
// say, as plain functions -- no Theia, no fetch, no DOM -- tested in
// studio-start-pages-model.test.ts. studio-start-pages.ts reads and registers.
//
// Every list here is read when the page is shown and is a glance: the rows open
// the view where the whole list lives (Source Control, the Orca panel, the
// file). What cannot be told is said, not guessed: a session's repository row
// shows what its SCM provider reports and nothing about a remote it did not
// report.

import { repositoryLine, type DesktopGitRepository } from '../common/desktop-git';
import type { OrcaRepository, OrcaRuntimeStatus, OrcaWorktree } from '../common/orca-protocol';
import { groupWorktrees } from '../common/orca-worktree-groups';
import type { StartRow, StartSection } from './start-page-hub';

/** Rows per list; the layer caps again and counts the rest. */
export const LIST_MAX = 6;

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** "3 min ago", from epoch millis. */
export function agoText(at: number | undefined, now: number): string {
    if (!at || !Number.isFinite(at)) {
        return '';
    }
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 60) {
        return 'just now';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    return plural(Math.round(hours / 24), 'day', 'days') + ' ago';
}

/** Slashes one way, no trailing slash: how two spellings of one folder compare. */
function normalized(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** `path` relative to the first root that holds it, else `path` as given. */
export function relativeTo(roots: readonly string[], path: string): string {
    const p = normalized(path);
    for (const root of roots.map(normalized)) {
        if (p.toLowerCase() === root.toLowerCase()) {
            return '';
        }
        if (p.toLowerCase().startsWith(root.toLowerCase() + '/')) {
            return p.slice(root.length + 1);
        }
    }
    return p;
}

// -- repositories ---------------------------------------------------------------

/** A desktop clone: its branch, how far from its remote, what is not committed. */
export function desktopRepositoryRow(repository: DesktopGitRepository): StartRow {
    const behind = repository.behind ?? 0;
    const ahead = repository.ahead ?? 0;
    return {
        name: repository.name || repository.path,
        detail: repositoryLine(repository),
        folder: repository.remote,
        tag: repository.changed > 0 ? `${repository.changed} changed` : ahead > 0 ? `${ahead} to push` : behind > 0 ? `${behind} to pull` : undefined,
        title: repository.path,
    };
}

/**
 * The branch in the title an SCM provider shows in the status bar:
 * `$(git-branch) main*` → `main`. The icon and git's dirty markers are not part
 * of the name.
 */
export function branchOfStatusTitle(title: string | undefined): string | undefined {
    if (!title) {
        return undefined;
    }
    const name = title.replace(/\$\([^)]*\)/g, '').trim().replace(/[*+!]+$/, '').trim();
    return name || undefined;
}

/** What a session's SCM provider reports about one repository. */
export interface ScmRepositoryFacts {
    readonly rootPath: string;
    readonly label: string;
    readonly statusTitles: readonly string[];
    /** The uris of every changed resource, across the provider's groups. */
    readonly changed: readonly string[];
}

export function scmRepositoryRow(facts: ScmRepositoryFacts, roots: readonly string[]): StartRow {
    const branch = facts.statusTitles.map(branchOfStatusTitle).find(Boolean);
    const changed = new Set(facts.changed).size;
    const relative = relativeTo(roots, facts.rootPath);
    const name = relative || facts.rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || facts.label;
    const parts = [branch ? `on ${branch}` : `${facts.label || 'Source control'}`];
    if (changed > 0) {
        parts.push(`${plural(changed, 'file', 'files')} changed, not committed`);
    } else {
        parts.push('nothing to commit');
    }
    return {
        name,
        detail: parts.join(' · '),
        tag: changed > 0 ? `${changed} changed` : undefined,
        title: facts.rootPath,
    };
}

export type RepositorySource = 'desktop' | 'session' | 'none';

export function repositoriesSection(rows: readonly StartRow[], source: RepositorySource, options: { hasProject: boolean; note?: string }): StartSection {
    let empty: string;
    if (!options.hasProject) {
        empty = 'No project is open.';
    } else if (source === 'desktop') {
        empty = 'This folder holds no git repository. Open a project from the Constructor Studio view to clone its sources.';
    } else {
        empty = 'Source control has not found a git repository in this project yet.';
    }
    return {
        id: 'development.repositories',
        title: 'Repositories',
        count: rows.length ? plural(rows.length, 'repository', 'repositories') : undefined,
        rows,
        empty,
        note: options.note,
    };
}

// -- recent files ---------------------------------------------------------------

/**
 * The files last opened in an editor, newest first, one row each.
 *
 * `uris` is Theia's navigation history (`NavigationLocationService.locations()`)
 * in its own chronological order -- what Quick Open lists as recently opened --
 * so it is walked from the end. Only files under the open project's folders:
 * the history outlives a project switch.
 */
export function recentFileRows(uris: readonly string[], roots: readonly string[], max = LIST_MAX): StartRow[] {
    const seen = new Set<string>();
    const rows: StartRow[] = [];
    const rootPaths = roots.map(r => normalized(r));
    for (let i = uris.length - 1; i >= 0 && rows.length < max; i--) {
        const uri = uris[i];
        if (!uri || seen.has(uri)) {
            continue;
        }
        seen.add(uri);
        if (!rootPaths.some(root => uri.startsWith(root + '/'))) {
            continue;
        }
        const relative = decodeURIComponentSafe(relativeTo(rootPaths, uri));
        const parts = relative.split('/');
        const name = parts.pop() || relative;
        rows.push({ name, folder: parts.join('/'), title: relative, open: uri });
    }
    return rows;
}

function decodeURIComponentSafe(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

// -- agents ---------------------------------------------------------------------

/** One coding assistant the IDE can open, as the page lists it. */
export interface AssistantFacts {
    readonly label: string;
    /** The command that opens it; the row is left out when this build has none. */
    readonly command: string;
    readonly args?: readonly unknown[];
}

/** What Orca's runtime row says, from its status. */
export function orcaRow(status: OrcaRuntimeStatus | undefined, error: string | undefined): StartRow {
    if (!status) {
        return { name: 'Orca', detail: error ? `Could not be asked: ${error}` : 'Not asked yet', tag: undefined };
    }
    if (status.reachable) {
        const agents = (status.agents ?? []).length ? `agents: ${(status.agents ?? []).join(', ')}` : 'no agent CLI found';
        return {
            name: 'Orca',
            detail: `Running${status.appVersion ? ` ${status.appVersion}` : ''} · ${agents}`,
            tag: status.state && status.state !== 'unknown' ? status.state : undefined,
        };
    }
    if (status.cliMissing) {
        return {
            name: 'Orca',
            detail: status.host === 'session' ? 'Not in this session\'s image' : 'Not installed on this computer',
        };
    }
    return {
        name: 'Orca',
        detail: status.host === 'local'
            ? 'Not running. The Agents panel starts it.'
            : `Not answering${status.error ? `: ${status.error}` : ''}`,
    };
}

export function agentsSection(orca: StartRow | undefined, assistants: readonly AssistantFacts[]): StartSection {
    const rows: StartRow[] = [];
    if (orca) {
        rows.push(orca);
    }
    for (const assistant of assistants) {
        rows.push({
            name: assistant.label,
            detail: `Open ${assistant.label} beside the project`,
            command: assistant.command,
            args: assistant.args ? [...assistant.args] : undefined,
        });
    }
    return {
        id: 'agents.list',
        title: 'Agents',
        rows,
        empty: 'No coding agent is available in this build.',
    };
}

/** Orca's worktrees, the ones an agent touched last first; the main checkouts after. */
export function worktreeRows(worktrees: readonly OrcaWorktree[], now: number, max = LIST_MAX): StartRow[] {
    return worktrees.slice()
        .sort((a, b) => Number(a.isMain) - Number(b.isMain)
            || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
            || a.path.localeCompare(b.path))
        .slice(0, max)
        .map(worktree => ({
            name: worktree.displayName || worktree.branch || worktree.path,
            detail: [worktree.branch && worktree.branch !== worktree.displayName ? worktree.branch : '', worktree.comment]
                .filter(Boolean).join(' · ') || undefined,
            folder: worktree.path,
            tag: worktree.isMain ? undefined : (worktree.status || undefined),
            meta: agoText(worktree.lastActivityAt, now) || undefined,
            title: worktree.path,
        }));
}

/**
 * The worktrees of this project's repositories, as the Agents panel groups them
 * (`groupWorktrees`): a member's own Orca knows every repository they ever
 * added, and the page is about the project open here. The rest are counted.
 */
export function projectWorktrees(
    worktrees: readonly OrcaWorktree[], repositories: readonly OrcaRepository[], projectRoot: string | undefined,
): { worktrees: OrcaWorktree[]; elsewhere: number } {
    const groups = groupWorktrees(worktrees, repositories, projectRoot);
    const mine = groups.filter(group => group.inProject).flatMap(group => [...group.worktrees]);
    return { worktrees: mine, elsewhere: worktrees.length - mine.length };
}

export function worktreesSection(
    rows: readonly StartRow[], total: number, state: { reachable: boolean; error?: string; elsewhere?: number },
): StartSection {
    const elsewhere = state.elsewhere ?? 0;
    return {
        id: 'agents.worktrees',
        title: 'Worktrees',
        count: total ? plural(total, 'worktree', 'worktrees') : undefined,
        rows,
        more: Math.max(0, total - rows.length),
        empty: state.error
            ? `Orca could not list them: ${state.error}`
            : !state.reachable
                ? 'Orca is not running, so its worktrees cannot be listed.'
                : elsewhere
                    ? 'Orca has no worktree of this project\'s repositories. The Agents panel adds them to Orca and starts a task.'
                    : 'No worktree yet. Start a task in the Agents panel and its agent gets its own.',
        note: elsewhere ? `${plural(elsewhere, 'worktree', 'worktrees')} of other repositories ${elsewhere === 1 ? 'is' : 'are'} in the Agents panel.` : undefined,
    };
}

// -- Full functionality ---------------------------------------------------------

export interface ModeFacts {
    readonly role: string;
    readonly label: string;
    readonly title: string;
    readonly perspective: string;
}

/** A mode's first thing to do, run after switching to it. */
export interface ModePrimary {
    readonly label: string;
    readonly command?: string;
}

/**
 * One row per mode but Full itself: its name, what it is for, and the one thing
 * to start it with. The row switches to the mode and runs that.
 */
export function modeOverview(modes: readonly ModeFacts[], primaries: Readonly<Record<string, ModePrimary>>, fullRole = 'full'): Array<ModeFacts & { primary?: ModePrimary }> {
    return modes
        .filter(mode => mode.role !== fullRole)
        .map(mode => ({ ...mode, primary: primaries[mode.role] }));
}
