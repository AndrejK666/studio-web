// A host's say over the "Workspace source suggestion" notification.
//
// The workspace sources controller raises the suggestion whenever the opened
// folder sits inside a repository the workspace does not configure yet. A host
// may know that a folder is not the member's work at all -- the desktop's
// placeholder (`~/ConstructorStudio/workspace`) -- and bind this to keep quiet
// about it. Nothing binds it in a session, where the notification is unchanged.

import type { WorkspaceRepositorySuggestion } from '../common/workspace-protocol';

export const WorkspaceSuggestionGate = Symbol('WorkspaceSuggestionGate');

export interface WorkspaceSuggestionGate {
    /** True to raise no notification for this suggestion. */
    suppresses(suggestion: WorkspaceRepositorySuggestion): Promise<boolean>;
}
