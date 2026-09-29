// The desktop backend's routes, as one module the landing page calls
// (ADR-0027). The same routes the Studio view (desktop-studio-widget.tsx) and
// the `cfstudio://` link handler call: sign in, pick a Studio, list the
// member's projects, clone one and follow its progress. The backend decides
// everything; these only ask it.

import { StudioApi } from './studio-api';
import { desktopUrl } from './desktop-studio-widget';
import { Organization, projectsOf } from './desktop-projects';
import { SourcesState, sourcesStateOf } from './desktop-studio-tree';
import type { OpenProgress } from '../common/desktop-open-progress';

/** Start the sign-in: the backend opens the Constructor ID page in the browser. */
export async function startSignIn(): Promise<void> {
    await fetch(desktopUrl('sign-in'), { method: 'POST' });
}

/** Connect to another Studio (the backend signs out of this one first); the error, if refused. */
export async function switchStudio(target: { id: string } | { studioUrl: string }): Promise<string | undefined> {
    const answer = await fetch(desktopUrl('environment'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
    });
    if (answer.ok) {
        return undefined;
    }
    return ((await answer.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${answer.status}`;
}

/** The member's organizations, workspaces and projects, through the backend's Studio proxy. */
export function loadProjects(): Promise<Organization[]> {
    return projectsOf(async path => {
        const answer = await StudioApi.fetch(path);
        if (!answer.ok) {
            throw new Error(`HTTP ${answer.status}`);
        }
        return answer.json();
    });
}

/** What a project's sources listing says: the listing the open itself starts with. */
export async function sourcesOf(id: string): Promise<SourcesState> {
    try {
        const answer = await StudioApi.fetch(`/studio-git/v1/sources?project_id=${encodeURIComponent(id)}`);
        return sourcesStateOf(answer.status, await answer.json().catch(() => undefined));
    } catch {
        return { state: 'unknown' };
    }
}

/**
 * Clone a project's sources through Studio into `folder` and answer the local
 * path to open, calling `onProgress` while the backend reports it. Throws
 * with the backend's reason.
 */
export async function openStudioProject(
    workspaceId: string, folder: string, onProgress: (progress: OpenProgress) => void, pollMs = 400,
): Promise<string> {
    const poll = setInterval(async () => {
        try {
            const progress = await (await fetch(desktopUrl('open-progress'))).json() as OpenProgress | null;
            if (progress?.workspaceId === workspaceId) {
                onProgress(progress);
            }
        } catch {
            // A backend from before this route: no progress, only the spinner.
        }
    }, pollMs);
    try {
        const answer = await fetch(desktopUrl('open'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, name: folder }),
        });
        const body = await answer.json().catch(() => ({})) as { path?: string; error?: string };
        if (!answer.ok || !body.path) {
            throw new Error(body.error ?? `HTTP ${answer.status}`);
        }
        return body.path;
    } finally {
        clearInterval(poll);
    }
}
