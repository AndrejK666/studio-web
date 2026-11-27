import { describe, expect, it, vi } from 'vitest';
import { onFrameMessage } from './frameMessages';

function frameAt(src: string) {
  const around = new EventTarget();
  const content = {};
  const frame = { src, contentWindow: content, ownerDocument: { defaultView: around } } as unknown as HTMLIFrameElement;
  const post = (data: unknown, source: unknown = content, origin = new URL(src).origin): void => {
    const event = new Event('message');
    Object.defineProperties(event, { data: { value: data }, source: { value: source }, origin: { value: origin } });
    around.dispatchEvent(event);
  };
  return { frame, post };
}

describe('onFrameMessage', () => {
  it("hands on what the frame's own window posts from its origin", () => {
    const { frame, post } = frameAt('https://ide.test/s1/');
    const onData = vi.fn();
    onFrameMessage(frame, 'https://ide.test', onData);
    post({ type: 'hello' });
    expect(onData).toHaveBeenCalledWith({ type: 'hello' });
  });

  it('ignores another window, another origin, and anything after it is stopped', () => {
    const { frame, post } = frameAt('https://ide.test/s1/');
    const onData = vi.fn();
    const stop = onFrameMessage(frame, 'https://ide.test', onData);
    post({ type: 'x' }, {});
    post({ type: 'x' }, undefined, 'https://evil.test');
    stop();
    post({ type: 'x' });
    expect(onData).not.toHaveBeenCalled();
  });
});
