/**
 * The projects somebody opened last, newest first: the sidebar's "Recent"
 * under Projects (the designer's prototype). Kept per browser, as the pins
 * are (`pins/pins.ts`): an entry is an address and the names to draw it with,
 * more than the 128 characters a `/me/ui-preferences` value may hold.
 *
 * Recorded in both layouts, so switching to the sidebar finds the list
 * already filled.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useAppSelector } from '@gears-frontx/react';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { useScreenLevel } from '../useScreenLevel';

export interface RecentProject {
  org: { id: string; name: string };
  workspace: { id: string; name: string };
  project: { id: string; name: string };
}

export const RECENT_PROJECTS_KEY = 'studio.recent-projects.v1';
/** How many the sidebar lists. */
export const RECENT_PROJECTS_MAX = 5;

const isNamed = (value: unknown): value is { id: string; name: string } =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Record<string, unknown>).id === 'string' &&
  typeof (value as Record<string, unknown>).name === 'string' &&
  !!(value as Record<string, string>).id;

/** What a browser holds, without anything this build cannot read. */
export function parseRecent(raw: unknown): RecentProject[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentProject[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (!isNamed(e.org) || !isNamed(e.workspace) || !isNamed(e.project)) continue;
    if (out.some((r) => r.project.id === (e.project as { id: string }).id)) continue;
    out.push({
      org: { id: e.org.id, name: e.org.name },
      workspace: { id: e.workspace.id, name: e.workspace.name },
      project: { id: e.project.id, name: e.project.name },
    });
  }
  return out.slice(0, RECENT_PROJECTS_MAX);
}

/** `opened` at the head, the same project further down dropped, the list capped. */
export function withRecent(list: readonly RecentProject[], opened: RecentProject): RecentProject[] {
  return [opened, ...list.filter((r) => r.project.id !== opened.project.id)].slice(0, RECENT_PROJECTS_MAX);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let current: RecentProject[] | null = null;
const listeners = new Set<() => void>();

function snapshot(): RecentProject[] {
  if (current === null) {
    try {
      const raw = safeStorage()?.getItem(RECENT_PROJECTS_KEY);
      current = raw ? parseRecent(JSON.parse(raw)) : [];
    } catch {
      current = [];
    }
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function rememberProject(opened: RecentProject): void {
  const list = snapshot();
  const head = list[0];
  if (
    head &&
    head.project.id === opened.project.id &&
    head.project.name === opened.project.name &&
    head.workspace.name === opened.workspace.name &&
    head.org.name === opened.org.name
  ) {
    return;
  }
  current = withRecent(list, opened);
  try {
    safeStorage()?.setItem(RECENT_PROJECTS_KEY, JSON.stringify(current));
  } catch {
    /* the list still holds for this session */
  }
  for (const listener of [...listeners]) listener();
}

/** Forgets the in-memory list. For tests. */
export function resetRecentProjectsForTests(): void {
  current = null;
}

export function useRecentProjects(): RecentProject[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Records the project on screen, once its names are known. */
export function useRecordRecentProject(): void {
  const level = useScreenLevel();
  const context = useAppSelector((state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined);
  const orgId = context?.org?.id ?? '';
  const orgName = context?.org?.name ?? '';
  const workspaceId = context?.workspace?.id ?? '';
  const workspaceName = context?.workspace?.name ?? '';
  const projectId = context?.project?.id ?? '';
  const projectName = context?.project?.name ?? '';
  const ready = level === 'project' && !!orgName && !!workspaceName && !!projectName;
  useEffect(() => {
    if (!ready) return;
    rememberProject({
      org: { id: orgId, name: orgName },
      workspace: { id: workspaceId, name: workspaceName },
      project: { id: projectId, name: projectName },
    });
  }, [ready, orgId, orgName, workspaceId, workspaceName, projectId, projectName]);
}
