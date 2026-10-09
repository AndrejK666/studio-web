import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

interface TestContext {
  org: { id: string; name: string; count?: number } | null;
  orgs: { id: string; name: string; count?: number }[];
  workspace: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  workspacesStatus: 'pending' | 'ready' | 'failed';
  loading: boolean;
}

const { mockEventBus, context, level } = vi.hoisted(() => ({
  mockEventBus: { emit: vi.fn() },
  level: { value: 'organization' as 'organization' | 'workspace' | 'project' },
  context: { value: {} as TestContext },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ 'app/context': context.value }),
  eventBus: mockEventBus,
}));

vi.mock('@/app/i18n/shellTranslations', () => import('@frontx-test-utils/shellText'));

vi.mock('./useScreenLevel', () => ({ useScreenLevel: () => level.value }));

import { LevelHeader } from './LevelHeader';

const heading = () => screen.getByRole('heading', { level: 1 });

describe('LevelHeader (names the level in scope)', () => {
  beforeEach(() => {
    level.value = 'organization';
    context.value = {
      org: { id: 'org-1', name: 'Acme Corporation', count: 3 },
      orgs: [
        { id: 'org-1', name: 'Acme Corporation', count: 3 },
        { id: 'org-2', name: 'Constructor Labs', count: 2 },
      ],
      workspace: { id: 'ws-1', name: 'Platform Workspace' },
      project: { id: 'p-1', name: 'Agent Platform' },
      workspacesStatus: 'ready',
      loading: false,
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('the organization', () => {
    it('is the page heading at its own level', () => {
      render(<LevelHeader />);
      expect(heading().textContent).toBe('Acme Corporation');
    });

    it('switches the organization from the header', async () => {
      render(<LevelHeader />);
      fireEvent.click(screen.getByText('Switch organization'));
      fireEvent.click(await screen.findByText('Constructor Labs'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/org/changed', {
        orgId: 'org-2',
      });
    });

    it('counts the workspaces of each organization in the switch', async () => {
      render(<LevelHeader />);
      fireEvent.click(screen.getByText('Switch organization'));
      expect(await screen.findByText('3 workspaces')).toBeTruthy();
      expect(screen.getByText('2 workspaces')).toBeTruthy();
    });

    it('offers no switch to a person in one organization', () => {
      context.value.orgs = [context.value.orgs[0]!];
      render(<LevelHeader />);
      expect(screen.queryByText('Switch organization')).toBeNull();
    });
  });

  it('names the workspace, with its organization above it', () => {
    level.value = 'workspace';
    render(<LevelHeader />);
    expect(heading().textContent).toBe('Platform Workspace');
    expect(screen.getByText('Acme Corporation')).toBeTruthy();
    expect(screen.queryByText('Switch organization')).toBeNull();
  });

  describe('the workspace before its list is read', () => {
    beforeEach(() => {
      level.value = 'workspace';
      context.value.workspace = null;
    });

    it('holds a placeholder, not the organization', () => {
      context.value.workspacesStatus = 'pending';
      render(<LevelHeader />);
      expect(screen.getByTestId('level-header-pending')).toBeTruthy();
      expect(screen.queryByRole('heading')).toBeNull();
      expect(screen.queryByText('Switch organization')).toBeNull();
    });

    it('stays empty when the read failed', () => {
      context.value.workspacesStatus = 'failed';
      const { container } = render(<LevelHeader />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('the project', () => {
    beforeEach(() => {
      level.value = 'project';
    });

    it('is the page heading', () => {
      render(<LevelHeader />);
      expect(heading().textContent).toBe('Agent Platform');
    });

    it('holds a placeholder, not an empty heading, while a linked project is unnamed', () => {
      context.value.project = { id: 'p-9', name: '' };
      render(<LevelHeader />);
      expect(screen.queryByRole('heading')).toBeNull();
      expect(screen.getByTestId('level-header-pending')).toBeTruthy();
    });

    it('goes back to the projects list by asking for the workspace level', () => {
      render(<LevelHeader />);
      fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/level/requested', {
        level: 'workspace',
      });
    });
  });

  it('holds a placeholder while the organization is being read', () => {
    context.value = { ...context.value, org: null, loading: true };
    const { container } = render(<LevelHeader />);
    expect(container.firstChild).not.toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders nothing when there is no organization', () => {
    context.value = { ...context.value, org: null };
    const { container } = render(<LevelHeader />);
    expect(container.firstChild).toBeNull();
  });
});
