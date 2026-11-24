import { createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildMfeBridge } from '@gears-frontx/react';

vi.mock('../../../i18n', () => {
  const t = Object.assign(
    (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    {
      count: (key: string, count: number, params?: Record<string, string>) =>
        `${key} ${JSON.stringify({ ...params, count: String(count) })}`,
    }
  );
  return { useMapTranslations: () => ({ t, loading: false }) };
});

import { api } from '../../../api/client';
import { forgetQueuedChecks } from '../keptCheck';
import type { ProjectProduct } from '../../../api/types';
import { ScopeContext, type Scope } from '../../common';
import { ProductMap } from './ProductMap';

const PRODUCT: ProjectProduct = { product_id: 'shop', name: 'shop', gears: ['cf-gears-orders'] };

function scope(): Scope {
  return {
    projectId: 'p1',
    workspaceId: 'w1',
    orgId: 'o1',
    language: 'en',
    bridge: {} as ChildMfeBridge,
    container: createRef<HTMLDivElement>(),
  };
}

function mount(onSection = vi.fn()) {
  return render(
    <ScopeContext.Provider value={scope()}>
      <ProductMap onSection={onSection} />
    </ScopeContext.Provider>
  );
}

/** Generous under a loaded machine: the map reads seven things before it draws. */
const WAIT = { timeout: 10000 };

describe('ProductMap', () => {
  beforeEach(() => {
    vi.spyOn(api, 'projectProduct').mockResolvedValue(PRODUCT);
    vi.spyOn(api, 'projectTargets').mockRejectedValue(new Error('no targets'));
    vi.spyOn(api, 'listComponents').mockResolvedValue({ nodes: [] });
    vi.spyOn(api, 'listComponentProfiles').mockResolvedValue({ nodes: [] });
    vi.spyOn(api, 'projectConfig').mockResolvedValue(null);
    vi.spyOn(api, 'productDescription').mockResolvedValue({ latest: null });
    vi.spyOn(api, 'productInfra').mockResolvedValue({ items: [], source: 'project-list', revision: null, services: [] });
    vi.spyOn(api, 'outlineProductDescription').mockResolvedValue({ nodes: [{ id: 'gear:orders', lines: [2] }], lines: [{ line: 2, nodes: ['gear:orders'] }] });
    vi.spyOn(api, 'gearboxCatalogue').mockRejectedValue(new Error('no engine'));
    vi.spyOn(api, 'gearConfigSchemas').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, 'infraPlans').mockResolvedValue([]);
    vi.spyOn(api, 'startProductCheck').mockResolvedValue({ run_id: 'r1', profile: 'deploy', state: 'queued' });
    forgetQueuedChecks();
    vi.spyOn(api, 'previewProduct').mockResolvedValue({
      product_gdl: 'product(\n  use_gear("cf-gears-orders"),\n)\n',
      ok: true,
      gears: ['cf-gears-orders'],
      diagnostics: [],
      applications: [],
      profile: 'deploy',
    } as unknown as Awaited<ReturnType<typeof api.previewProduct>>);
  });
  afterEach(() => vi.restoreAllMocks());

  it('draws the lanes and the picked gear, and says nothing is wrong between them', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-product-map]')).not.toBeNull(), WAIT);
    expect(container.querySelector('[data-pmap-lane="frontend"]')).not.toBeNull();
    expect(container.querySelector('[data-pmap-lane="backend"]')).not.toBeNull();
    expect(container.querySelector('[data-pmap-lane="infrastructure"]')).not.toBeNull();
    expect(container.querySelector('[data-pmap-node="gear:orders"]')).not.toBeNull();
    expect(screen.getByText('detail_title')).toBeTruthy();
  });

  it('opens a gear in the detail and takes it out of the product', async () => {
    const save = vi.spyOn(api, 'saveProjectProduct').mockResolvedValue({ value: { ...PRODUCT, gears: [] } });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-pmap-node="gear:orders"]')).not.toBeNull(), WAIT);
    fireEvent.click(container.querySelector('[data-pmap-node="gear:orders"]')!);
    expect(container.querySelector('[data-pmap-detail="gear:orders"]')).not.toBeNull();
    fireEvent.click(container.querySelector('[data-pmap-remove-gear="cf-gears-orders"]')!);
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][2]).toMatchObject({ product_id: 'shop', gears: [] });
  });

  it('shows the saved product.gdl and its kept verdict without running the engine, its gear line tied to the node', async () => {
    const text = 'product(\n  use_gear("cf-gears-orders"),\n)\n';
    vi.spyOn(api, 'productDescription').mockResolvedValue({
      latest: { revision: 7, text, sha256: 'abc', author: 'a', created_at: '', source: 'studio' },
    });
    vi.spyOn(api, 'projectProduct').mockResolvedValue({
      ...PRODUCT,
      checks: {
        prod: { ok: false, errors: 2, warnings: 0, applications: [], gears: [], gdl_sha256: 'abc', checked_at: '2026-11-24T10:00:00Z' },
      },
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-pmap-view="gdl"]')).not.toBeNull(), WAIT);
    fireEvent.click(container.querySelector('[data-pmap-view="gdl"]')!);
    await waitFor(() => expect(container.querySelector('[data-pmap-gdl="kept"]')).not.toBeNull(), WAIT);
    expect(screen.getByText('use_gear("cf-gears-orders"),', { exact: false })).toBeTruthy();
    // Opening it runs nothing: the verdict is the one kept, about this very text.
    expect(api.previewProduct).not.toHaveBeenCalled();
    expect(api.startProductCheck).not.toHaveBeenCalled();
    expect(container.querySelector('[data-pmap-gdl-check="failed"]')).not.toBeNull();
    expect(container.querySelector('[data-pmap-gdl-verdict="current"]')).not.toBeNull();
    // The server reads which line is which node: the gear's line is tied to it.
    expect(api.outlineProductDescription).toHaveBeenCalledWith('', 'p1', { text });
    await waitFor(() => expect(container.querySelector('[data-gdl-line="2"]')?.className).toMatch(/owned/), WAIT);
    // Check now queues a check on the server.
    fireEvent.click(container.querySelector('[data-pmap-gdl-check-now]')!);
    await waitFor(() => expect(api.startProductCheck).toHaveBeenCalledWith('', 'p1', 'prod'), WAIT);
  });

  it('queues one check on the server when the kept verdict is about another text', async () => {
    vi.spyOn(api, 'productDescription').mockResolvedValue({
      latest: { revision: 8, text: 'product()\n', sha256: 'new', author: 'a', created_at: '', source: 'studio' },
    });
    vi.spyOn(api, 'projectProduct').mockResolvedValue({
      ...PRODUCT,
      checks: { prod: { ok: true, errors: 0, warnings: 0, applications: [], gears: [], gdl_sha256: 'old' } },
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-pmap-view="gdl"]')).not.toBeNull(), WAIT);
    fireEvent.click(container.querySelector('[data-pmap-view="gdl"]')!);
    await waitFor(() => expect(api.startProductCheck).toHaveBeenCalledTimes(1), WAIT);
    expect(api.previewProduct).not.toHaveBeenCalled();
    expect(container.querySelector('[data-pmap-gdl-verdict="other"]')).not.toBeNull();
  });
});
