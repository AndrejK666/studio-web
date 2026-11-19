import { useCallback, useState } from 'react';

/**
 * The topmost element of the shadow root `node` lives in, or `null` outside one.
 * Since #1075 the shadow host carries the portal's palette, so everything under
 * it, this element included, takes the portal's tokens.
 */
function shadowTop(node: HTMLElement): HTMLElement | null {
  let top = node;
  while (top.parentElement) top = top.parentElement;
  return top.parentNode instanceof ShadowRoot ? top : null;
}

/**
 * The themed root of the node the ref is put on: the container a popup portals
 * into. A popup that portals out of the MFE's shadow root, or out of its themed
 * root, paints with the document's theme or with none; hand it this node as
 * `container` (`portalContainer` on a `DataGrid`) and it takes the screen's
 * tokens.
 *
 * The nearest `[data-theme]` ancestor; without one, the topmost element of the
 * MFE's shadow root, which follows the theme through its host (#1075). `null`
 * until the node mounts, or outside any shadow root with no themed ancestor.
 */
export function useThemedRoot(): [HTMLElement | null, (node: HTMLElement | null) => void] {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    setRoot(node ? (node.closest<HTMLElement>('[data-theme]') ?? shadowTop(node)) : null);
  }, []);
  return [root, attach];
}
