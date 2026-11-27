/**
 * The MFEs' remembered UI choices (`/me/ui-preferences`, the keys under
 * `mfe.`): the shell publishes them and changes one when an MFE asks.
 *
 * The shell's preference store stays the record's only writer. It writes the
 * map whole, so an MFE writing the record itself would lose its key to the
 * shell's next save; asking the shell keeps one map in one place. An MFE may
 * not touch the shell's own keys (tab order, theme): only `mfe.` keys pass.
 */

import { ActionHandler, type FrontXApp } from '@gears-frontx/react';
import {
  MFE_PREFERENCE_KEY,
  MFE_PREFERENCE_MAX_LENGTH,
  STUDIO_SHARED_PROPERTY_UI_PREFERENCES,
} from '@constructor-studio/mfe-shared';
import { preferenceStore, type PreferenceStore, type Preferences } from '@/app/preferences/uiPreferences';

/** The `mfe.` part of the person's preferences: what the MFEs see. */
export function mfePreferences(prefs: Preferences): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(prefs)) {
    if (MFE_PREFERENCE_KEY.test(key)) out[key] = value;
  }
  return out;
}

/** The `{key, value}` an MFE asked to keep, or `null` when it may not. */
export function preferenceRequestOf(payload: Record<string, unknown> | undefined): { key: string; value: string } | null {
  const { key, value } = payload ?? {};
  if (typeof key !== 'string' || !MFE_PREFERENCE_KEY.test(key)) return null;
  if (typeof value !== 'string' || value.length > MFE_PREFERENCE_MAX_LENGTH) return null;
  return { key, value };
}

export function createPreferenceSetHandler(store: () => PreferenceStore = preferenceStore): ActionHandler {
  return ActionHandler.fromFunction(async (_actionTypeId, payload) => {
    const request = preferenceRequestOf(payload);
    if (!request) {
      console.warn('[shell] preference set: payload refused', payload);
      return;
    }
    store().set(request.key, request.value);
  });
}

/**
 * Publishes the MFEs' preferences now and whenever they change: from the
 * browser's cache at once, and from the record once the shell has read it.
 * It does not read the record itself: at bootstrap nobody is signed in yet,
 * and the shell's own screens (the tabs, the theme) start that read.
 * Returns the unsubscribe.
 */
export function publishMfePreferences(app: FrontXApp, store: PreferenceStore = preferenceStore()): () => void {
  let last = '';
  const publish = () => {
    const value = mfePreferences(store.get());
    const text = JSON.stringify(value);
    if (text === last) return;
    last = text;
    try {
      app.mfeRegistry?.updateSharedProperty(STUDIO_SHARED_PROPERTY_UI_PREFERENCES, value);
    } catch (error) {
      console.warn(
        `Failed to publish ${STUDIO_SHARED_PROPERTY_UI_PREFERENCES} to MFEs:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  };
  const unsubscribe = store.subscribe(publish);
  publish();
  return unsubscribe;
}
