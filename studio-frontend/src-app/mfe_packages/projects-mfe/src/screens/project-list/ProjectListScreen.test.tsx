import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The list's header and its states around the grid (DoD
 * `...-workspace-scope-no-workspace`). The grid itself is `ProjectsGrid.test`.
 */

const { scope, bridge, openProjectWizard, retry } = vi.hoisted(() => ({
  scope: {
    current: {
      loading: false,
      failed: false,
      org: { id: 'org-1', name: 'Acme' } as unknown,
      workspace: { id: 'ws-1', name: 'Platform' } as unknown,
      projects: [] as unknown[],
    },
  },
  bridge: { id: 'bridge' },
  openProjectWizard: vi.fn(),
  retry: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useMfeBridge: () => bridge,
}));

vi.mock('../../i18n', () => ({
  useProjectListText: () => (key: string) => key,
  useProjectListScreenTranslations: () => ({ isLoaded: true, error: null }),
}));

vi.mock('../../shared/workspaceProjects', () => ({
  WorkspaceProjectsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWorkspaceProjects: () => ({ ...scope.current, retry }),
}));
vi.mock('../../actions/wizardActions', () => ({ openProjectWizard }));
vi.mock('./components/ProjectsGrid', () => ({
  ProjectsGrid: () => <div data-testid="grid" />,
}));

import { ProjectListScreen } from './ProjectListScreen';

const newProject = () => screen.getByRole('button', { name: 'new_project' }) as HTMLButtonElement;

beforeEach(() => {
  openProjectWizard.mockClear();
  retry.mockClear();
  scope.current = { ...scope.current, loading: false, failed: false, workspace: { id: 'ws-1', name: 'Platform' } };
});

afterEach(cleanup);

describe('the projects list header', () => {
  it('disables New project and says why while no workspace is current', () => {
    scope.current = { ...scope.current, workspace: null };
    render(<ProjectListScreen />);

    expect(newProject().disabled).toBe(true);
    expect(newProject().getAttribute('title')).toBe('empty_no_workspace');
  });

  it('opens the wizard from New project', () => {
    render(<ProjectListScreen />);

    expect(newProject().getAttribute('title')).toBeNull();
    fireEvent.click(newProject());
    expect(openProjectWizard).toHaveBeenCalledWith(bridge);
  });
});

describe('the projects list states', () => {
  it('shows a skeleton while the projects are read', () => {
    scope.current = { ...scope.current, loading: true };
    render(<ProjectListScreen />);

    expect(document.querySelector('[data-projects-loading]')).not.toBeNull();
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('says the read failed, with a retry, in place of the grid', () => {
    scope.current = { ...scope.current, failed: true };
    render(<ProjectListScreen />);

    expect(screen.getByRole('alert').textContent).toBe('error_title');
    expect(screen.queryByTestId('grid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('draws the grid once the projects are in', () => {
    render(<ProjectListScreen />);

    expect(screen.getByTestId('grid')).toBeTruthy();
  });
});
