import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DerivedViewStrip, agoText, isComputing, viewCommits, type DerivedViewLabels } from './derivedView';

const labels: DerivedViewLabels = {
  byCommit: (c) => `by commit ${c}`,
  computed: (ago) => `computed ${ago} ago`,
  computing: 'computing…',
  failed: (e) => `failed: ${e}`,
  never: 'not computed yet',
  refresh: 'Compute again',
};

describe('derived view', () => {
  afterEach(cleanup);

  it('names the commits once each, short', () => {
    expect(
      viewCommits({
        status: 'ready',
        inputs: [
          { source: 'a/b', commit: 'a68726c6ae5dddccd8777dd1fa482d2ab3e857e3' },
          { source: 'a/c', commit: null },
          { source: 'a/d', commit: 'a68726c6ae5dddccd8777dd1fa482d2ab3e857e3' },
        ],
      })
    ).toEqual(['a68726c']);
    expect(isComputing({ status: 'computing', inputs: [] })).toBe(true);
  });

  it('says how long ago in the largest whole unit', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    expect(agoText('2026-11-24T11:55:00Z', now)).toBe('5 min');
    expect(agoText('2026-11-24T09:00:00Z', now)).toBe('3 h');
    expect(agoText(null, now)).toBeNull();
  });

  it('shows what it was computed from and asks for another computation', () => {
    const onRefresh = vi.fn();
    const { container, getByLabelText } = render(
      <DerivedViewStrip
        view={{
          status: 'ready',
          computed_at: new Date().toISOString(),
          inputs: [
            {
              source: 'a/b',
              commit: 'abcdef0123',
              note: 'no clone on the server',
            },
          ],
        }}
        labels={labels}
        onRefresh={onRefresh}
      />
    );
    expect(container.textContent).toContain('by commit abcdef0');
    expect(container.querySelector('[data-derived-view]')?.getAttribute('title')).toContain('no clone');
    fireEvent.click(getByLabelText('Compute again'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('cannot be asked again while it computes, and says a failure', () => {
    const { container, rerender } = render(
      <DerivedViewStrip view={{ status: 'computing', inputs: [] }} labels={labels} onRefresh={() => undefined} />
    );
    expect(container.textContent).toContain('not computed yet');
    expect(container.textContent).toContain('computing…');
    expect((container.querySelector('[data-derived-view-refresh]') as HTMLButtonElement).disabled).toBe(true);
    rerender(<DerivedViewStrip view={{ status: 'failed', error: 'boom', inputs: [] }} labels={labels} />);
    expect(container.textContent).toContain('failed: boom');
  });
});
