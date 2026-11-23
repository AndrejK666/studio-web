import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { researchProgressOf } from '../../model/research-progress';
import { ReleasesProvider, type ReleasesContextValue, type Text } from './parts';
import { ResearchProgress } from './ResearchProgress';

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${Object.values(params).join(' / ')}` : key) as unknown as Text;

function shown(result: unknown) {
  const progress = researchProgressOf(result);
  if (!progress) throw new Error('no progress');
  const value = { t, language: 'en', projectId: 'p1', organizationId: 'o1', container: { current: null }, bridge: null } as ReleasesContextValue;
  const { container } = render(
    <ReleasesProvider value={value}>
      <ResearchProgress progress={progress} />
    </ReleasesProvider>
  );
  return container;
}

describe('the Research progress bar', () => {
  it('fills by step and shows the upload by files and bytes', () => {
    const c = shown({
      progress: {
        step: 'upload',
        files: { done: 1240, total: 3812 },
        bytes: { done: 46_000_000, total: 120_000_000 },
      },
    });
    const bars = [...c.querySelectorAll('[role=progressbar]')];
    expect(bars.map((b) => b.getAttribute('aria-valuenow'))).toEqual(['40', '38']);
    expect(c.querySelector('[data-progress-step="desk"]')?.getAttribute('data-progress-state')).toBe('done');
    expect(c.querySelector('[data-progress-step="upload"]')?.getAttribute('data-progress-state')).toBe('now');
    expect(c.querySelector('[data-progress-counts]')?.textContent).toBe('progress_files 1,240 / 3,812 · 46 MB / 120 MB');
  });

  it('moves without a share while the desk starts', () => {
    const c = shown({ progress: { step: 'desk' } });
    const step = c.querySelector('[data-progress-current] [role=progressbar]');
    expect(step?.hasAttribute('aria-valuenow')).toBe(false);
    expect(step?.getAttribute('data-progress-indeterminate')).toBe('true');
    expect(c.querySelector('[data-progress-counts]')?.textContent).toBe('progress_waiting');
  });

  it('counts the images, and is full when the application is ready', () => {
    expect(shown({ progress: { step: 'images', images: { done: 1, total: 3 } } }).querySelector('[data-progress-counts]')?.textContent).toBe(
      'progress_images 1 / 3'
    );
    const ready = shown({ progress: { step: 'ready' } });
    expect(ready.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('100');
    expect(ready.querySelector('[data-progress-current]')).toBeNull();
  });
});
