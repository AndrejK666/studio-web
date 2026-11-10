/** React's side of the shell's live channel. */

import { useEffect, useRef } from 'react';
import type { StudioEvent } from '@constructor-studio/mfe-shared';
import { liveChannel } from './liveChannel';

/** Keeps the channel open while the calling component (the signed-in Layout) is mounted. */
export function useLiveChannelOpen(): void {
  useEffect(() => liveChannel()?.start(), []);
}

/** Hears every new event the channel delivers while the caller is mounted. */
export function useStudioEvents(listener: (event: StudioEvent) => void): void {
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => liveChannel()?.subscribe((event) => latest.current(event)), []);
}
