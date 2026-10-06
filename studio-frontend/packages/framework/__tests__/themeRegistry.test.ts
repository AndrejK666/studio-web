/**
 * The kit's theme.css picks its palette by `data-theme` on <html>, and the
 * active theme's own tokens must outrank it (ADR-0034).
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createThemeRegistry } from '../src/registries/themeRegistry';

function insertedSelector(): string | undefined {
  const style = document.getElementById('frontx-theme-vars') as HTMLStyleElement | null;
  return (style?.sheet?.cssRules[0] as CSSStyleRule | undefined)?.selectorText;
}

describe('themeRegistry.apply', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('frontx-theme-vars')?.remove();
  });

  it('sets data-theme from the appearance, and resets it on switching back', () => {
    const registry = createThemeRegistry();
    registry.register({ id: 'night', name: 'Night', appearance: 'dark', variables: { '--x': '1' } });
    registry.register({ id: 'day', name: 'Day', appearance: 'light', variables: { '--x': '2' } });

    registry.apply('night');
    expect(document.documentElement.dataset.theme).toBe('dark');

    registry.apply('day');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('treats a theme without an appearance as light', () => {
    const registry = createThemeRegistry();
    registry.register({ id: 'plain', name: 'Plain', variables: { '--x': '1' } });

    registry.apply('plain');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('writes the tokens as :root:root, so they outrank the kit\'s [data-theme] rules', () => {
    const registry = createThemeRegistry();
    registry.register({ id: 'night', name: 'Night', appearance: 'dark', variables: { '--x': '1' } });

    registry.apply('night');
    expect(insertedSelector()).toBe(':root:root');
  });
});
