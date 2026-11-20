import { useLayoutEffect, useRef } from 'react';

/** Named, single-outlet placements owned by the host. */
export type KitContentSlotName = 'project.overview.content' | 'organization.overview.content' | 'organization.inbox.content';

export const KIT_CONTENT_SLOT_EVENT = 'studio:kit-content-slot';

/** An anchor inside a screen's shadow root. The host owns the contributions. */
export function KitContentSlot({ name }: { name: KitContentSlotName }) {
  const anchor = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = anchor.current;
    if (!node) return;
    const signal = (attached: boolean) => node.dispatchEvent(new CustomEvent(KIT_CONTENT_SLOT_EVENT, {
      bubbles: true,
      composed: true,
      detail: { name, attached },
    }));
    signal(true);
    return () => { signal(false); };
  }, [name]);
  return <div ref={anchor} data-kit-content-anchor={name} style={{ display: 'contents' }} />;
}
