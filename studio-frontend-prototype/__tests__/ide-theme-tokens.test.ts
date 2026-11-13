// @vitest-environment node

/**
 * The IDE's Studio themes are built from the portal's tokens (#1073). The
 * values reach the IDE through one generated file; these tests keep the
 * extraction honest and the committed file in step with the kit.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildIdeThemeTokens,
  currentIdeThemeTokens,
  extractKitPalettes,
  extractKitTypography,
  IDE_TOKENS_PATH,
  renderIdeThemeTokens,
} from '../scripts/lib/ide-theme-tokens';

const KIT_LIKE_CSS = `
/* commentary, with a { brace } in it */
:root {
  --radius: 0.625rem;
  --font-mono: 'JetBrains Mono', monospace;
  --text-body-size: 0.875rem;
  --text-label-size: 0.75rem;
}
:root,
[data-theme='light'] {
  --background: #f1f5f9; /* page */
  --primary: #0065e3;
  color-scheme: light;
}
[data-theme='dark'] {
  --background: #0f172a;
  --primary: #0065e3;
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --background: #000000;
  }
}
`;

describe('extractKitPalettes', () => {
  it('takes the light and dark blocks the shell selects by data-theme, not the OS fallback', () => {
    expect(extractKitPalettes(KIT_LIKE_CSS)).toEqual({
      light: { background: '#f1f5f9', primary: '#0065e3' },
      dark: { background: '#0f172a', primary: '#0065e3' },
    });
  });

  it('refuses a palette value the IDE could not paint', () => {
    const css = KIT_LIKE_CSS.replace('--primary: #0065e3;\n  color-scheme: light', '--primary: var(--blue);\n  color-scheme: light');
    expect(() => extractKitPalettes(css)).toThrow(/--primary in the light palette/);
  });

  it('fails loudly when a block is missing', () => {
    expect(() => extractKitPalettes(":root { --a: #ffffff; }")).toThrow(/no top-level rule/);
  });
});

describe('extractKitTypography', () => {
  it('reads the mono family and the body and label sizes from :root', () => {
    expect(extractKitTypography(KIT_LIKE_CSS)).toEqual({
      fontMono: "'JetBrains Mono', monospace",
      bodySize: '0.875rem',
      labelSize: '0.75rem',
    });
  });
});

describe('the committed IDE tokens', () => {
  it('match the installed kit and the shell themes (run `npm run generate:ide-theme` when this fails)', () => {
    expect(readFileSync(IDE_TOKENS_PATH, 'utf8')).toBe(currentIdeThemeTokens());
  });

  it('carry both palettes with the tokens the IDE themes map from', () => {
    const tokens = JSON.parse(currentIdeThemeTokens()) as ReturnType<typeof buildIdeThemeTokens>;
    for (const mode of ['light', 'dark'] as const) {
      for (const name of ['background', 'foreground', 'card', 'primary', 'border', 'ring', 'sidebar', 'selection-subtle']) {
        expect(tokens[mode][name], `${mode} ${name}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
    expect(tokens.typography.fontSans).toMatch(/^'Inter Variable'/);
  });

  it('renders stably', () => {
    const tokens = buildIdeThemeTokens({ themeCss: KIT_LIKE_CSS, kitVersion: '1.2.3', fontSans: 'Inter' });
    expect(renderIdeThemeTokens(tokens)).toBe(renderIdeThemeTokens(JSON.parse(renderIdeThemeTokens(tokens))));
    expect(renderIdeThemeTokens(tokens).endsWith('}\n')).toBe(true);
  });
});
