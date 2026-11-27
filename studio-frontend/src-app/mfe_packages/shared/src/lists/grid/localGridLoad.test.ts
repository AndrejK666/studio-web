import { describe, expect, it } from 'vitest';
import { listChoices, searchQuery, tagGroupChoice, TEXT_SEARCH_FILTER_KEY } from './dataGridFilters';
import { pageOfRows, shownRows } from './localGridLoad';

interface Row {
  id: string;
  name: string;
  size: number;
  tag: string;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Alpha', size: 3, tag: 'x' },
  { id: 'b', name: 'beta', size: 1, tag: 'y' },
  { id: 'c', name: 'Gamma', size: 2, tag: 'x' },
];

const OPTIONS = {
  search: (row: Row) => [row.name, row.tag],
  filter: (row: Row, filters: Record<string, unknown>) => {
    const tags = listChoices(filters.tag as { value?: unknown });
    return tags.length === 0 || tags.includes(row.tag);
  },
  compare: { size: (a: Row, b: Row) => a.size - b.size },
};

const ids = (rows: Row[]) => rows.map((row) => row.id);

describe('shownRows: a list in memory under the grid', () => {
  it('keeps every row in its own order with nothing asked', () => {
    expect(ids(shownRows(ROWS, {}, OPTIONS))).toEqual(['a', 'b', 'c']);
  });

  it('matches the search in any of the texts, ignoring case', () => {
    const search = (value: string) => ({ filters: { [TEXT_SEARCH_FILTER_KEY]: { value } } });
    expect(ids(shownRows(ROWS, search('ALP'), OPTIONS))).toEqual(['a']);
    expect(ids(shownRows(ROWS, search(' x '), OPTIONS))).toEqual(['a', 'c']);
  });

  it("applies the list's filters and sorts by the column's comparer, both ways", () => {
    const context = { filters: { tag: { value: ['x'] } }, order: [{ column: 'size', direction: 'asc' as const }] };
    expect(ids(shownRows(ROWS, context, OPTIONS))).toEqual(['c', 'a']);
    expect(ids(shownRows(ROWS, { ...context, order: [{ column: 'size', direction: 'desc' as const }] }, OPTIONS))).toEqual([
      'a',
      'c',
    ]);
  });

  it('leaves the order alone for a column it cannot sort', () => {
    expect(ids(shownRows(ROWS, { order: [{ column: 'name', direction: 'asc' }] }, OPTIONS))).toEqual(['a', 'b', 'c']);
  });
});

describe('pageOfRows', () => {
  it('cuts the page and counts every row shown', () => {
    const page = pageOfRows(ROWS, { pagination: { page: 2, limit: 2 } });
    expect(ids(page.results)).toEqual(['c']);
    expect(page.total).toBe(3);
    expect(pageOfRows(ROWS, {}).results).toHaveLength(3);
  });
});

describe('the filter helpers read what a stored value may hold', () => {
  it('takes strings only', () => {
    expect(tagGroupChoice({ value: ['one'] })).toBe('one');
    expect(tagGroupChoice({ value: 'one' })).toBeNull();
    expect(listChoices({ value: ['a', 2, 'b'] })).toEqual(['a', 'b']);
    expect(listChoices(undefined)).toEqual([]);
    expect(searchQuery({ [TEXT_SEARCH_FILTER_KEY]: { value: '  q ' } })).toBe('q');
    expect(searchQuery({ [TEXT_SEARCH_FILTER_KEY]: { value: 3 } })).toBe('');
  });
});
