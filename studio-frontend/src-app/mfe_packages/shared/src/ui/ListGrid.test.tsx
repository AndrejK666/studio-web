import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import type { DataGridTableColumn } from '@gears-frontx/ui-kit';
import { ListGrid } from './ListGrid';

type Row = { id: string; name: string };

const columns: DataGridTableColumn<Row>[] = [
  { id: 'name', label: 'Name', render: (row) => <span>{row.name}</span> },
];
const load = async () => ({ results: [{ id: 'r-1', name: 'Platform' }], total: 1 });

describe('ListGrid', () => {
  beforeEach(() => {
    stubResizeObserver();
  });

  afterEach(() => {
    cleanup();
  });

  it("draws the grid from the load and columns it is given, and the footer under it", async () => {
    render(<ListGrid<Row> name="rows" load={load} columns={columns} footer="1 row" />);

    await waitFor(() => expect(screen.getByText('Platform')).toBeTruthy());
    expect(screen.getByText('1 row').tagName).toBe('P');
  });

  it('draws no footer when it is given none', async () => {
    const { container } = render(
      <ListGrid<Row> name="rows" load={load} columns={columns} footer={null} />
    );

    await waitFor(() => expect(screen.getByText('Platform')).toBeTruthy());
    expect(container.firstElementChild?.querySelector(':scope > p')).toBeNull();
  });
});
