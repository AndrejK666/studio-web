/**
 * What one embedded frame posts to the window around it. Only messages from
 * the frame's own window, sent from `origin`, reach `onData`: a frame on
 * another address, or any other window posting to this one, is nobody's.
 * Generic plumbing for a page that embeds a frame and talks to it, the
 * shell's editor bridge among them.
 */
export function onFrameMessage(
  frame: HTMLIFrameElement,
  origin: string,
  onData: (data: unknown) => void
): () => void {
  const around = frame.ownerDocument.defaultView;
  const listener = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    onData(event.data);
  };
  around?.addEventListener('message', listener);
  return () => around?.removeEventListener('message', listener);
}
