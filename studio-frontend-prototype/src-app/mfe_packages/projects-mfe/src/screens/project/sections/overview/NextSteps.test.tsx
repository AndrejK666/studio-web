import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectPathStep } from '../../../../model/projectStatus';

const { types, config, put, invalidate } = vi.hoisted(() => ({
  types: { value: null as unknown },
  config: { value: null as unknown },
  put: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: {
    getService: () => ({
      projectTypeKits: 'types',
      getTenantMetadata: () => ({ fetch: async () => ({ value: config.value }) }),
      putTenantMetadata: () => ({ fetch: put }),
    }),
  },
  useApiQuery: (query: unknown) => ({ data: query === 'types' ? types.value : null }),
  useQueryCache: () => ({ invalidate }),
}));
vi.mock('../../../../shared/useProjectConfig', () => ({
  useProjectConfig: () => ({ config: config.value }),
  projectConfigQuery: () => ({ fetch: async () => ({ value: config.value }) }),
}));

import { NextSteps } from './NextSteps';

const t = (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key);
const path: ProjectPathStep[] = [
  { step: 'repos', title: '', state: 'done', flow: 'done', status: '', tab: 'sources', action: '' },
];

const mount = (reach: (route: string) => string | null = (r) => r, open = vi.fn()) => {
  render(<NextSteps projectId="p1" path={path} t={t as never} reachRoute={reach} open={open} />);
  return open;
};

describe("NextSteps: what the project's type says to do next", () => {
  beforeEach(() => {
    put.mockReset();
    invalidate.mockReset();
    types.value = {
      items: [
        {
          slug: 'gears-project',
          name: 'Gears project',
          description: '',
          next_steps: [
            { id: 'connect-repositories', label: 'Connect your repositories', description: 'Attach them.', route: '/projects/sources', done_when: 'repos' },
            { id: 'compose-product', label: 'Compose the product', description: '', route: '/product', done_when: 'product' },
          ],
        },
        {
          slug: 'constructor-research',
          name: 'Constructor Research project',
          description: '',
          next_steps: [{ id: 'connect-research-project', label: 'Connect a Research project', description: '', route: '/constructor-research' }],
        },
      ],
    };
    config.value = { project_type_kit: 'gears-project' };
  });

  it('lists what is not done yet, and opens its screen', () => {
    const open = mount();
    expect(screen.queryByText('Connect your repositories')).toBeNull();
    expect(screen.getByText('Compose the product')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'next_open' }));
    expect(open).toHaveBeenCalledWith('/product');
  });

  it('offers no Open where this portal has no such screen', () => {
    mount(() => null);
    expect(screen.queryByRole('button', { name: 'next_open' })).toBeNull();
    expect(screen.getByRole('button', { name: 'next_dismiss' })).toBeTruthy();
  });

  it("shows the Research type's steps for a Research project", () => {
    config.value = { project_type_kit: 'constructor-research' };
    mount();
    expect(screen.getByText('Connect a Research project')).toBeTruthy();
  });

  it('shows nothing for a project without a type, or with every step dismissed', () => {
    config.value = { mode: 'modernize' };
    const { container } = render(<NextSteps projectId="p1" path={path} t={t as never} reachRoute={(r) => r} open={vi.fn()} />);
    expect(container.innerHTML).toBe('');
    config.value = { project_type_kit: 'gears-project', next_steps_dismissed: ['compose-product'] };
    const second = render(<NextSteps projectId="p1" path={path} t={t as never} reachRoute={(r) => r} open={vi.fn()} />);
    expect(second.container.innerHTML).toBe('');
  });

  it('dismisses into the configuration, keeping what else it says', async () => {
    config.value = { project_type_kit: 'gears-project', brief: 'Tea', next_steps_dismissed: ['x'] };
    put.mockResolvedValue(undefined);
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'next_dismiss' }));
    });
    expect(put).toHaveBeenCalledWith({
      project_type_kit: 'gears-project',
      brief: 'Tea',
      next_steps_dismissed: ['x', 'compose-product'],
    });
    expect(invalidate).toHaveBeenCalled();
  });

  it('says so when the dismissal is not written', async () => {
    put.mockRejectedValue(new Error('down'));
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'next_dismiss' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('next_dismiss_failed');
  });
});
