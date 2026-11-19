import { describe, expect, it } from 'vitest';
import { layoutOf } from './shellLayout';

describe('shell layout preference', () => {
  it('reads the sidebar only when it was chosen; anything else is the top bar', () => {
    expect(layoutOf('sidebar')).toBe('sidebar');
    expect(layoutOf('')).toBe('top');
    expect(layoutOf('top')).toBe('top');
    expect(layoutOf('rail')).toBe('top');
  });
});
