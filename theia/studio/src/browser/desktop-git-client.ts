// The desktop backend's git routes (`/studio-desktop/git/*`,
// node/desktop-git.ts), beside desktop-studio-client.ts and built on its
// `desktopUrl`: what the Sources view lists, and what Sync and Push do.
// Each answers or throws with the backend's reason.

import type { DesktopGitPush, DesktopGitRepository, DesktopGitSync } from '../common/desktop-git';
import { desktopUrl } from './desktop-studio-client';

async function answerOf<T>(answer: Response): Promise<T> {
    const body = await answer.json().catch(() => ({})) as T & { error?: string };
    if (!answer.ok) {
        throw new Error(body.error ?? `HTTP ${answer.status}`);
    }
    return body;
}

/** The clones in the folder `root`. */
export async function desktopRepositories(root: string): Promise<DesktopGitRepository[]> {
    const answer = await fetch(`${desktopUrl('git/repositories')}?root=${encodeURIComponent(root)}`);
    return (await answerOf<{ repositories: DesktopGitRepository[] }>(answer)).repositories;
}

/** Fetch every clone in `root`, and fast-forward those that only need it. */
export async function desktopSync(root: string): Promise<DesktopGitSync[]> {
    const answer = await fetch(desktopUrl('git/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root }),
    });
    return (await answerOf<{ results: DesktopGitSync[] }>(answer)).results;
}

/** Push the current branch of the clone at `repository`, in `root`. */
export async function desktopPush(root: string, repository: string): Promise<DesktopGitPush> {
    const answer = await fetch(desktopUrl('git/push'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, repository }),
    });
    return answerOf<DesktopGitPush>(answer);
}
