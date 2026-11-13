/**
 * One of the person's remembered UI choices, kept for an MFE in their
 * `/me/ui-preferences` record (the Kits screen's table or tiles).
 *
 * The shell's preference store is that record's only writer: it writes the
 * map whole, so an MFE that wrote the record itself would lose its key to the
 * shell's next save, or overwrite the shell's keys with a stale read. So the
 * MFE reads its keys from a shared property the shell publishes and asks the
 * shell to change one. An MFE's keys live under `mfe.`; the shell refuses any
 * other.
 *
 * Declare both in the entry's `mfe.json`: the property in
 * `requiredProperties`, the action in `domainActions`.
 */

import { useCallback, useContext, useState } from 'react';
import { FRONTX_SCREEN_DOMAIN, MfeContext, useSharedProperty, type ChildMfeBridge } from '@gears-frontx/react';
import { sendToHost } from './hostActions';

/** The person's `mfe.` preferences, as a map of strings, kept current by the shell. */
export const STUDIO_SHARED_PROPERTY_UI_PREFERENCES =
  'gts.frontx.mfes.comm.shared_property.v1~constructor_studio.session.ui.preferences.v1~';

/** Screen domain: remember `{key, value}` for the person; `''` forgets it. */
export const STUDIO_ACTION_PREFERENCE_SET =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.shell.preference.set.v1~';

/** The keys an MFE may keep: `mfe.` and a short dotted name. */
export const MFE_PREFERENCE_KEY = /^mfe\.[a-z0-9][a-z0-9._-]{0,59}$/;

/** The longest value kept. */
export const MFE_PREFERENCE_MAX_LENGTH = 256;

/**
 * The remembered value of `key` (one of `MFE_PREFERENCE_KEY`) and how to
 * change it. `''` while nothing is remembered or the shell has not published
 * the map yet. A change shows at once and reaches the record through the shell.
 */
export function useHostPreference(
  key: string,
  options: { bridge?: ChildMfeBridge } = {}
): [string, (value: string) => void] {
  // The bridge given, else the provider's: as `useSharedProperty` picks it.
  const fromContext = useContext(MfeContext)?.bridge ?? null;
  const bridge = options.bridge ?? fromContext;
  const published = useSharedProperty<unknown>(STUDIO_SHARED_PROPERTY_UI_PREFERENCES, options);
  const stored =
    published && typeof published === 'object' && typeof (published as Record<string, unknown>)[key] === 'string'
      ? ((published as Record<string, string>)[key] ?? '')
      : '';
  // What this screen chose, until the shell publishes it back.
  const [chosen, setChosen] = useState<string | null>(null);
  const set = useCallback(
    (value: string) => {
      if (!MFE_PREFERENCE_KEY.test(key) || value.length > MFE_PREFERENCE_MAX_LENGTH) return;
      setChosen(value);
      sendToHost(bridge, { type: STUDIO_ACTION_PREFERENCE_SET, target: FRONTX_SCREEN_DOMAIN, payload: { key, value } });
    },
    [bridge, key]
  );
  return [chosen ?? stored, set];
}
