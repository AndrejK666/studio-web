import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { KIT_CONTENT_SLOT_EVENT, type KitContentSlotName } from '@constructor-studio/mfe-shared';
import { KitSlot } from '@/app/layout/KitSlot';
import { SHELL_SLOTS } from './slots';

const slots = {
  'project.overview.content': SHELL_SLOTS.projectOverviewContent,
  'organization.overview.content': SHELL_SLOTS.organizationOverviewContent,
  'organization.inbox.content': SHELL_SLOTS.organizationInboxContent,
} satisfies Record<KitContentSlotName, (typeof SHELL_SLOTS)[keyof typeof SHELL_SLOTS]>;

export function MfeContentSlots({ screens }: { screens: RefObject<HTMLDivElement | null> }) {
  const [anchors, setAnchors] = useState<Partial<Record<KitContentSlotName, HTMLElement>>>({});
  useEffect(() => {
    const root = screens.current;
    if (!root) return;
    const receive = (event: Event) => {
      const path = event.composedPath();
      const anchor = path[0];
      const detail = (event as CustomEvent<{ name: KitContentSlotName; attached: boolean }>).detail;
      if (!(anchor instanceof HTMLElement) || !detail || !Object.prototype.hasOwnProperty.call(slots, detail.name) ||
          anchor.dataset.kitContentAnchor !== detail.name ||
          path.some((node) => node instanceof HTMLElement && node.hasAttribute('data-kit-slot'))) return;
      const name = detail.name;
      setAnchors((current) => {
        if (detail.attached === true) return current[name] === anchor ? current : { ...current, [name]: anchor };
        if (current[name] !== anchor) return current;
        const next = { ...current };
        delete next[name];
        return next;
      });
    };
    root.addEventListener(KIT_CONTENT_SLOT_EVENT, receive);
    return () => root.removeEventListener(KIT_CONTENT_SLOT_EVENT, receive);
  }, [screens]);

  return Object.entries(anchors).map(([name, anchor]) => createPortal(
    <KitSlot slot={slots[name as KitContentSlotName]} direction="column" insideScreen />,
    anchor,
    name
  ));
}
