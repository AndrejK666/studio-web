import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import type { ScreenText } from '@constructor-studio/mfe-shared';

// The kit's DataGrid measures its header.
stubResizeObserver();

beforeAll(() => {
  // jsdom has none, and the kit's filter tags build one on a click.
  globalThis.PointerEvent ??= MouseEvent as unknown as typeof PointerEvent;
});

const { service } = vi.hoisted(() => ({ service: {} as Record<string, unknown> }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
}));

import { ActivityScreen } from './ActivityScreen';

const t = Object.assign(
  (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  { count: (key: string, n: number) => `${key}:${n}` }
) as unknown as ScreenText;

const feed = (items: unknown[] | Error) => () => ({
  fetch: () => (items instanceof Error ? Promise.reject(items) : Promise.resolve({ items, total: items.length })),
});

const check = (id: string, subject = `doc-${id}.md`) => ({
  id,
  kind: 'check',
  event: 'Document checked',
  subject,
  by: 'leak',
  recorded: '2026-11-01T10:00:00Z',
});
const comment = (id: string) => ({ id, kind: 'comment', event: 'Commented', subject: 'README.md', by: 'ann', recorded: null });

/** Chooses a kind in the grid's filter. */
async function chooseKind(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /which_events/ }));
  fireEvent.click(await screen.findByRole('radio', { name }));
}

describe('Project › Activity', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/projects/activity');
  });
  afterEach(cleanup);

  it('opens on the comments when there are any, with both counts in the header', async () => {
    service.activity = feed([check('a'), comment('x')]);
    render(<ActivityScreen projectId="p1" t={t} language="en" />);
    await waitFor(() => expect(screen.getByText('comments:1')).toBeTruthy());
    expect(screen.getByText('checks:1')).toBeTruthy();
    expect(document.querySelector('[data-list-grid="activity"]')).toBeTruthy();
    expect(await screen.findByText('Commented')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Document checked')).toBeNull());
    await waitFor(() => expect(window.location.search).toContain('act.f.kind=comment'));
  });

  it('switches to everything, and keeps the choice in the address', async () => {
    service.activity = feed([check('a'), comment('x')]);
    render(<ActivityScreen projectId="p1" t={t} language="en" />);
    await screen.findByText('Commented');
    await chooseKind('kind_all');
    expect(await screen.findByText('Document checked')).toBeTruthy();
    await waitFor(() => expect(window.location.search).toContain('act.f.kind=all'));
  });

  it('opens on the kind the address names', async () => {
    window.history.replaceState(null, '', '/projects/activity?act.f.kind=check');
    service.activity = feed([check('a'), comment('x')]);
    render(<ActivityScreen projectId="p1" t={t} language="en" />);
    expect(await screen.findByText('Document checked')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Commented')).toBeNull());
  });

  it('folds a run of checks into one row that opens to its documents under the list', async () => {
    service.activity = feed([check('a'), check('b'), check('c')]);
    render(<ActivityScreen projectId="p1" t={t} language="en" />);
    await screen.findByText('run_documents:3');
    expect(screen.queryByText('doc-b.md')).toBeNull();
    fireEvent.click(document.querySelector('[data-activity-run-toggle]')!);
    expect(screen.getByText('doc-b.md')).toBeTruthy();
    expect(document.querySelector('[data-list-grid="activity"] [data-activity-run]')).toBeNull();
  });

  it('searches every column, a run’s documents too, and says when nothing matched', async () => {
    service.activity = feed([check('a'), check('b', 'special.md'), check('c'), comment('x')]);
    render(<ActivityScreen projectId="p1" t={t} language="en" />);
    await screen.findByText('Commented');
    await chooseKind('kind_all');
    await screen.findByText('run_documents:3');
    fireEvent.change(screen.getByPlaceholderText('search'), { target: { value: 'special' } });
    await waitFor(() => expect(screen.queryByText('Commented')).toBeNull());
    expect(screen.getByText('run_documents:3')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('search'), { target: { value: 'nothing-like-it' } });
    expect(await screen.findByText('no_matches')).toBeTruthy();
    fireEvent.click(screen.getByText('clear_search'));
    // Clear search drops the kind too: everything shows.
    expect(await screen.findByText('Commented')).toBeTruthy();
    expect(screen.getByText('run_documents:3')).toBeTruthy();
  });

  it('says nothing is recorded yet, and where records come from', async () => {
    service.activity = feed([]);
    render(<ActivityScreen projectId="p1" t={t} language="en" />);
    expect(await screen.findByText('empty_title')).toBeTruthy();
    expect(screen.getByText('empty_body')).toBeTruthy();
    expect(document.querySelector('[data-activity-empty]')).toBeTruthy();
  });

  it('says the feed could not be read, with the gear’s words, and tries again', async () => {
    service.activity = feed(new Error('ingest is down'));
    render(<ActivityScreen projectId="p1" t={t} language="en" />);
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain('ingest is down');
    expect(screen.queryByText('empty_title')).toBeNull();
    service.activity = feed([comment('x')]);
    fireEvent.click(screen.getByText('retry'));
    expect(await screen.findByText('Commented')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
