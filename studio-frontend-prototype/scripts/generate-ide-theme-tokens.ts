/**
 * Writes the portal's palette where the IDE reads it (#1073):
 * `theia/studio/src/browser/theme/portal-tokens.json`.
 *
 *   npm run generate:ide-theme            write the file
 *   npm run generate:ide-theme -- --check fail if the committed file is stale
 *
 * Inputs: the installed `@gears-frontx/ui-kit/theme.css` and the shell
 * themes' `--font-sans`. See scripts/lib/ide-theme-tokens.ts.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { currentIdeThemeTokens, IDE_TOKENS_PATH } from './lib/ide-theme-tokens';

const wanted = currentIdeThemeTokens();
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(IDE_TOKENS_PATH, 'utf8');
  } catch {
    // missing counts as stale
  }
  if (current !== wanted) {
    console.error(`${path.relative(process.cwd(), IDE_TOKENS_PATH)} is stale: run npm run generate:ide-theme`);
    process.exit(1);
  }
  console.log('IDE theme tokens are current.');
} else {
  writeFileSync(IDE_TOKENS_PATH, wanted);
  console.log(`wrote ${path.relative(process.cwd(), IDE_TOKENS_PATH)}`);
}
