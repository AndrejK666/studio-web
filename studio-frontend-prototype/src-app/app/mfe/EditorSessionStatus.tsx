// @cpt-dod:cpt-studiofrontend-dod-editor-session-states:p1
/**
 * What the editor's session is doing, drawn by the shell over the editor's
 * slot while the editor is on screen. The slot stays mounted underneath.
 */
import { eventBus, useAppSelector } from '@gears-frontx/react';
import { Button } from '@gears-frontx/ui-kit/button';
import type { ScreenText } from '@constructor-studio/mfe-shared';
import { useShellText } from '@/app/i18n/shellTranslations';
import {
  EDITOR_SESSION_SLICE_KEY,
  type EditorCloneProblem,
  type EditorSessionFailure,
  type EditorSessionState,
} from '@/app/slices/editorSessionSlice';

/** The backend's own words where it gave some. Exhaustive: a new kind without a line here does not compile. */
function reason(failure: EditorSessionFailure, t: ScreenText): string {
  switch (failure.kind) {
    case 'refused':
      return failure.detail ?? t('editor_session_reason_refused');
    case 'run':
      return failure.error ?? t('editor_session_reason_run');
    case 'unavailable':
      return t('editor_session_reason_unavailable');
    case 'stopped':
      return t('editor_session_reason_stopped');
    case 'ended':
      return t('editor_session_reason_ended');
    case 'timeout':
      return t('editor_session_reason_timeout');
    case 'read':
      return t('editor_session_reason_read');
    case 'unanswered':
      return t('editor_session_reason_unanswered');
    case 'unexpected':
      return t('editor_session_reason_unexpected');
    case 'sources':
      return t('editor_session_reason_sources');
  }
}

/** Causes and actions the portal words itself (the backend's `CloneCause` / `CloneAction`); any other keeps the backend's sentence. */
const CLONE_CAUSES: ReadonlySet<string> = new Set([
  'no_connection',
  'connection_not_found',
  'connection_personal',
  'held_outside',
  'token_unreadable',
  'provider_refused',
  'repository_not_found',
  'unreachable',
  'provider_error',
  'not_http',
]);
const CLONE_ACTIONS: ReadonlySet<string> = new Set([
  'connect',
  'reconnect',
  'ask_admin',
  'check_repository',
  'retry',
  'pick_branch',
]);

/** One source that could not be cloned: which, why, and what fixes it. */
function cloneProblemText(problem: EditorCloneProblem, t: ScreenText): { cause: string; action: string | null } {
  const cause =
    problem.cause === 'branch_not_found' && problem.detail
      ? t('editor_clone_cause_branch_not_found', { branch: problem.detail })
      : problem.cause && CLONE_CAUSES.has(problem.cause)
        ? t(`editor_clone_cause_${problem.cause}`)
        : (problem.causeText ?? t('editor_clone_cause_unknown'));
  const action =
    problem.action && CLONE_ACTIONS.has(problem.action) ? t(`editor_clone_action_${problem.action}`) : problem.actionText;
  return { cause, action };
}

/** The project's sources that could not be cloned; the IDE opens without them, or never answers. */
function CloneProblems({ problems, t }: { problems: EditorCloneProblem[]; t: ScreenText }) {
  if (problems.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-col gap-2" data-editor-clone-problems>
      {problems.map((problem) => {
        const { cause, action } = cloneProblemText(problem, t);
        return (
          <li key={problem.repository} className="text-label" data-editor-clone-problem={problem.repository}>
            <div className="font-medium text-foreground">{t('editor_clone_failed', { repository: problem.repository })}</div>
            <div className="text-muted-foreground">{cause}</div>
            {action && <div className="text-muted-foreground">{action}</div>}
          </li>
        );
      })}
    </ul>
  );
}

export function EditorSessionStatus() {
  const t = useShellText();
  const session = useAppSelector(
    (state) => state[EDITOR_SESSION_SLICE_KEY] as EditorSessionState | undefined
  );
  if (!session?.shown) return null;
  const clones = session.clones ?? [];

  if (session.phase === 'launching') {
    return (
      // Until the IDE in the frame answers, not only until the backend says ready (editor-bridge.md).
      <div className="absolute inset-0 bg-card p-6 text-label text-muted-foreground" role="status" data-editor-session="launching">
        {t('editor_session_launching')}
        <CloneProblems problems={clones} t={t} />
      </div>
    );
  }

  if (session.phase !== 'failed' || !session.failure) return null;
  return (
    <div className="absolute inset-0 flex flex-col gap-2 bg-card p-6" role="alert" data-editor-session="failed">
      <div className="text-body font-medium text-foreground">{t('editor_session_failed')}</div>
      <div className="text-label text-muted-foreground">{reason(session.failure, t)}</div>
      <CloneProblems problems={clones} t={t} />
      <div>
        <Button onClick={() => eventBus.emit('app/editor/session/retry')}>{t('editor_session_retry')}</Button>
      </div>
    </div>
  );
}
