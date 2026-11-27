/** The narrow layout's breakpoint: the shell draws the sidebar as a drawer below it. */

import { useEffect, useState } from 'react';

/** Below this width the sidebar is a drawer, and the path's submenus open below their row. */
export const NARROW_VIEWPORT_PX = 900;

/** Whether the window is narrower than `NARROW_VIEWPORT_PX`. */
export function useNarrowViewport(): boolean {
  const query = `(max-width: ${NARROW_VIEWPORT_PX - 0.02}px)`;
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const onChange = () => setNarrow(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}
