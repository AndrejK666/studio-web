import { describe, expect, it, vi } from 'vitest';
import { builtPreviewsOf, isPicture, loadScreenPreviews, newestBuild, pictureFor, type ScreenPreview } from './screenPreviews';

const shot = (route: string, commit: string, order = 0, image = 'data:image/webp;base64,AAAA'): ScreenPreview => ({
  component: '@constructor-studio/tests-mfe',
  version: '1.0.0',
  commit,
  route,
  label: route.slice(1),
  order,
  image,
  width: 960,
  height: 600,
  captured_at: '2026-11-01T00:00:00Z',
});

const index = [
  { component: '@constructor-studio/tests-mfe', version: '0.2.0', commit: 'abc', route: '/tests', label: 'Tests', order: 0, width: 960, height: 600, file: 'tests-mfe-tests.webp', captured_at: '2026-11-16T00:00:00Z' },
  { component: '@constructor-studio/kits-mfe', commit: 'abc', route: '/kits', label: 'Kits', order: 0, file: 'kits-mfe-kits.webp' },
  { component: '@constructor-studio/tests-mfe', commit: 'abc', route: '/evil', file: '../../etc/passwd' },
  'junk',
];

describe('screen previews', () => {
  it('shows a catalogue picture or a file the portal serves, nothing else', () => {
    expect(isPicture({ image: 'data:image/webp;base64,AA' })).toBe(true);
    expect(isPicture({ image: '/screen-previews/a.webp' })).toBe(true);
    expect(isPicture({ image: 'https://elsewhere/a.webp' })).toBe(false);
    expect(isPicture({ image: 'data:text/html,<b>' })).toBe(false);
  });

  it('takes the newest build only, in its order', () => {
    const items = [shot('/b', 'new', 1), shot('/a', 'new', 0), shot('/c', 'old')];
    expect(newestBuild(items).map((p) => p.route)).toEqual(['/a', '/b']);
    expect(pictureFor(items, { route: '/c', label: 'c' })).toBeNull();
    expect(pictureFor(items, { route: null, label: 'B' })?.route).toBe('/b');
  });

  it('reads the portal build index for one component, files under the served folder only', () => {
    const got = builtPreviewsOf(index, '@constructor-studio/tests-mfe');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ route: '/tests', image: '/screen-previews/tests-mfe-tests.webp', version: '0.2.0', captured_at: '2026-11-16T00:00:00Z' });
    expect(builtPreviewsOf({ not: 'an index' }, 'x')).toEqual([]);
  });

  it('prefers the catalogue, and falls back to the portal build when it keeps none', async () => {
    const readIndex = vi.fn(() => Promise.resolve(index));
    const kept = [shot('/tests', 'cat')];
    expect(await loadScreenPreviews('@constructor-studio/tests-mfe', () => Promise.resolve(kept), readIndex)).toEqual(kept);
    expect(readIndex).not.toHaveBeenCalled();
    const built = await loadScreenPreviews('@constructor-studio/tests-mfe', () => Promise.resolve([]), readIndex);
    expect(built.map((p) => p.image)).toEqual(['/screen-previews/tests-mfe-tests.webp']);
    // A failed catalogue read is none; a failed index read too.
    const failed = await loadScreenPreviews('@constructor-studio/kits-mfe', () => Promise.reject(new Error('503')), readIndex);
    expect(failed.map((p) => p.route)).toEqual(['/kits']);
    expect(await loadScreenPreviews('x', () => Promise.resolve([]), () => Promise.reject(new Error('404')))).toEqual([]);
  });
});
