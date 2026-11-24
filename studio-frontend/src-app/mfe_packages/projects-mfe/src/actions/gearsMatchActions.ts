import type { AppDispatch } from '@gears-frontx/react';
import { MatcherError, matcherClient, type MatcherClient } from '../api/gearsMatcherClient';
import { productId, runBody, type MatchChoice, type MatchSpec } from '../model/gearsMatch';
import { runFailed, runFinished, runProgressed, runStarted } from '../slices/gearsMatchSlice';

/** How often a running match is asked how far it is. */
export const POLL_MS = 2000;
/** The service stops a run itself after an hour; this only keeps the page from asking forever. */
const GIVE_UP_MS = 65 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const message = (error: unknown): string =>
  error instanceof MatcherError ? error.message : 'the match could not be completed';

export interface StartMatch {
  projectId: string;
  projectName: string;
  spec: MatchSpec;
  choice: MatchChoice;
}

/**
 * Match the chosen spec to Gears on the chosen connection and model: submit the run, follow it, and
 * read its report. Resolves when the run has ended, whatever the outcome; it never throws.
 */
export async function startGearsMatch(
  dispatch: AppDispatch,
  { projectId, projectName, spec, choice }: StartMatch,
  client: MatcherClient = matcherClient,
  pause: (ms: number) => Promise<void> = sleep
): Promise<void> {
  dispatch(runStarted(projectId));
  try {
    const body = await runBody(spec, choice, productId(projectName));
    // A retry of this very submit answers the same run, so a dropped answer cannot start two.
    let run = await client.submit(body, crypto.randomUUID());
    const until = Date.now() + GIVE_UP_MS;
    while (run.state === 'queued' || run.state === 'running' || run.state === 'cancelling') {
      if (Date.now() > until) throw new MatcherError('the match is taking too long', 'timeout', 0);
      dispatch(
        runProgressed({
          projectId,
          done: run.progress?.requirements_done ?? 0,
          total: run.progress?.requirements_total ?? 0,
          calls: run.usage.calls,
        })
      );
      await pause(POLL_MS);
      run = await client.run(run.id);
    }
    if (run.state === 'succeeded' || run.state === 'partial') {
      const report = await client.report(run.id);
      dispatch(
        runFinished({
          projectId,
          state: run.state,
          calls: run.usage.calls,
          report,
        })
      );
    } else {
      const reason =
        run.error?.message ?? (run.state === 'cancelled' ? 'the match was cancelled' : '');
      dispatch(runFailed({ projectId, message: reason || 'the match failed' }));
    }
  } catch (error) {
    dispatch(runFailed({ projectId, message: message(error) }));
  }
}
