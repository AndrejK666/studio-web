// Opening a Studio project on the desktop without reloading the window.
//
// `WorkspaceService.open(folder, { preserveWindow: true })` changes the window's
// workspace by reloading the frontend (`reloadWindow`): every panel, the
// assistants and the plugin host start again, and a member who has just signed
// in and picked a project watches the whole IDE restart. Theia changes a
// workspace's folders in place when the workspace is a file -- that is how
// "Add Folder to Workspace" works -- so a project is opened as one:
//
//   1. `save(<project>.theia-workspace)` makes the window's workspace that file,
//      in place (`setWorkspace`, no reload). Named after the project, so the
//      title bar and the Explorer say the project's name, and next to the
//      project's folder, so each project keeps its own layout and settings.
//   2. `spliceRoots` replaces the folders with the project's, in place, and
//      fires `onWorkspaceChanged`, which everything that shows a folder follows.
//
// The next start reopens the most recently used workspace, which is this file:
// the member lands in the project, not on the placeholder.

import URI from '@theia/core/lib/common/uri';
import type { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';

export const PROJECT_WORKSPACE_EXTENSION = '.theia-workspace';

/** The workspace file a project folder opens as: `<folder>.theia-workspace` beside it. */
export function projectWorkspaceFile(folder: URI): URI {
    return folder.parent.resolve(`${folder.path.base}${PROJECT_WORKSPACE_EXTENSION}`);
}

/** The parts of `WorkspaceService` this needs, so it is tested without Theia. */
export type ProjectWorkspace = Pick<WorkspaceService, 'workspace' | 'tryGetRoots' | 'save' | 'spliceRoots'>;

/** Open `folder` as the window's only folder, without reloading the window. */
export async function openProjectInPlace(workspace: ProjectWorkspace, folder: URI): Promise<void> {
    const file = projectWorkspaceFile(folder);
    if (!workspace.workspace || workspace.workspace.isDirectory || !workspace.workspace.resource.isEqual(file)) {
        await workspace.save(file);
    }
    const roots = workspace.tryGetRoots();
    if (roots.length === 1 && roots[0].resource.isEqual(folder)) {
        return;
    }
    await workspace.spliceRoots(0, roots.length, folder);
}
