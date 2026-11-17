import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import type { ArtifactRow } from '../../../model/artifact';
import type { ArtifactsQuery } from '../../../shared/useArtifacts';

// The kit's DataGrid measures its header.
stubResizeObserver();

/** The Artifacts list on the grid (#1076): the gear's pages, its search and filters, its empty and failed states. */

const { artifacts } = vi.hoisted(() => ({
  artifacts: {
    rows: [] as ArtifactRow[],
    fail: false,
    reads: [] as { query: ArtifactsQuery; offset: number; limit: number }[],
  },
}));

vi.mock('@gears-frontx/react', () => ({
  useFormatters: () => ({ formatRelative: () => '' }),
  useMfeBridge: () => ({}),
}));
vi.mock('@constructor-studio/mfe-shared', () => ({
  useOrganization: () => ({ org: { id: 'org-1', name: 'Acme' } }),
  useWorkspace: () => ({ workspace: null }),
}));
vi.mock('../../../i18n', () => ({
  useProjectText: () =>
    Object.assign(
      (key: string, params?: object) => (params ? `${key} ${JSON.stringify(params)}` : key),
      {
        count: (key: string, count: number, params?: object) =>
          `${key} ${JSON.stringify({ ...params, count })}`,
      }
    ),
}));
vi.mock('../../../shared/useArtifactImport', () => ({
  useArtifactImport: () => ({ canSync: false, start: () => {} }),
  useProjectImport: () => ({ phase: 'idle', repos: [] }),
}));
vi.mock('../../../shared/useArtifacts', () => {
  const repoNames = new Map([['r-1', 'acme/api']]);
  const own: never[] = [];
  return {
    useArtifacts: () => ({
      projectTotal: artifacts.rows.length,
      repositoryTotal: null,
      repositoryTotalFailed: false,
      repositories: [{ id: 'r-1', name: 'acme/api' }],
      repoNames,
      own,
      sources: [],
      loading: false,
      failed: false,
      refetch: () => {},
    }),
    readArtifactsPage: (
      _projectId: string,
      _own: unknown,
      _names: unknown,
      query: ArtifactsQuery,
      offset: number,
      limit: number
    ) => {
      artifacts.reads.push({ query, offset, limit });
      if (artifacts.fail) return Promise.reject(new Error('down'));
      const kept = artifacts.rows.filter((row) => row.name.toLowerCase().includes(query.search.toLowerCase()));
      return Promise.resolve({ rows: kept.slice(offset, offset + limit), total: kept.length });
    },
  };
});
vi.mock('../upload/UploadPanel', () => ({ UploadPanel: () => null }));

import { ArtifactsSection } from './ArtifactsSection';

const row = (id: string, name: string): ArtifactRow => ({
  id,
  kind: 'file',
  name,
  repository: 'acme/api',
  path: `docs/${id}`,
  url: null,
  sync: 'ingested',
  updatedAt: null,
  provenance: 'tree',
});

beforeEach(() => {
  artifacts.rows = [row('a', 'README.md'), row('b', 'CHANGELOG.md')];
  artifacts.fail = false;
  artifacts.reads.length = 0;
});

describe('artifacts section', () => {
  it('renders the gear page through the grid, and its search narrows the rows', async () => {
    render(<ArtifactsSection projectId="p1" projectName="Billing" />);
    expect(await screen.findByText('README.md')).toBeTruthy();
    expect(document.querySelector('[data-list-grid="artifacts"]')).toBeTruthy();
    expect(artifacts.reads[0]).toMatchObject({ offset: 0, limit: 25, query: { repo: null, kind: null } });

    fireEvent.change(screen.getByPlaceholderText('artifacts_search'), { target: { value: 'change' } });
    await waitFor(() => expect(screen.queryByText('README.md')).toBeNull());
    expect(screen.getByText('CHANGELOG.md')).toBeTruthy();
    expect(artifacts.reads[artifacts.reads.length - 1].query.search).toBe('change');
  });

  it('says nothing matched, and clears the search', async () => {
    render(<ArtifactsSection projectId="p1" projectName="Billing" />);
    await screen.findByText('README.md');
    fireEvent.change(screen.getByPlaceholderText('artifacts_search'), { target: { value: 'nothing' } });
    expect(await screen.findByText('artifacts_no_matches')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'artifacts_clear_filters' }));
    expect(await screen.findByText('README.md')).toBeTruthy();
  });

  it('says why the list is missing, and reads it again from Retry', async () => {
    artifacts.fail = true;
    render(<ArtifactsSection projectId="p1" projectName="Billing" />);
    expect((await screen.findByRole('alert')).textContent).toContain('artifacts_read_failed');
    artifacts.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'artifacts_retry' }));
    expect(await screen.findByText('README.md')).toBeTruthy();
  });

  it('shows the project empty state when the project has nothing at all', () => {
    artifacts.rows = [];
    render(<ArtifactsSection projectId="p1" projectName="Billing" />);
    expect(screen.getByText('artifacts_empty_title')).toBeTruthy();
    expect(document.querySelector('[data-list-grid="artifacts"]')).toBeNull();
  });
});
