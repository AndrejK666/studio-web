/**
 * Polling that rests while the tab is hidden. A portal left open in a
 * background tab used to keep every screen's re-read going, for nobody: each
 * one costs the server a read. Here a loop stops ticking while
 * `document.visibilityState` is `hidden`, and when the tab is shown again it
 * reads once at once (what it shows may be minutes old) and resumes its pace.
 *
 * Only `hidden` rests a loop: a page the browser has not said is hidden (a
 * prerender, a test without a document) polls as before.
 */

import { useEffect, useRef } from 'react';

/** Whether the page is hidden now (a background tab, a minimised window). */
export function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Runs `fn` now if the page is shown, else once when it is shown next. For a
 * `setTimeout` chain: its next step waits for the person to look. Returns a
 * cancel.
 */
export function runWhenVisible(fn: () => void): () => void {
  if (!isPageHidden()) {
    fn();
    return () => undefined;
  }
  const onChange = () => {
    if (isPageHidden()) return;
    document.removeEventListener('visibilitychange', onChange);
    fn();
  };
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

export interface PollWhileVisibleOptions {
  /**
   * What runs when the tab is shown again, instead of `fn`: a loop that knows
   * its answer is still fresh can skip the read.
   */
  onVisible?: () => void;
}

/**
 * Calls `fn` every `ms` while the page is shown; no ticks while it is hidden.
 * When it is shown again `onVisible` (else `fn`) runs once at once and the
 * interval starts over. Does not call `fn` at the start: the caller reads
 * first if it wants to. Returns a stop.
 */
export function pollWhileVisible(fn: () => void, ms: number, options: PollWhileVisibleOptions = {}): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (timer === undefined) timer = setInterval(fn, ms);
  };
  const pause = () => {
    clearInterval(timer);
    timer = undefined;
  };
  if (typeof document === 'undefined') {
    start();
    return pause;
  }
  const onChange = () => {
    if (isPageHidden()) {
      pause();
      return;
    }
    if (timer !== undefined) return;
    (options.onVisible ?? fn)();
    start();
  };
  if (!isPageHidden()) start();
  document.addEventListener('visibilitychange', onChange);
  return () => {
    document.removeEventListener('visibilitychange', onChange);
    pause();
  };
}

/**
 * {@link pollWhileVisible} for a component: polls while `enabled`, with the
 * latest `fn`/`onVisible` of each render (a new callback does not restart
 * the interval).
 */
export function usePollWhileVisible(fn: () => void, ms: number, enabled = true, onVisible?: () => void): void {
  const latest = useRef({ fn, onVisible });
  useEffect(() => {
    latest.current = { fn, onVisible };
  });
  useEffect(() => {
    if (!enabled) return;
    return pollWhileVisible(() => latest.current.fn(), ms, {
      onVisible: () => (latest.current.onVisible ?? latest.current.fn)(),
    });
  }, [ms, enabled]);
}
