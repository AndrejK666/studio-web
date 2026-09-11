/**
 * App Context Slice
 *
 * What the top bar's second slot shows, and what its dropdown offers.
 *
 * The slot has two scopes. At `org` scope it names the organization the session
 * is in and switches between the user's organizations; at `project` scope it
 * names the open project and switches between projects. One slot, because the
 * mockup gives it one place — the scope decides which list is behind the
 * chevron.
 *
 * Ownership is split along the gear that owns the data, and the split is the
 * reason this slice exists rather than the shell fetching everything:
 *
 * - Organizations are account-management, which the shell already talks to
 *   (`AccountsApiService`), so the shell fills `org`/`orgs` itself.
 * - Projects are the studio-project gear, which is projects-mfe's territory.
 *   The shell never requests them; the MFE writes `project`/`projects` in by
 *   emitting `app/context/project/opened` and `app/context/projects`.
 *
 * Until projects-mfe emits those, the slot simply stays at `org` scope. That is
 * the designed resting state, not a missing feature.
 *
 * The workspace is a THIRD pair (`workspace`/`workspaces`) rather than a third
 * scope: it is in scope at the same time as the organization, while `org` and
 * `project` are alternatives to each other.
 */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';

export interface ContextEntity {
  id: string;
  name: string;
}

/** Which list the chevron opens. */
export type ContextScope = 'org' | 'project';
export type WorkspacesStatus = 'pending' | 'ready' | 'failed';

/**
 * Whether this person may act in an organization at all.
 *
 * `unassigned` is a supported, expected state, not an error: an authenticated
 * person with no organization membership has to see an onboarding message rather
 * than an empty switcher or a missing-tenant failure (ADR-0011 §3).
 */
export type AccessState = 'loading' | 'ready' | 'unassigned';

export interface AppContextState {
  scope: ContextScope;
  org: ContextEntity | null;
  orgs: ContextEntity[];
  workspace: ContextEntity | null;
  workspaces: ContextEntity[];
  workspacesStatus: WorkspacesStatus;
  screenUsesWorkspace: boolean;
  project: ContextEntity | null;
  projects: ContextEntity[];
  loading: boolean;
  access: AccessState;
}

const SLICE_KEY = 'app/context' as const;

const initialState: AppContextState = {
  scope: 'org',
  org: null,
  orgs: [],
  workspace: null,
  workspaces: [],
  workspacesStatus: 'pending',
  screenUsesWorkspace: false,
  project: null,
  projects: [],
  loading: false,
  access: 'loading',
};

const {
  slice,
  setContextAccess,
  setContextLoading,
  setContextOrganizations,
  setContextOrg,
  setContextWorkspaces,
  setContextWorkspacesStatus,
  setContextWorkspace,
  addContextWorkspace,
  setScreenUsesWorkspace,
  setContextProjects,
  openContextProject,
  closeContextProject,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    setContextLoading: (state: AppContextState, action: ReducerPayload<boolean>) => {
      state.loading = action.payload;
    },

    setContextAccess: (state: AppContextState, action: ReducerPayload<AccessState>) => {
      state.access = action.payload;
    },

    /** The resolved organization list and which of them is current. */
    setContextOrganizations: (
      state: AppContextState,
      action: ReducerPayload<{ current: ContextEntity | null; items: ContextEntity[] }>
    ) => {
      state.org = action.payload.current;
      state.orgs = action.payload.items;
    },

    setContextOrg: (state: AppContextState, action: ReducerPayload<string>) => {
      const next = state.orgs.find((org) => org.id === action.payload);
      if (!next || next.id === state.org?.id) return;
      state.org = next;
      // Leaving the organization invalidates anything scoped under it.
      state.scope = 'org';
      state.workspace = null;
      state.workspaces = [];
      state.workspacesStatus = 'pending';
      state.project = null;
      state.projects = [];
    },

    // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-6
    setContextWorkspaces: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity[]>
    ) => {
      state.workspaces = action.payload;
      const kept = action.payload.find((item) => item.id === state.workspace?.id);
      state.workspace = kept ?? action.payload[0] ?? null;
    },
    // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-6

    // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-5
    setContextWorkspacesStatus: (
      state: AppContextState,
      action: ReducerPayload<WorkspacesStatus>
    ) => {
      state.workspacesStatus = action.payload;
    },
    // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-5

    setContextWorkspace: (state: AppContextState, action: ReducerPayload<string>) => {
      const next = state.workspaces.find((workspace) => workspace.id === action.payload);
      if (!next || next.id === state.workspace?.id) return;
      state.workspace = next;
      state.scope = 'org';
      state.project = null;
      state.projects = [];
    },

    addContextWorkspace: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity>
    ) => {
      if (!state.workspaces.some((workspace) => workspace.id === action.payload.id)) {
        state.workspaces = [...state.workspaces, action.payload];
      }
      state.workspace = action.payload;
      state.scope = 'org';
      state.project = null;
      state.projects = [];
    },

    setScreenUsesWorkspace: (
      state: AppContextState,
      action: ReducerPayload<boolean>
    ) => {
      state.screenUsesWorkspace = action.payload;
    },

    setContextProjects: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity[]>
    ) => {
      state.projects = action.payload;
    },

    /** A project was opened — the slot starts naming it. */
    openContextProject: (
      state: AppContextState,
      action: ReducerPayload<ContextEntity>
    ) => {
      state.scope = 'project';
      state.project = action.payload;
    },
    closeContextProject: (state: AppContextState) => {
      state.scope = 'org';
      state.project = null;
    },
  },
});

export const appContextSlice = slice;
export {
  setContextAccess,
  setContextLoading,
  setContextOrganizations,
  setContextOrg,
  setContextWorkspaces,
  setContextWorkspacesStatus,
  setContextWorkspace,
  addContextWorkspace,
  setScreenUsesWorkspace,
  setContextProjects,
  openContextProject,
  closeContextProject,
};
export const APP_CONTEXT_SLICE_KEY = SLICE_KEY;

export default slice.reducer;
