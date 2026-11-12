import { useCallback, useState } from 'react';

/**
 * The themed root (the nearest `[data-theme]` ancestor) of the node the ref is
 * put on: the container a popup portals into. A popup that portals out of the
 * MFE's shadow root, or out of its themed root, paints with the document's
 * theme or with none; hand it this node as `container` (`portalContainer` on a
 * `DataGrid`) and it takes the screen's tokens.
 *
 * `null` until the node mounts, or when no ancestor carries `data-theme`: the
 * MFE's root is missing `useHostChrome`'s `dataTheme` (#1075).
 */
export function useThemedRoot(): [HTMLElement | null, (node: HTMLElement | null) => void] {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    setRoot(node?.closest<HTMLElement>('[data-theme]') ?? null);
  }, []);
  return [root, attach];
}
