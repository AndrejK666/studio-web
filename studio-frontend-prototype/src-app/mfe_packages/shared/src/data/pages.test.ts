import { describe, expect, it } from 'vitest';
import { fetchAllCursorPages, fetchAllPages } from './pages';

describe('fetchAllPages', () => {
  it('reads page after page until the gear’s total', async () => {
    const asked: number[] = [];
    const read = await fetchAllPages(
      async (offset, limit) => {
        asked.push(offset);
        const all = [1, 2, 3, 4, 5];
        return { items: all.slice(offset, offset + limit), total: all.length };
      },
      { pageSize: 2 }
    );
    expect(read).toEqual({ items: [1, 2, 3, 4, 5], total: 5, complete: true });
    expect(asked).toEqual([0, 2, 4]);
  });

  it('stops at an empty page, so a server that ignores the offset cannot spin', async () => {
    const pages = [{ items: [1, 2], total: 10 }, { items: [] as number[], total: 10 }];
    let n = 0;
    const read = await fetchAllPages(async () => pages[n++], { pageSize: 2 });
    expect(read.items).toEqual([1, 2]);
    expect(n).toBe(2);
  });

  it('without a total, stops at a short page', async () => {
    let n = 0;
    const read = await fetchAllPages(async () => (n++ === 0 ? { items: [1, 2] } : { items: [3] }), { pageSize: 2 });
    expect(read).toEqual({ items: [1, 2, 3], total: 3, complete: true });
  });

  it('steps by the rows read when asked to, for a gear whose pages come short', async () => {
    const asked: number[] = [];
    await fetchAllPages(
      async (offset) => {
        asked.push(offset);
        return offset === 0 ? { items: [1], total: 2 } : { items: [2], total: 2 };
      },
      { pageSize: 200, advance: 'rows' }
    );
    expect(asked).toEqual([0, 1]);
  });

  it('never reads past `max`, and says the list is cut', async () => {
    const read = await fetchAllPages(async (offset, limit) => ({ items: Array.from({ length: limit }, (_, i) => offset + i), total: 1000 }), {
      pageSize: 10,
      max: 25,
    });
    expect(read.items).toHaveLength(25);
    expect(read.complete).toBe(false);
  });
});

describe('fetchAllCursorPages', () => {
  it('follows next_cursor until there is none', async () => {
    const asked: (string | undefined)[] = [];
    const read = await fetchAllCursorPages(async (cursor) => {
      asked.push(cursor);
      if (!cursor) return { items: ['a', 'b'], total: 3, next_cursor: 'c1' };
      return { items: ['c'], total: 3, next_cursor: null };
    });
    expect(read).toEqual({ items: ['a', 'b', 'c'], total: 3, complete: true });
    expect(asked).toEqual([undefined, 'c1']);
  });
});
