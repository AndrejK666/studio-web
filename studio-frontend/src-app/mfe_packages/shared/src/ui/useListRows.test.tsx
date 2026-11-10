import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import {
  DataGridPaginationPlugin,
  DataGridTextSearchPlugin,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import { LIST_PAGE_LIMITS, ListGrid } from './ListGrid';
import { useListRows } from './useListRows';

type Row = { id: string; name: string };

const rows = (count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `r${index + 1}`, name: `Row ${index + 1}` }));

const byName = (all: readonly Row[], text: string) =>
  all.filter((row) => row.name.toLowerCase().includes(text.trim().toLowerCase()));

const columns: DataGridTableColumn<Row>[] = [
  { id: 'name', label: 'Name', render: (row) => <span>{row.name}</span> },
];

const List = ({ items }: { items: Row[] }) => {
  const { load, found, rowsBridge } = useListRows(items, byName);
  return (
    <ListGrid<Row> name="rows" persistent="memory" load={load} columns={columns} footer={found}>
      <DataGridTextSearchPlugin placeholder="Search" />
      <DataGridPaginationPlugin defaultLimit={LIST_PAGE_LIMITS[0]} limits={LIST_PAGE_LIMITS} autoHide />
      {rowsBridge}
    </ListGrid>
  );
};

const shown = () => screen.queryAllByText(/^Row \d+$/).map((cell) => cell.textContent);

describe('useListRows', () => {
  beforeEach(() => {
    stubResizeObserver();
  });

  afterEach(() => {
    cleanup();
  });

  it('searches and pages the rows in memory, and counts what the search found', async () => {
    const { result } = renderHook(() => useListRows(rows(30), byName));
    expect(result.current.found).toBeNull();

    const searched = await act(() => result.current.load({ filters: { textSearch: { value: ' row 1' } } }));
    expect(searched.total).toBe(11);
    expect(result.current.found).toBe(11);

    const second = await act(() => result.current.load({ pagination: { page: 2, limit: 25 } }));
    expect(second.results.map((row) => row.id)).toEqual(['r26', 'r27', 'r28', 'r29', 'r30']);
    expect(second.total).toBe(30);
    expect(result.current.found).toBe(30);
  });

  it('shows the rows again when they change', async () => {
    const { rerender } = render(<List items={rows(3)} />);
    await waitFor(() => expect(shown()).toHaveLength(3));

    rerender(<List items={rows(4)} />);

    await waitFor(() => expect(shown()).toHaveLength(4));
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('goes back to the last page when the rows shrink under the one shown', async () => {
    const { rerender } = render(<List items={rows(30)} />);
    await waitFor(() => expect(shown()).toHaveLength(25));

    fireEvent.click(screen.getByRole('button', { name: 'Go to page 2' }));
    await waitFor(() => expect(shown()).toEqual(['Row 26', 'Row 27', 'Row 28', 'Row 29', 'Row 30']));

    rerender(<List items={rows(20)} />);

    await waitFor(() => expect(shown()).toHaveLength(20));
    expect(shown()[0]).toBe('Row 1');
  });
});
