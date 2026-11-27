/**
 * Follows `studio-tasks` runs on the tenant's event stream until each settles.
 * Runs are read on an interval only while the stream cannot say: when it is
 * not open, and for a run it has not mentioned yet. A run filed in another
 * tenant than the caller's home (a platform administrator's sync, filed under
 * the project's organization) never reaches this stream, and is read to the end.
 */

import { errorMessage } from '../errors/message';
import { isNotFound } from '../errors/notFound';
import type { StudioEventsApiService } from './StudioEventsApiService';
import type { StudioTasksApiService } from './StudioTasksApiService';
import { isRunSettled, runUpdateFromEvent, runUpdateFromRun, type RunUpdate } from './runs';

export const RUN_POLL_INTERVAL_MS = 2_000;

export const RUN_MAX_READ_FAILURES = 5;

export interface RunFollowerOptions {
  events: Pick<StudioEventsApiService, 'streamFrom'>;
  tasks: Pick<StudioTasksApiService, 'run'>;
  onRun: (update: RunUpdate) => void;
  /** The gear does not know the run, or `RUN_MAX_READ_FAILURES` reads in a row failed; it is no longer followed. */
  onLost: (runId: string, error: unknown) => void;
  /** A read failed; `failures` counts them in a row. */
  onReadFailed?: (runId: string, error: unknown, failures: number) => void;
}

export interface RunFollower {
  /**
   * Follows these runs too. A stream not yet open starts at `cursor`, read
   * before the runs were started; `null` reads them on an interval instead.
   * A run that joins an open stream is read once, for what it did before;
   * if that read fails, the stream is dropped for the interval.
   */
  follow(runIds: readonly string[], cursor: number | null): void;
  /** Follows nothing more, and closes the stream. */
  stop(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The tenant's cursor, for {@link RunFollower.follow}. Read it BEFORE starting
 * the runs; `null` when it cannot be read, and the runs are then read on an interval.
 */
export async function readCursor(
  events: Pick<StudioEventsApiService, 'cursor'>,
  label: string
): Promise<number | null> {
  try {
    return (await events.cursor.fetch({ staleTime: 0 })).latest_seq;
  } catch (error) {
    console.warn(`[${label}] no event cursor:`, errorMessage(error));
    return null;
  }
}

export function createRunFollower(options: RunFollowerOptions): RunFollower {
  const followed = new Set<string>();
  const failures = new Map<string, number>();
  let stream: ReturnType<StudioEventsApiService['streamFrom']> | null = null;
  let connection: Promise<string> | null = null;
  let polling = false;
  /** Runs on the open stream that it has not mentioned yet. */
  const unheard = new Set<string>();
  let checking = false;

  const close = (): void => {
    const open = stream;
    const id = connection;
    stream = null;
    connection = null;
    unheard.clear();
    if (open && id) void id.then((value) => open.disconnect(value), () => undefined);
  };

  const forget = (runId: string): void => {
    followed.delete(runId);
    failures.delete(runId);
    unheard.delete(runId);
    if (followed.size === 0) close();
  };

  const apply = (update: RunUpdate): void => {
    if (!followed.has(update.runId)) return;
    if (isRunSettled(update.state)) forget(update.runId);
    options.onRun(update);
  };

  const lose = (runId: string, error: unknown): void => {
    forget(runId);
    options.onLost(runId, error);
  };

  const read = async (runId: string): Promise<void> => {
    try {
      const run = await options.tasks.run({ runId }).fetch({ staleTime: 0 });
      failures.delete(runId);
      apply(runUpdateFromRun(run));
    } catch (error) {
      if (!followed.has(runId)) return;
      if (isNotFound(error)) return lose(runId, error);
      const count = (failures.get(runId) ?? 0) + 1;
      failures.set(runId, count);
      options.onReadFailed?.(runId, error, count);
      if (count >= RUN_MAX_READ_FAILURES) lose(runId, error);
    }
  };

  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    close();
    while (followed.size > 0) {
      await sleep(RUN_POLL_INTERVAL_MS);
      await Promise.all([...followed].map(read));
    }
    polling = false;
  };

  /** Reads the runs the open stream has not mentioned, on the interval, until it does or they settle. */
  const check = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    while (stream && unheard.size > 0) {
      await sleep(RUN_POLL_INTERVAL_MS);
      if (!stream) break;
      await Promise.all([...unheard].map(read));
    }
    checking = false;
  };

  const fallBack = (from: typeof stream): void => {
    if (stream !== from) return;
    stream = null;
    connection = null;
    unheard.clear();
    void poll();
  };

  return {
    follow(runIds, cursor) {
      const joining = runIds.filter((runId) => !followed.has(runId));
      if (joining.length === 0) return;
      joining.forEach((runId) => followed.add(runId));
      if (polling) return;
      if (stream) {
        const joined = stream;
        joining.forEach((runId) => unheard.add(runId));
        void check();
        joining.forEach((runId) => {
          // The stream dropped what the run did before it joined: if this read fails, only the interval can tell.
          void read(runId).then(() => {
            if (failures.has(runId) && stream === joined) void poll();
          });
        });
        return;
      }
      if (cursor === null) {
        void poll();
        return;
      }
      const opened = options.events.streamFrom(cursor);
      stream = opened;
      joining.forEach((runId) => unheard.add(runId));
      void check();
      connection = opened.connect(
        (event) => {
          const update = runUpdateFromEvent(event);
          if (!update) return;
          unheard.delete(update.runId);
          apply(update);
        },
        () => fallBack(opened)
      );
      connection.catch(() => fallBack(opened));
    },

    stop() {
      followed.clear();
      failures.clear();
      close();
    },
  };
}
