import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmTarget } from '../../../../model/specsConfirm';

const { state, requestTypesConfirm } = vi.hoisted(() => ({
  state: {
    current: {
      selected: [] as string[],
      proposed: null as ConfirmTarget[] | null,
      pending: [] as string[],
    },
  },
  requestTypesConfirm: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useAppSelector: (select: (root: unknown) => unknown) =>
    select({
      'projects/specsCheck': { selected: state.current.selected },
      'projects/typeDecision': {
        pending: state.current.pending,
        proposed: state.current.proposed,
      },
    }),
}));
vi.mock('../../../../i18n', () => {
  const t = Object.assign(
    (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${Object.values(params).join('|')}` : key,
    { count: (key: string, count: number) => `${key} ${count}` }
  );
  return { useSpecsText: () => t };
});
vi.mock('../../../../actions/typeDecisionActions', () => ({ requestTypesConfirm }));

import { ConfirmTypesActions } from './ConfirmTypesActions';

const design = (id: string): ConfirmTarget => ({ id, name: `${id}.md`, typeName: 'Design Document' });
const prd = (id: string): ConfirmTarget => ({
  id,
  name: `${id}.md`,
  typeName: 'Product Requirements (PRD)',
});
const PROPOSED = [design('b-1'), prd('b-2'), design('b-3')];

function given(overrides: Partial<typeof state.current> = {}) {
  state.current = { selected: [], proposed: PROPOSED, pending: [], ...overrides };
}

const renderActions = () => render(<ConfirmTypesActions projectId="p-1" workspaceId="w-1" />);
const button = (name: RegExp) => screen.getByRole('button', { name });
const sent = () => requestTypesConfirm.mock.calls.map(([request]) => request);

beforeEach(() => {
  given();
  requestTypesConfirm.mockClear();
});

describe("the Specs header's bulk Confirm", () => {
  it('shows nothing until the project has a proposed type', () => {
    given({ proposed: null });
    const { container, unmount } = renderActions();
    expect(container.textContent).toBe('');
    unmount();
    given({ proposed: [] });
    expect(renderActions().container.textContent).toBe('');
  });

  it("offers every proposed type of the project, and nothing for a selection that has none", () => {
    given({ selected: ['d-1'] });
    renderActions();
    expect(button(/^confirm_all 3$/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^confirm_selected/ })).toBeNull();
  });

  it('counts only the selected rows with a proposed type', () => {
    given({ selected: ['b-1', 'b-2', 'd-1', 'b-9'] });
    renderActions();
    expect(button(/^confirm_selected 2$/)).toBeTruthy();
  });

  it('asks first for the selection: how many of which type, what it skips, and what confirming does', async () => {
    given({ selected: ['b-1', 'b-2', 'd-1'] });
    renderActions();
    fireEvent.click(button(/^confirm_selected 2$/));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('confirm_title_selected 2');
    expect(dialog.textContent).toContain(
      'confirm_type_count 1|Design Document, confirm_type_count 1|Product Requirements (PRD)'
    );
    expect(dialog.textContent).toContain('confirm_skipped 1');
    expect(dialog.textContent).toContain('confirm_note');
    expect(dialog.textContent).not.toContain('confirm_scope_all');
    expect(requestTypesConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'confirm_go' }));
    expect(sent()).toEqual([
      { projectId: 'p-1', workspaceId: 'w-1', targets: [design('b-1'), prd('b-2')] },
    ]);
  });

  it('confirms every proposed type of the project, whatever is selected, and says so', async () => {
    given({ selected: ['b-1'] });
    renderActions();
    fireEvent.click(button(/^confirm_all 3$/));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('confirm_title_all 3');
    expect(dialog.textContent).toContain(
      'confirm_type_count 2|Design Document, confirm_type_count 1|Product Requirements (PRD)'
    );
    expect(dialog.textContent).toContain('confirm_scope_all');
    expect(dialog.textContent).toContain('confirm_note');

    fireEvent.click(screen.getByRole('button', { name: 'confirm_go' }));
    expect(sent()).toEqual([{ projectId: 'p-1', workspaceId: 'w-1', targets: PROPOSED }]);
  });

  it('confirms nothing when cancelled', async () => {
    renderActions();
    fireEvent.click(button(/^confirm_all 3$/));
    fireEvent.click(await screen.findByRole('button', { name: 'check_cancel' }));
    expect(requestTypesConfirm).not.toHaveBeenCalled();
  });
});
