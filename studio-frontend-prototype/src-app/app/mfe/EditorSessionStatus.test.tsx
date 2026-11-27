import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { mockEmit, store } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  store: { state: {} as Record<string, unknown> },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useAppSelector: (select: (root: Record<string, unknown>) => unknown) => select(store.state),
  eventBus: { on: vi.fn(), emit: mockEmit },
}));

// The strings are the dictionary's; what is under test is which key is asked for.
vi.mock('@/app/i18n/shellTranslations', () => ({ useShellText: () => (key: string) => key }));

import { EDITOR_SESSION_SLICE_KEY, type EditorSessionState } from '@/app/slices/editorSessionSlice';
import { EditorSessionStatus } from './EditorSessionStatus';
import DICTIONARY from '@/app/i18n/en.json';

function show(state: Partial<EditorSessionState>): void {
  store.state = {
    [EDITOR_SESSION_SLICE_KEY]: { phase: 'idle', failure: null, shown: true, clones: [], runtime: null, ...state } satisfies EditorSessionState,
  };
}

describe('EditorSessionStatus', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    store.state = {};
  });

  it('draws nothing off the editor, before the slice exists, or while the session is idle or ready', () => {
    const { container, rerender } = render(<EditorSessionStatus />);
    expect(container.innerHTML).toBe('');

    show({ phase: 'launching', shown: false });
    rerender(<EditorSessionStatus />);
    expect(container.innerHTML).toBe('');

    for (const phase of ['idle', 'ready'] as const) {
      show({ phase });
      rerender(<EditorSessionStatus />);
      expect(container.innerHTML).toBe('');
    }
  });

  it('says the editor is being launched', () => {
    show({ phase: 'launching' });
    render(<EditorSessionStatus />);

    expect(screen.getByRole('status').textContent).toBe('editor_session_launching');
  });

  it('names a source that could not be cloned, why, and what fixes it, instead of only waiting', () => {
    show({
      phase: 'launching',
      clones: [
        {
          repository: 'acme/web',
          cause: 'branch_not_found',
          causeText: 'The branch the source names no longer exists.',
          action: 'pick_branch',
          actionText: null,
          detail: 'feature/gone',
        },
        { repository: 'acme/api', cause: 'later_cause', causeText: 'A cause the portal has no words for.', action: null, actionText: null, detail: null },
      ],
    });
    render(<EditorSessionStatus />);

    const web = document.querySelector('[data-editor-clone-problem="acme/web"]');
    expect(web?.textContent).toBe('editor_clone_failededitor_clone_cause_branch_not_foundeditor_clone_action_pick_branch');
    const api = document.querySelector('[data-editor-clone-problem="acme/api"]');
    expect(api?.textContent).toBe('editor_clone_failedA cause the portal has no words for.');
  });

  it.each([
    ["the backend's own detail", { kind: 'refused', detail: 'IDE sessions are off here' }, 'IDE sessions are off here'],
    ['a refusal with nothing said', { kind: 'refused', detail: null }, 'editor_session_reason_refused'],
    ["the run's own error", { kind: 'run', error: 'still starting after 3 minutes' }, 'still starting after 3 minutes'],
    ['a run that ended with nothing said', { kind: 'run', error: null }, 'editor_session_reason_run'],
    ['a project out of reach', { kind: 'unavailable' }, 'editor_session_reason_unavailable'],
    ['a session that stopped', { kind: 'stopped' }, 'editor_session_reason_stopped'],
    ['a session the person stopped', { kind: 'ended' }, 'editor_session_reason_ended'],
    ['a record that never said running', { kind: 'timeout' }, 'editor_session_reason_timeout'],
    ['a state that could not be read', { kind: 'read' }, 'editor_session_reason_read'],
    ['an IDE that never answered', { kind: 'unanswered' }, 'editor_session_reason_unanswered'],
    ["the portal's own error", { kind: 'unexpected' }, 'editor_session_reason_unexpected'],
    ['sources that could not be read', { kind: 'sources' }, 'editor_session_reason_sources'],
  ] as const)('explains %s', (_case, failure, reason) => {
    show({ phase: 'failed', failure });
    render(<EditorSessionStatus />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('editor_session_failed');
    expect(alert.textContent).toContain(reason);
    // A key the component asks for must be in the dictionary, or a raw key renders.
    if (reason.startsWith('editor_session_')) expect(DICTIONARY).toHaveProperty(reason);
  });

  it('asks the shell to try again', () => {
    show({ phase: 'failed', failure: { kind: 'run', error: null } });
    render(<EditorSessionStatus />);

    fireEvent.click(screen.getByRole('button', { name: 'editor_session_retry' }));

    expect(mockEmit).toHaveBeenCalledWith('app/editor/session/retry');
  });
});
