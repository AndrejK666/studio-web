import { withOwnQueryCache } from '@frontx-test-utils/withOwnQueryCache';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, i18nRegistry } from '@gears-frontx/react';
import { CONNECTION_LIST_NAMESPACE } from '../../../i18n';
import en from '../i18n/en.json';
import { ConnectionsGrid } from './ConnectionsGrid';
import type { ConnectionRow } from '../../../shared/useConnectionList';

/**
 * The list on the kit's DataGrid (#1076), without any HTTP. The health cell is
 * the one part that would reach the network, so it is stubbed: what this test
 * is for is the other five columns, and above all that the four without a data
 * source render a placeholder rather than a value borrowed from a different
 * fact; then the search, the empty states and the footer.
 */
vi.mock('@gears-frontx/react', (importOriginal) => withOwnQueryCache(importOriginal));

vi.mock('./HealthInline', () => ({
  HealthInline: ({ connectionId, tenantId }: { connectionId: string; tenantId: string }) => (
    <span data-testid={`health-${connectionId}`}>{tenantId}</span>
  ),
}));

// The kit's DataGrid measures its table.
stubResizeObserver();

function connectionRow(id: string, label: string, account = 'constructorfabric'): ConnectionRow {
  return {
    id,
    connection: {
      id,
      owner_tenant_id: 'org-1',
      provider: 'github',
      label,
      account,
      base_url: 'https://api.github.com',
      scope: 'organization',
      secret_ref: 'ref',
      created_at_epoch_secs: 1_700_000_000,
    },
    providerName: 'GitHub',
  };
}

const ROW = connectionRow('c-1', 'Platform GitHub');

async function mount(rows: ConnectionRow[], tenantId = 'org-1') {
  const { mfeApp } = await import('../../../init');
  i18nRegistry.register(CONNECTION_LIST_NAMESPACE, 'en' as never, en);

  render(
    <FrontXProvider app={mfeApp}>
      <ConnectionsGrid rows={rows} tenantId={tenantId} />
    </FrontXProvider>
  );
}

const shownIds = () =>
  Array.from(document.querySelectorAll('[data-connection-row]')).map((row) => row.getAttribute('data-connection-row'));

afterEach(cleanup);

describe('ConnectionsGrid rows', () => {
  it('names the connection and captions it with the account and the scope', async () => {
    await mount([ROW]);

    expect(await screen.findByText('Platform GitHub')).toBeTruthy();
    expect(screen.getByText('constructorfabric · organization')).toBeTruthy();
  });

  it('gives the row its own health cell, scoped to the organization', async () => {
    await mount([ROW]);

    expect((await screen.findByTestId('health-c-1')).textContent).toBe('org-1');
  });

  it('renders a placeholder in all four columns with no data source', async () => {
    await mount([ROW]);
    await screen.findByText('Platform GitHub');

    // One per gap: available data, projects, last sync, actions.
    for (const gap of [en.no_data, en.no_projects, en.no_sync, en.no_actions]) {
      expect(screen.getByTitle(gap).textContent).toBe('—');
    }
  });

  it("never shows the record's creation time under Last sync", async () => {
    await mount([ROW]);
    await screen.findByText('Platform GitHub');

    // 1_700_000_000 is 2023 — any rendering of it, relative or absolute, is wrong.
    expect(screen.queryByText(/2023|ago/)).toBeNull();
  });

  it('draws every column the mockup has', async () => {
    await mount([ROW]);
    await screen.findByText('Platform GitHub');

    const heads = screen.getAllByRole('columnheader').map((head) => head.textContent ?? '');
    for (const head of [
      en.col_connection,
      en.col_status,
      en.col_available,
      en.col_projects,
      en.col_last_sync,
      en.col_actions,
    ]) {
      expect(heads.some((text) => text.includes(head))).toBe(true);
    }
  });

  it('keeps the order the service lists them in, and counts them underneath', async () => {
    await mount([connectionRow('c-2', 'Zeta'), connectionRow('c-1', 'Alpha')]);
    await screen.findByText('Zeta');

    expect(shownIds()).toEqual(['c-2', 'c-1']);
    expect(screen.getByText('2 connections')).toBeTruthy();
  });
});

describe('ConnectionsGrid search and empty states', () => {
  it('narrows by account, says when nothing matched, and Clear search brings the rows back', async () => {
    await mount([connectionRow('c-1', 'Platform GitHub'), connectionRow('c-2', 'Docs GitHub', 'docs-team')]);
    await screen.findByText('Docs GitHub');

    fireEvent.change(screen.getByPlaceholderText(en.search_placeholder), { target: { value: 'docs-team' } });
    await waitFor(() => expect(shownIds()).toEqual(['c-2']));
    expect(screen.getByText('1 connection')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(en.search_placeholder), { target: { value: 'gitlab' } });
    expect(await screen.findByText(en.empty_no_match)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en.clear_search }));
    await waitFor(() => expect(shownIds()).toHaveLength(2));
  });

  it('says the organization has no connections yet', async () => {
    await mount([]);

    expect(await screen.findByText(en.empty_title)).toBeTruthy();
    expect(screen.getByText(en.empty_hint)).toBeTruthy();
  });

  it('says no organization is in scope', async () => {
    await mount([], '');

    expect(await screen.findByText(en.empty_no_org)).toBeTruthy();
  });
});
