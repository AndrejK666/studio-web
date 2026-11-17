import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPageHidden, pollWhileVisible, runWhenVisible, usePollWhileVisible } from './pollWhileVisible';

let state: DocumentVisibilityState = 'visible';

function show(next: DocumentVisibilityState) {
  state = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  state = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => state === 'hidden');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('isPageHidden', () => {
  it('is true only for a hidden page', () => {
    expect(isPageHidden()).toBe(false);
    state = 'hidden';
    expect(isPageHidden()).toBe(true);
  });
});

describe('pollWhileVisible', () => {
  it('ticks while shown, rests while hidden, reads at once when shown again', () => {
    const fn = vi.fn();
    const stop = pollWhileVisible(fn, 1000);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);

    show('hidden');
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(2);

    show('visible');
    expect(fn).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(999);
    expect(fn).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(4);

    stop();
    vi.advanceTimersByTime(10_000);
    show('hidden');
    show('visible');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('starts resting when the page is hidden from the start', () => {
    state = 'hidden';
    const fn = vi.fn();
    const stop = pollWhileVisible(fn, 1000);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    show('visible');
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
  });

  it('runs onVisible instead of fn when shown again', () => {
    const fn = vi.fn();
    const onVisible = vi.fn();
    const stop = pollWhileVisible(fn, 1000, { onVisible });
    show('hidden');
    show('visible');
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not read twice when told it is visible while already ticking', () => {
    const fn = vi.fn();
    const stop = pollWhileVisible(fn, 1000);
    show('visible');
    expect(fn).not.toHaveBeenCalled();
    stop();
  });
});

describe('runWhenVisible', () => {
  it('runs at once on a shown page', () => {
    const fn = vi.fn();
    runWhenVisible(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits for a hidden page to be shown, once', () => {
    state = 'hidden';
    const fn = vi.fn();
    runWhenVisible(fn);
    expect(fn).not.toHaveBeenCalled();
    show('visible');
    show('hidden');
    show('visible');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled while it waits', () => {
    state = 'hidden';
    const fn = vi.fn();
    const cancel = runWhenVisible(fn);
    cancel();
    show('visible');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('usePollWhileVisible', () => {
  function Poller({ fn, enabled, onVisible }: { fn: () => void; enabled: boolean; onVisible?: () => void }) {
    usePollWhileVisible(fn, 1000, enabled, onVisible);
    return null;
  }

  it('polls while enabled, with the latest callback, and rests while hidden', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Poller fn={first} enabled />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(first).toHaveBeenCalledTimes(1);

    view.rerender(<Poller fn={second} enabled />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    act(() => show('hidden'));
    act(() => void vi.advanceTimersByTime(5000));
    expect(second).toHaveBeenCalledTimes(1);
    act(() => show('visible'));
    expect(second).toHaveBeenCalledTimes(2);

    view.rerender(<Poller fn={second} enabled={false} />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(second).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('calls onVisible when shown again', () => {
    const fn = vi.fn();
    const onVisible = vi.fn();
    const view = render(<Poller fn={fn} enabled onVisible={onVisible} />);
    act(() => show('hidden'));
    act(() => show('visible'));
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
    view.unmount();
  });
});
