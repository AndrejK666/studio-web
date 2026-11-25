import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { service } = vi.hoisted(() => ({ service: {} as Record<string, unknown> }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
  // The shared kit-absent state reads its own words, the bridge and the shell's screens.
  useScreenTranslations: () => ({ isLoaded: true }),
  useTranslation: () => ({ language: 'en', t: (key: string) => key }),
  useMfeBridge: () => null,
  useSharedProperty: () => null,
}));

import { PullsView } from './PullsView';

const text = (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key);
// The screen's translator also counts (ScreenText); this view does not use it.
const t = Object.assign(text, { count: (key: string, count: number) => `${key} ${count}` }) as unknown as Parameters<
  typeof PullsView
>[0]['t'];
const pull = { id: 'pr6', repo: 'o/r', number: 6, title: 'docs(oagw): point to the decision', url: null, source_branch: 'demo-broken-link' };
const thread = {
  path: 'gears/system/oagw/docs/DESIGN.md',
  line: 124,
  rule: 'link.resolves',
  gate: 'block' as const,
  fingerprints: ['98a8faeda919d466'],
  body: '**Blocking** · A link points at a file that does not exist',
};
const review = { base: 'b'.repeat(40), head: 'h'.repeat(40), count: 1, blocking: 1, dismissed: 0, threads: [thread], outside_diff: [], fingerprints: ['98a8faeda919d466'] };

describe('PullsView', () => {
  beforeEach(() => {
    for (const k of Object.keys(service)) delete service[k];
    service.openPullRequests = () => ({ fetch: () => Promise.resolve({ items: [pull], total: 1 }) });
  });

  it('says Git collaboration is not installed where its gear does not answer', async () => {
    service.openPullRequests = () => ({
      fetch: () => Promise.reject(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: '' } })),
    });
    render(<PullsView projectId="p1" repository="o/r" defaultBase="main" t={t} />);
    await waitFor(() => expect(document.querySelector('[data-kit-absent="project-git"]')).toBeTruthy());
    expect(screen.queryByText(/404/)).toBeNull();
  });

  it('reviews a pull request against the base and shows its threads', async () => {
    const reviewCall = vi.fn((..._a: unknown[]) => Promise.resolve({ review, run: null }));
    service.review = (projectId: string) => ({ fetch: (body: unknown) => reviewCall(projectId, body) });
    render(<PullsView projectId="p1" repository="o/r" defaultBase="main" t={t} />);
    fireEvent.change(await screen.findByDisplayValue('main'), { target: { value: 'spec-quality-demo' } });
    fireEvent.click(screen.getByText('review'));
    await waitFor(() =>
      expect(reviewCall).toHaveBeenCalledWith('p1', { base: 'spec-quality-demo', head: 'demo-broken-link', model: false })
    );
    expect(await screen.findByText('gears/system/oagw/docs/DESIGN.md:124')).toBeTruthy();
    expect(screen.getByText(/A link points at a file that does not exist/)).toBeTruthy();
    expect(screen.getByText(/threads_one/)).toBeTruthy();
  });

  it('follows a model review run to its end', async () => {
    const states = ['running', 'succeeded'];
    service.review = () => ({
      fetch: () => Promise.resolve({ review: null, run: { id: 'r1', job: 'review', state: 'queued', error: null, result: null } }),
    });
    service.run = () => ({
      fetch: () => {
        const state = states.shift() ?? 'succeeded';
        return Promise.resolve({
          run: {
            id: 'r1',
            job: 'review',
            state,
            error: null,
            result: state === 'succeeded' ? { ...review, stats: { model_cost_usd: 0.0376 } } : null,
          },
        });
      },
    });
    render(<PullsView projectId="p1" repository="o/r" defaultBase="spec-quality-demo" t={t} />);
    fireEvent.click(await screen.findByText('review_model'));
    expect(await screen.findByText('gears/system/oagw/docs/DESIGN.md:124')).toBeTruthy();
    expect(screen.getByText(/0\.038/)).toBeTruthy();
  });

  it('lists only the repository the graph reads, so the same branch elsewhere is not reviewed', async () => {
    const other = { ...pull, id: 'pr9', repo: 'acme/other', number: 9, title: 'the same branch in another repository' };
    service.openPullRequests = () => ({ fetch: () => Promise.resolve({ items: [other, pull], total: 2 }) });
    const reviewCall = vi.fn((..._a: unknown[]) => Promise.resolve({ review, run: null }));
    service.review = (projectId: string) => ({ fetch: (body: unknown) => reviewCall(projectId, body) });
    render(<PullsView projectId="p1" repository="O/R" defaultBase="main" t={t} />);
    expect(await screen.findByText('#6')).toBeTruthy();
    expect(screen.queryByText('#9')).toBeNull();
    expect(screen.getByText(/pulls_other_repos/)).toBeTruthy();
    // One pull request listed: one Review button, and it reviews #6's branch.
    expect(screen.getAllByText('review')).toHaveLength(1);
    fireEvent.click(screen.getByText('review'));
    await waitFor(() =>
      expect(reviewCall).toHaveBeenCalledWith('p1', { base: 'main', head: 'demo-broken-link', model: false })
    );
  });

  it('lists none when the repository the graph reads is not known', async () => {
    render(<PullsView projectId="p1" repository={null} defaultBase="main" t={t} />);
    expect(await screen.findByText('pulls_no_repository')).toBeTruthy();
    expect(screen.queryByText('#6')).toBeNull();
  });

  it('says so when the project has no open pull request', async () => {
    service.openPullRequests = () => ({ fetch: () => Promise.resolve({ items: [], total: 0 }) });
    render(<PullsView projectId="p1" repository="o/r" defaultBase="main" t={t} />);
    expect(await screen.findByText(/no_pulls/)).toBeTruthy();
  });
});
