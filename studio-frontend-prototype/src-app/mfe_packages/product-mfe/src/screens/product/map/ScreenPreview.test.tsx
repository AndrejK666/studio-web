import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetBuiltPreviews } from '@constructor-studio/mfe-shared';

vi.mock('../../../i18n', () => ({
  useMapTranslations: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    loading: false,
  }),
}));

import { api } from '../../../api/client';
import { ScreenPreview } from './MapCanvas';

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
      <ScreenPreview name="people-mfe" screens={['People']} pictured={{ component: '@constructor-studio/kept-mfe', version: '9.9.9' }} />
    );
    await waitFor(() => expect(container.querySelector('[data-pmap-preview="built"]')).not.toBeNull());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,AAAA');
  });

  it('shows the picture the portal build took when the catalogue keeps none', async () => {
    vi.spyOn(api, 'screenPreviews').mockResolvedValue({ items: [], total: 0 });
    serveIndex(INDEX);
    const { container } = render(
      <ScreenPreview name="built-mfe" screens={['Connections']} pictured={{ component: '@constructor-studio/built-mfe', version: null }} />
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
      <ScreenPreview name="bare-mfe" screens={['Bare']} pictured={{ component: '@constructor-studio/bare-mfe', version: null }} />
    );
    await waitFor(() => expect(api.screenPreviews).toHaveBeenCalled());
    const card = container.querySelector('[data-pmap-preview="schematic"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('preview_schematic');
    expect(container.querySelector('img')).toBeNull();
  });
});
