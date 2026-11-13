/**
 * The portal's palette, handed to the IDE (#1073).
 *
 * The portal embeds the IDE (Theia) in an iframe. The portal draws with the
 * kit's tokens (`@gears-frontx/ui-kit/theme.css`, ADR-0034); the IDE draws
 * with Theia colour themes. For the two to read as one product, the IDE's
 * Studio themes are built from the same token values. They cannot read the
 * kit's CSS at run time — the IDE is another document, another build, another
 * image — so this module extracts the values once and the generator writes
 * them where the IDE extension reads them:
 * `theia/studio/src/browser/theme/portal-tokens.json`.
 *
 * One source, generated: the kit's `theme.css` and the shell themes'
 * `--font-sans` are the inputs, the JSON is the output, and
 * `__tests__/ide-theme-tokens.test.ts` fails when the committed JSON no longer
 * matches them (a kit bump, a theme edit), naming the command that fixes it.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTheme } from '../../src-app/app/themes/default';

/** A palette: token name without the leading `--`, to its value. */
export type TokenMap = Record<string, string>;

export interface IdeThemeTokens {
  '//': string;
  source: { package: string; version: string };
  typography: {
    /** The shell themes' `--font-sans` (the kit's says 'Inter'; the shell registers 'Inter Variable'). */
    fontSans: string;
    fontMono: string;
    /** `--text-body-size`: the base size of the portal's running text. */
    bodySize: string;
    /** `--text-label-size`: tabs, captions, the small chrome text. */
    labelSize: string;
  };
  light: TokenMap;
  dark: TokenMap;
}

export const KIT_PACKAGE = '@gears-frontx/ui-kit';

export const GENERATED_NOTE =
  'Generated from @gears-frontx/ui-kit/theme.css and the portal shell themes by ' +
  'studio-frontend-prototype/scripts/generate-ide-theme-tokens.ts. Do not edit by hand: ' +
  'run `npm run generate:ide-theme` in studio-frontend-prototype.';

/** Strip `/* … *\/` comments; the kit's file is mostly commentary. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The declarations of the first top-level rule whose selector list is exactly
 * `selector` (whitespace-insensitive). Top-level only: the OS-dark fallback
 * inside `@media` repeats the dark palette and is not what a theme selects.
 */
function ruleBody(css: string, selector: string): string {
  const want = selector.replace(/\s+/g, '');
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        const head = css.slice(start, i).replace(/\s+/g, '');
        if (head === want) {
          const end = css.indexOf('}', i);
          if (end < 0) break;
          return css.slice(i + 1, end);
        }
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) start = i + 1;
    }
  }
  throw new Error(`theme.css has no top-level rule for ${selector}`);
}

/** `--name: value;` pairs of a rule body, in source order. */
function declarations(body: string): TokenMap {
  const out: TokenMap = {};
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

/**
 * The light and dark palettes the kit selects by `data-theme`, as the shell
 * stamps it on `<html>` (ADR-0034). Only literal colours are kept: every
 * palette entry is a hex today, and a value the IDE cannot parse as a colour
 * must fail here rather than paint nothing there.
 */
export function extractKitPalettes(themeCss: string): { light: TokenMap; dark: TokenMap } {
  const css = stripComments(themeCss);
  const light = declarations(ruleBody(css, ":root, [data-theme='light']"));
  const dark = declarations(ruleBody(css, "[data-theme='dark']"));
  for (const [mode, palette] of [['light', light], ['dark', dark]] as const) {
    if (Object.keys(palette).length === 0) {
      throw new Error(`theme.css: the ${mode} palette is empty`);
    }
    for (const [name, value] of Object.entries(palette)) {
      if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) {
        throw new Error(`theme.css: --${name} in the ${mode} palette is not a #rrggbb colour: ${value}`);
      }
    }
  }
  return { light, dark };
}

/** The type tokens the IDE's chrome takes from the kit's mode-independent `:root` block. */
export function extractKitTypography(themeCss: string): { fontMono: string; bodySize: string; labelSize: string } {
  const root = declarations(ruleBody(stripComments(themeCss), ':root'));
  const pick = (name: string): string => {
    const value = root[name];
    if (!value) throw new Error(`theme.css: :root has no --${name}`);
    return value;
  };
  return { fontMono: pick('font-mono'), bodySize: pick('text-body-size'), labelSize: pick('text-label-size') };
}

export interface IdeThemeInputs {
  themeCss: string;
  kitVersion: string;
  /** The shell's `--font-sans`: the one type token the shell restates over the kit's. */
  fontSans: string;
}

export function buildIdeThemeTokens({ themeCss, kitVersion, fontSans }: IdeThemeInputs): IdeThemeTokens {
  const { light, dark } = extractKitPalettes(themeCss);
  return {
    '//': GENERATED_NOTE,
    source: { package: KIT_PACKAGE, version: kitVersion },
    typography: { fontSans, ...extractKitTypography(themeCss) },
    light,
    dark,
  };
}

/** The file's exact text: stable key order, two-space indent, trailing newline. */
export function renderIdeThemeTokens(tokens: IdeThemeTokens): string {
  return `${JSON.stringify(tokens, null, 2)}\n`;
}

/** Where the IDE extension reads the tokens. */
export const IDE_TOKENS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../theia/studio/src/browser/theme/portal-tokens.json'
);

/** The file's text as the installed kit and the shell themes make it now. */
export function currentIdeThemeTokens(): string {
  const require = createRequire(import.meta.url);
  const themeCss = readFileSync(require.resolve(`${KIT_PACKAGE}/theme.css`), 'utf8');
  const kitVersion = (require(`${KIT_PACKAGE}/package.json`) as { version: string }).version;
  const fontSans = defaultTheme.variables['--font-sans'];
  if (!fontSans) throw new Error('the default shell theme has no --font-sans');
  return renderIdeThemeTokens(buildIdeThemeTokens({ themeCss, kitVersion, fontSans }));
}
