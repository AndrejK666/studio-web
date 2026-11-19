// @vitest-environment node
// (esbuild, which minifies the theme below as a build does, refuses jsdom's TextEncoder.)
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { anchorKitThemeOnShadowHost } from './anchorKitThemeOnShadowHost';

/** The kit's theme as the lifecycles inline it; vitest empties a CSS import, so read from disk. */
const kitTheme = readFileSync(createRequire(import.meta.url).resolve('@gears-frontx/ui-kit/theme.css'), 'utf8');

describe('anchorKitThemeOnShadowHost', () => {
  it('re-anchors a bare :root block on :host', () => {
    const css = ':root {\n  --background: #fff;\n}';
    expect(anchorKitThemeOnShadowHost(css)).toBe(':host {\n  --background: #fff;\n}');
  });

  it('re-anchors every :root in a selector list', () => {
    const css = ":root,[data-theme='light'] { --x: 1; }";
    expect(anchorKitThemeOnShadowHost(css)).toBe(
      ":host,:host([data-kit-theme='light']),[data-theme='light'] { --x: 1; }"
    );
  });

  it('handles minified single-line CSS with multiple :root rules', () => {
    const css = ":root{--a:1}:root:not([data-theme='light']){--a:2}[data-theme='dark']{--a:3}";
    expect(anchorKitThemeOnShadowHost(css)).toBe(
      ":host{--a:1}:host:not([data-theme='light']){--a:2}:host([data-kit-theme='dark']),[data-theme='dark']{--a:3}"
    );
  });

  it('strips comments so :root inside a comment produces no phantom rule', () => {
    const css = '/* :root is documented here */ :root { --x: 1; }';
    expect(anchorKitThemeOnShadowHost(css)).toBe(' :host { --x: 1; }');
  });

  // #1075: the host carries the portal's palette, so a screen root without
  // `data-theme` still reads dark on a dark page.
  it('lets the palette blocks match a host carrying data-kit-theme', () => {
    const css = "[data-theme='light'] { --b: #fff; }\n[data-theme=\"dark\"],.x { --b: #000; }";
    expect(anchorKitThemeOnShadowHost(css)).toBe(
      ":host([data-kit-theme='light']),[data-theme='light'] { --b: #fff; }\n" +
        ":host([data-kit-theme='dark']),[data-theme=\"dark\"],.x { --b: #000; }"
    );
  });

  it('leaves the paint rule, :not() guards and descendant selectors on data-theme alone', () => {
    const css = "[data-theme] { color: red; } [data-theme='dark'] .y { --c: 1; } :not([data-theme='light']) { --d: 1; }";
    expect(anchorKitThemeOnShadowHost(css)).toBe(css);
  });

  it("reaches the kit's own light and dark palettes", () => {
    const anchored = anchorKitThemeOnShadowHost(kitTheme);
    expect(anchored).toContain(":host([data-kit-theme='light']),[data-theme='light']");
    expect(anchored).toContain(":host([data-kit-theme='dark']),[data-theme='dark']");
    expect(anchored).not.toMatch(/:root\b/);
  });

  // A production build inlines the theme minified, and the minifier drops the
  // attribute's quotes: the first cut of #1075 matched only quoted ones and
  // left the host light in the build while the test above passed.
  it("reaches the palettes of the kit's theme as a build minifies it", () => {
    const minified = transformSync(kitTheme, { loader: 'css', minify: true }).code;
    const anchored = anchorKitThemeOnShadowHost(minified);
    expect(anchored).toMatch(/:host\(\[data-kit-theme='light'\]\),\[data-theme=["']?light["']?\]/);
    expect(anchored).toMatch(/:host\(\[data-kit-theme='dark'\]\),\[data-theme=["']?dark["']?\]/);
  });

  it('does not touch selectors that merely contain the word root', () => {
    const css = '.root { --x: 1; } #root { --y: 2; }';
    expect(anchorKitThemeOnShadowHost(css)).toBe('.root { --x: 1; } #root { --y: 2; }');
  });
});
