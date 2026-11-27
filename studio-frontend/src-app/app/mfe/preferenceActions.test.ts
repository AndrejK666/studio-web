import { describe, expect, it, vi } from 'vitest';
import type { FrontXApp } from '@gears-frontx/react';
import { STUDIO_SHARED_PROPERTY_UI_PREFERENCES } from '@constructor-studio/mfe-shared';
import { createPreferenceStore } from '@/app/preferences/uiPreferences';
import {
  createPreferenceSetHandler,
  mfePreferences,
  preferenceRequestOf,
  publishMfePreferences,
} from './preferenceActions';

function memoryStorage(initial: Record<string, string> = {}) {
  let raw = JSON.stringify(initial);
  return {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
  };
}

const client = () => ({ read: vi.fn(async () => ({})), save: vi.fn(async () => undefined) });

describe("the MFEs' preferences (#1081)", () => {
  it("are the keys under `mfe.` only, never the shell's own", () => {
    expect(mfePreferences({ 'mfe.kits.view': 'tiles', 'app.theme': 'dark', 'tabs.project': 'a,b' })).toEqual({
      'mfe.kits.view': 'tiles',
    });
  });

  it('take a request for an `mfe.` key and refuse the rest', () => {
    expect(preferenceRequestOf({ key: 'mfe.kits.view', value: 'tiles' })).toEqual({ key: 'mfe.kits.view', value: 'tiles' });
    expect(preferenceRequestOf({ key: 'app.theme', value: 'dark' })).toBeNull();
    expect(preferenceRequestOf({ key: 'mfe.kits.view', value: 3 })).toBeNull();
    expect(preferenceRequestOf({ key: 'mfe.kits.view', value: 'x'.repeat(257) })).toBeNull();
    expect(preferenceRequestOf(undefined)).toBeNull();
  });

  it('are written through the shell store, and published to the MFEs as they change', async () => {
    const store = createPreferenceStore(client(), { storage: memoryStorage({ 'app.theme': 'dark' }), debounceMs: 0 });
    const updateSharedProperty = vi.fn();
    const app = { mfeRegistry: { updateSharedProperty } } as unknown as FrontXApp;
    const stop = publishMfePreferences(app, store);
    expect(updateSharedProperty).toHaveBeenLastCalledWith(STUDIO_SHARED_PROPERTY_UI_PREFERENCES, {});

    const handler = createPreferenceSetHandler(() => store);
    await handler.handleAction('preference.set', { key: 'mfe.kits.view', value: 'tiles' });
    expect(store.get()['mfe.kits.view']).toBe('tiles');
    expect(store.get()['app.theme']).toBe('dark');
    expect(updateSharedProperty).toHaveBeenLastCalledWith(STUDIO_SHARED_PROPERTY_UI_PREFERENCES, {
      'mfe.kits.view': 'tiles',
    });

    // A refused request changes nothing.
    await handler.handleAction('preference.set', { key: 'app.theme', value: 'light' });
    expect(store.get()['app.theme']).toBe('dark');
    stop();
  });
});
