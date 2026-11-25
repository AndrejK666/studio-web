import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetBuiltPreviews } from '@constructor-studio/mfe-shared';

vi.mock('../../../i18n', () => ({
  useMapTranslations: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    loading: false,
  }),
}));

import type { ReactElement } from 'react';
import { api } from '../../../api/client';
import { ScopeContext, type Scope } from '../../common';
import { ScreenPreview } from './MapCanvas';

/** The card inside a Product screen of organization `orgId`. */
function inScope(card: ReactElement, orgId: string | null = 'o1'): ReactElement {
  const scope: Scope = {
    projectId: 'p1',
    workspaceId: null,
    orgId,
    language: 'en',
    bridge: {} as Scope['bridge'],
    container: { current: null },
  };
  return <ScopeContext.Provider value={scope}>{card}</ScopeContext.Provider>;
}

const INDEX = [
  {
    component: '@constructor-studio/built-mfe',
    version: '0.2.0',
    commit: '5bad52b50d33',
    route: '/connections',
    label: 'Connections',
    order: 0,
    width: 960,
    height: 600,
    file: 'built-mfe-connections.webp',
    captured_at: '2026-11-16T10:00:00Z',
  },
];

function serveIndex(body: unknown, type = 'application/json') {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': type } })))
  );
}

describe('the map screen card', () => {
  beforeEach(() => forgetBuiltPreviews());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the catalogue picture of the newest build, whatever version the catalogue lists', async () => {
    vi.spyOn(api, 'screenPreviews').mockResolvedValue({
      items: [
        {
          component: '@constructor-studio/kept-mfe',
          version: '0.1.0',
          commit: 'abcdef123456',
          route: '/people',
          label: 'People',
          order: 0,
          image: 'data:image/webp;base64,AAAA',
          width: 960,
          height: 600,
          captured_at: '2026-11-01T00:00:00Z',
        },
      ],
      total: 1,
    });
    serveIndex([]);
    const { container } = render(
      inScope(
        <ScreenPreview name="people-mfe" screens={['People']} pictured={{ component: '@constructor-studio/kept-mfe', version: '9.9.9' }} />
      )
    );
    await waitFor(() => expect(container.querySelector('[data-pmap-preview="built"]')).not.toBeNull());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,AAAA');
  });

  it('shows the picture the portal build took when the catalogue keeps none', async () => {
    vi.spyOn(api, 'screenPreviews').mockResolvedValue({ items: [], total: 0 });
    serveIndex(INDEX);
    const { container } = render(
      inScope(
        <ScreenPreview name="built-mfe" screens={['Connections']} pictured={{ component: '@constructor-studio/built-mfe', version: null }} />
      )
    );
    await waitFor(() => expect(container.querySelector('[data-pmap-preview="built"]')).not.toBeNull());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/screen-previews/built-mfe-connections.webp');
    expect(container.textContent).toContain('5bad52b');
  });

  it('draws the schematic and says no picture exists when neither has one', async () => {
    vi.spyOn(api, 'screenPreviews').mockResolvedValue({ items: [], total: 0 });
    // A portal without pictures answers the index with its page, not JSON.
    serveIndex('<!doctype html>', 'text/html');
    const { container } = render(
      inScope(
        <ScreenPreview name="bare-mfe" screens={['Bare']} pictured={{ component: '@constructor-studio/bare-mfe', version: null }} />
      )
    );
    await waitFor(() => expect(api.screenPreviews).toHaveBeenCalled());
    const card = container.querySelector('[data-pmap-preview="schematic"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('preview_schematic');
    expect(container.querySelector('img')).toBeNull();
  });

  it("asks each organization's catalogue for its own pictures", async () => {
    const read = vi.spyOn(api, 'screenPreviews').mockResolvedValue({ items: [], total: 0 });
    serveIndex([]);
    const card = <ScreenPreview name="org-mfe" screens={['Org']} pictured={{ component: '@constructor-studio/org-mfe', version: null }} />;
    const first = render(inScope(card, 'o1'));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    first.unmount();
    render(inScope(card, 'o2'));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls.map((c) => c[0])).toEqual(['o1', 'o2']);
  });
});
