import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DataGridTableColumn } from '@gears-frontx/ui-kit';
import { GridEmpty, GridFailed, GridFooter, NoData } from './GridStates';
import { ListGrid } from './ListGrid';
import { useLocalGridLoad } from './localGridLoad';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';

// The kit's DataGrid measures its table.
stubResizeObserver();

interface Row {
  id: string;
  name: string;
}

const COLUMNS: DataGridTableColumn<Row>[] = [{ id: 'name', label: 'Name' }];

const Empty: React.FC = () => <GridEmpty title="Nothing yet" noMatches="Nothing matched" />;

const List: React.FC<{ rows: Row[] }> = ({ rows }) => {
  const { load, reloadBridge } = useLocalGridLoad(rows, { search: (row) => row.name });
  return (
    <div data-theme="dark">
      <ListGrid<Row> name="test_list" columns={COLUMNS} load={load} search="Search" empty={Empty}>
        {reloadBridge}
      </ListGrid>
    </div>
  );
};

afterEach(cleanup);

describe('ListGrid', () => {
  it('lists the rows, searches them and says when nothing matched', async () => {
    render(<List rows={[{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }]} />);
    expect(await screen.findByText('Alpha')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'zzz' } });
    expect(await screen.findByText('Nothing matched')).toBeTruthy();
  });

  it('says the list is empty, without filters, in its own words', async () => {
    render(<List rows={[]} />);
    expect(await screen.findByText('Nothing yet')).toBeTruthy();
  });

  it('reloads when its rows change', async () => {
    const { rerender } = render(<List rows={[{ id: '1', name: 'Alpha' }]} />);
    expect(await screen.findByText('Alpha')).toBeTruthy();
    rerender(<List rows={[{ id: '1', name: 'Alpha' }, { id: '2', name: 'Gamma' }]} />);
    await waitFor(() => expect(screen.getByText('Gamma')).toBeTruthy());
  });

  it("sits inside the screen's themed root", async () => {
    render(<List rows={[{ id: '1', name: 'Alpha' }]} />);
    await screen.findByText('Alpha');
    expect(document.querySelector('[data-list-grid="test_list"]')?.closest('[data-theme]')?.getAttribute('data-theme')).toBe(
      'dark'
    );
  });
});

describe('the states around a list', () => {
  it('fails with a retry, joins the footer, and dashes a cell', () => {
    let retried = 0;
    render(
      <>
        <GridFailed message="Could not read" retry="Retry" onRetry={() => (retried += 1)} />
        <GridFooter parts={['3 of 5', false, null, 'Project']} />
        <GridFooter parts={[false, '']} />
        <NoData label="Not known" />
      </>
    );
    expect(screen.getByRole('alert').textContent).toBe('Could not read');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retried).toBe(1);
    expect(document.querySelectorAll('[data-grid-footer]')).toHaveLength(1);
    expect(screen.getByText('3 of 5 · Project')).toBeTruthy();
    expect(screen.getByTitle('Not known').textContent).toBe('—');
  });
});
