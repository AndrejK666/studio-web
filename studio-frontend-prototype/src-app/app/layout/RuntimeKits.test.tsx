import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RuntimeKitFailure } from '@/app/mfe/runtimeKits';

const { state, dispatch, kits, fetchManifests } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let failures: RuntimeKitFailure[] = [];
  return {
    state: {
      bootstrap: 'ready' as 'pending' | 'ready',
      installed: null as null | { organization_id: string; project_id: string | null; effective: { kit_slug: string; version: string }[] },
      project: 'p-1' as string | null,
    },
    dispatch: vi.fn(),
    fetchManifests: vi.fn(),
    kits: {
      sync: vi.fn(async () => undefined),
      dismiss: vi.fn((key: string) => {
        failures = failures.filter((f) => f.key !== key);
        for (const l of listeners) l();
      }),
      failures: () => failures,
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      setFailures(next: RuntimeKitFailure[]) {
        failures = next;
        for (const l of listeners) l();
      },
    },
  };
});

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFrontX: () => ({ mfeRegistry: {}, store: { dispatch } }),
  useAppSelector: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      'app/mfe-bootstrap': { status: state.bootstrap },
      'app/context': { org: { id: 'o-1' }, project: state.project ? { id: state.project } : null },
    }),
  useApiQuery: () => ({ data: state.installed }),
  apiRegistry: {
    getService: () => ({
      installed: () => ({}),
      mfeManifests: (scope: unknown) => ({ fetch: () => fetchManifests(scope) }),
    }),
  },
}));
vi.mock('@/app/mfe/runtimeKits', () => ({ runtimeKitsOf: () => kits }));
vi.mock('@/app/i18n/shellTranslations', () => ({
  useShellText: () => (key: string, params?: Record<string, string>) =>
    params ? `${key}:${Object.values(params).join(',')}` : key,
}));

import { RuntimeKits } from './RuntimeKits';

const item = { kit_slug: 'hello-kit', version: '0.1.0', package: 'hello', base_path: '/cf/x/', config: {} };

describe('RuntimeKits', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    kits.setFailures([]);
    state.installed = null;
    state.bootstrap = 'ready';
  });

  it('loads the micro-frontends of the kits installed where the person is, then wakes the tabs', async () => {
    state.installed = { organization_id: 'o-1', project_id: 'p-1', effective: [{ kit_slug: 'hello-kit', version: '0.1.0' }] };
    fetchManifests.mockResolvedValue({ items: [item] });
    render(<RuntimeKits />);
    await waitFor(() => expect(kits.sync).toHaveBeenCalledWith([item], window.location.origin));
    expect(fetchManifests).toHaveBeenCalledWith({ projectId: 'p-1' });
    await waitFor(() => expect(dispatch).toHaveBeenCalled());
  });

  it('waits for the shell’s own screens, and for an answer about this scope', async () => {
    state.bootstrap = 'pending';
    state.installed = { organization_id: 'o-1', project_id: 'p-1', effective: [] };
    const { rerender } = render(<RuntimeKits />);
    // An answer for another project is not this one's.
    state.bootstrap = 'ready';
    state.installed = { organization_id: 'o-1', project_id: 'p-2', effective: [] };
    rerender(<RuntimeKits />);
    await act(async () => undefined);
    expect(fetchManifests).not.toHaveBeenCalled();
  });

  it('keeps the shell going when the list cannot be read', async () => {
    state.installed = { organization_id: 'o-1', project_id: 'p-1', effective: [{ kit_slug: 'hello-kit', version: '0.1.0' }] };
    fetchManifests.mockRejectedValue(new Error('404'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<RuntimeKits />);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(kits.sync).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('draws a tile per package that did not come up, which the person can dismiss', () => {
    kits.setFailures([
      { key: 'hello-kit/hello', kit: 'hello-kit', version: '0.1.0', package: 'hello', reason: 'not built' },
      { key: 'other/x', kit: 'other', version: '1', package: 'x', label: 'Other', reason: 'HTTP 404' },
    ]);
    render(<RuntimeKits />);
    const tiles = screen.getAllByRole('alert');
    expect(tiles.map((t) => t.textContent)).toEqual([
      'runtime_kit_failed:hello-kit,0.1.0not built',
      'runtime_kit_screen_failed:Other,otherHTTP 404',
    ]);
    fireEvent.click(screen.getAllByLabelText('runtime_kit_dismiss')[0]);
    expect(kits.dismiss).toHaveBeenCalledWith('hello-kit/hello');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
