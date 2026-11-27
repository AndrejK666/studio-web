import { afterEach, describe, expect, it, vi } from 'vitest';

const { emit, fetchKits } = vi.hoisted(() => ({
  emit: vi.fn(),
  fetchKits: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: { emit },
  apiRegistry: {
    has: () => true,
    getService: () => ({ installed: (scope: unknown) => ({ fetch: () => fetchKits(scope) }) }),
  },
}));

import { openPlace } from './chainChildren';

const PROJECT = { organizationId: 'o2', workspaceId: 'w9', projectId: 'p7' };

describe('openPlace (a place picked in the path)', () => {
  afterEach(() => vi.clearAllMocks());

  it('keeps the tab on screen where the place has its kit', async () => {
    fetchKits.mockResolvedValue({ effective: [{ kit_slug: 'tests' }] });
    await openPlace(PROJECT, true, { kit: 'tests' });
    expect(fetchKits).toHaveBeenCalledWith({ projectId: 'p7' });
    expect(emit).toHaveBeenCalledWith('app/context/place/requested', { ...PROJECT, keep: true });
  });

  it("opens the place's own first tab where it lacks the kit", async () => {
    fetchKits.mockResolvedValue({ effective: [{ kit_slug: 'other' }] });
    await openPlace(PROJECT, true, { kit: 'tests' });
    expect(emit).toHaveBeenCalledWith('app/context/place/requested', PROJECT);
  });

  it('asks the organization about a workspace tab', async () => {
    fetchKits.mockResolvedValue({ effective: [{ kit_slug: 'tests' }] });
    await openPlace({ organizationId: 'o2', workspaceId: 'w9' }, true, { kit: 'tests' });
    expect(fetchKits).toHaveBeenCalledWith({ organizationId: 'o2' });
  });

  it('keeps the tab when the kits cannot be read: unknown hides nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchKits.mockRejectedValue(new Error('503'));
    await openPlace(PROJECT, true, { kit: 'tests' });
    expect(emit).toHaveBeenCalledWith('app/context/place/requested', { ...PROJECT, keep: true });
  });

  it('asks nothing for a tab no kit brings, or when the level changes', async () => {
    await openPlace(PROJECT, true, {});
    expect(emit).toHaveBeenLastCalledWith('app/context/place/requested', { ...PROJECT, keep: true });
    await openPlace(PROJECT, false, { kit: 'tests' });
    expect(emit).toHaveBeenLastCalledWith('app/context/place/requested', PROJECT);
    expect(fetchKits).not.toHaveBeenCalled();
  });
});
