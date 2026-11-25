import { withOwnQueryCache } from '@frontx-test-utils/withOwnQueryCache';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider } from '@gears-frontx/react';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '@frontx-test-utils/createMfeBridgeFixture.ts';
// Static, not inside the first test: the cold import of the whole MFE is paid at
// collection, where no test timeout applies (it took over 30 s on a loaded run).
import { mfeApp } from '../../init';
import { NewProjectWizard } from './NewProjectWizard';

/** The wizard's frame around its steps: the first-load skeleton and the failure. */

const { translations, projectTypes } = vi.hoisted(() => ({
  translations: { current: { isLoaded: true, error: null as Error | null } },
  projectTypes: { items: [] as { slug: string; name: string; description: string }[] },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...await withOwnQueryCache(importOriginal),
  useApiQuery: () => ({ data: projectTypes, isLoading: false, isError: false }),
}));

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  OrganizationProvider: ({ children }: { children: React.ReactNode }) => children,
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
  useOrganization: () => ({ org: { id: 'org-1', name: 'Fabric' }, loading: false, failed: false }),
  useWorkspace: () => ({ workspace: { id: 'ws-1', name: 'Platform' }, loading: false, failed: false }),
  useHostChrome: () => ({ containerRef: { current: null }, dataTheme: 'light', language: 'en' }),
}));

vi.mock('../../i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../i18n')>()),
  useProjectCreateScreenTranslations: () => translations.current,
  useProjectCreateText: () => (key: string) => key,
}));

vi.mock('../../shared/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 'user-1', asUser: null }),
}));

// The steps have their own tests; here each is a marker the frame shows or holds back.
vi.mock('./steps/DetailsStep', () => ({ DetailsStep: () => <p>details step</p> }));

async function mountWizard() {
  const { bridge } = createMfeBridgeFixture({ domainId: 'overlay', instanceId: 'inst' });

  const tree = () => (
    <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(bridge)}>
      <NewProjectWizard />
    </FrontXProvider>
  );
  const view = render(tree());
  return { app: mfeApp, rerender: () => view.rerender(tree()) };
}

beforeEach(() => {
  translations.current = { isLoaded: true, error: null };
  projectTypes.items = [];
});

it('requires a project type when kits supply a choice', async () => {
  projectTypes.items = [
    { slug: 'gears-project', name: 'Gears', description: '' },
    { slug: 'constructor-research', name: 'Constructor Research', description: '' },
  ];
  const { app } = await mountWizard();
  const { editDraft } = await import('../../slices/createSlice');
  act(() => { app.store.dispatch(editDraft({ name: 'Shop' })); });
  const create = screen.getByRole<HTMLButtonElement>('button', { name: 'create' });
  expect(create.disabled).toBe(true);
  act(() => { app.store.dispatch(editDraft({ typeKit: 'constructor-research' })); });
  expect(create.disabled).toBe(false);
});

describe('the wizard behind its first-load skeleton', () => {
  it('waits for the dictionary once, not again while a language change loads it', async () => {
    translations.current = { isLoaded: false, error: null };
    const { rerender } = await mountWizard();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByText('details step')).toBeNull();

    translations.current = { isLoaded: true, error: null };
    rerender();
    expect(screen.getByRole('heading', { name: 'title' })).toBeTruthy();
    expect(screen.getByText('details step')).toBeTruthy();

    translations.current = { isLoaded: false, error: null };
    rerender();
    expect(screen.getByText('details step')).toBeTruthy();
  });

  it('shows the failure, not the skeleton, when the dictionary does not load', async () => {
    translations.current = { isLoaded: false, error: new Error('no dictionary') };
    await mountWizard();

    expect(screen.getByRole('alert').textContent).toBe('Could not load this screen.');
    expect(screen.getByText('details step')).toBeTruthy();
  });
});

describe('one step: the type decides what follows', () => {
  it('creates from the details, with Cancel beside it and no Continue', async () => {
    const { app } = await mountWizard();
    const { editDraft } = await import('../../slices/createSlice');
    act(() => {
      app.store.dispatch(editDraft({ name: 'Billing' }));
    });
    expect(screen.getByRole('heading', { name: 'title' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'continue' })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'create' }).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.getByText('details step')).toBeTruthy();
  });
});

describe('NewProjectWizard: the server creating the project', () => {
  it("shows the run's steps in place of the form, and which one stopped", async () => {
    const { app } = await mountWizard();
    const { submitFailed, submitProgress, submitStarted } = await import('../../slices/createSlice');
    act(() => {
      app.store.dispatch(submitStarted());
      app.store.dispatch(
        submitProgress({
          runId: 'r1',
          state: 'running',
          steps: [
            { key: 'tenant', state: 'done' },
            { key: 'config', state: 'pending' },
          ],
        })
      );
    });
    expect(screen.getByText('progress_title')).toBeTruthy();
    expect(screen.queryByText('details step')).toBeNull();
    expect(document.querySelector('[data-create-step="tenant"]')?.getAttribute('data-state')).toBe('done');
    expect(screen.queryByText('retry_hint')).toBeNull();

    act(() => {
      app.store.dispatch(
        submitProgress({
          runId: 'r1',
          state: 'failed',
          steps: [
            { key: 'tenant', state: 'done' },
            { key: 'config', state: 'failed', detail: 'account-management down' },
          ],
        })
      );
      app.store.dispatch(submitFailed({ kind: 'provider', text: 'account-management down' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('account-management down');
    expect(screen.getByText('step_failed')).toBeTruthy();
    expect(screen.getByText('retry_hint')).toBeTruthy();
  });
});
