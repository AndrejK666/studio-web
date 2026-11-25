import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useNotify: () => notify,
}));
vi.mock('../../../../i18n', () => {
  const t = Object.assign(
    (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
    { count: (key: string, count: number) => `${key}(${count})` }
  );
  return { useSpecsText: () => t };
});

import { eventBus } from '@gears-frontx/react';
import type { Refusal } from '@constructor-studio/mfe-shared';
import type { ConfirmOutcome } from '../../../../model/specsConfirm';
import { useTypeDecisionRefusals } from './useTypeDecisionRefusals';

const refuse = (projectId: string, refusal: Refusal) =>
  eventBus.emit('mfe/projects/type-decision-refused', { projectId, name: 'prd.md', refusal });

beforeEach(() => notify.mockClear());

describe('a refused type decision', () => {
  it("becomes the shell's error toast, with the gear's reason", () => {
    renderHook(() => useTypeDecisionRefusals('p-1'));
    refuse('p-1', { kind: 'provider', text: 'unknown type' });
    expect(notify).toHaveBeenCalledWith({
      kind: 'error',
      text: 'type_refused_because {"name":"prd.md","reason":"unknown type"}',
    });
  });

  it('uses its own words when the gear gave none', () => {
    renderHook(() => useTypeDecisionRefusals('p-1'));
    refuse('p-1', { kind: 'i18n', key: 'type_refused' });
    expect(notify.mock.calls[0][0]).toEqual({
      kind: 'error',
      text: 'type_refused {"name":"prd.md"}',
    });
  });

  it("is not shown for another project's list", () => {
    renderHook(() => useTypeDecisionRefusals('p-1'));
    refuse('p-2', { kind: 'i18n', key: 'type_refused' });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('a bulk confirmation', () => {
  const settle = (projectId: string, outcome: ConfirmOutcome) =>
    eventBus.emit('mfe/projects/types-confirmed', { projectId, outcome });

  it('says how many were confirmed', () => {
    renderHook(() => useTypeDecisionRefusals('p-1'));
    settle('p-1', { kind: 'confirmed', confirmed: 3, failed: [] });
    expect(notify).toHaveBeenCalledWith({ kind: 'success', text: 'confirm_done(3)' });
  });

  it('names the ones that were not confirmed, and why', () => {
    renderHook(() => useTypeDecisionRefusals('p-1'));
    settle('p-1', {
      kind: 'confirmed',
      confirmed: 1,
      failed: [
        { name: 'adr.md', reason: 'not_proposed' },
        { name: 'gone.md', reason: 'not_found' },
        { name: 'odd.md', reason: 'something_new' },
        { name: 'x.md', reason: 'other_project' },
      ],
    });
    expect(notify).toHaveBeenCalledWith({
      kind: 'error',
      text:
        'confirm_partial ' +
        JSON.stringify({
          done: 'confirm_done(1)',
          failed: 'confirm_failed(4)',
          names:
            'adr.md (confirm_reason_not_proposed), gone.md (confirm_reason_not_found), odd.md (something_new), …',
        }),
    });
  });

  it("says why the call was refused, in the gear's words or its own", () => {
    renderHook(() => useTypeDecisionRefusals('p-1'));
    settle('p-1', { kind: 'refused', refusal: { kind: 'provider', text: 'offline' } });
    settle('p-1', { kind: 'refused', refusal: { kind: 'i18n', key: 'confirm_refused' } });
    expect(notify.mock.calls).toEqual([
      [{ kind: 'error', text: 'confirm_refused_because {"reason":"offline"}' }],
      [{ kind: 'error', text: 'confirm_refused' }],
    ]);
  });

  it("is not shown for another project's list", () => {
    renderHook(() => useTypeDecisionRefusals('p-1'));
    settle('p-2', { kind: 'confirmed', confirmed: 1, failed: [] });
    expect(notify).not.toHaveBeenCalled();
  });
});
