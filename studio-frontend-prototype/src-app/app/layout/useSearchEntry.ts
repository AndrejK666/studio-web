/**
 * Search, an overlay (search-mfe, `/search`), as the shell's chrome opens it:
 * the top bar's magnifier and the sidebar's Search row.
 */

import { useCallback, useRef } from 'react';
import { useFrontX, useDomainExtensions, overlayDomain, FRONTX_ACTION_MOUNT_EXT } from '@gears-frontx/react';
import { executeAndSettle } from '@/app/mfe/shellOutcomes';
import type { OverlayExtension } from './overlayExtension';

export const SEARCH_ROUTE = '/search';

export interface SearchEntry {
  /** The Search overlay, when one is registered. */
  extension: OverlayExtension | undefined;
  open: () => void;
}

export function useSearchEntry(): SearchEntry {
  const { mfeRegistry } = useFrontX();
  const overlayExtensions = useDomainExtensions(overlayDomain.id) as OverlayExtension[];
  const extension = overlayExtensions.find((ext) => ext.presentation?.route === SEARCH_ROUTE);
  const mounting = useRef(false);
  const extensionId = extension?.id;

  const open = useCallback(() => {
    if (!mfeRegistry || !extensionId || mounting.current) return;
    mounting.current = true;
    void executeAndSettle(mfeRegistry, {
      type: FRONTX_ACTION_MOUNT_EXT,
      target: overlayDomain.id,
      payload: { subject: extensionId },
    })
      .catch(() => undefined)
      .finally(() => {
        mounting.current = false;
      });
  }, [mfeRegistry, extensionId]);

  return { extension, open };
}
