import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUNDLED_ICONS, FALLBACK_ICON, bundledIcon, lucideNameOf } from './bundledIcons';

const here = path.dirname(fileURLToPath(import.meta.url));
const MFE_PACKAGES = path.resolve(here, '../../mfe_packages');

interface Declared {
  file: string;
  icon: unknown;
}

/** Every `presentation.icon` the built-in screens' `mfe.json` files declare. */
function declaredIcons(): Declared[] {
  const found: Declared[] = [];
  for (const dir of readdirSync(MFE_PACKAGES)) {
    const file = path.join(MFE_PACKAGES, dir, 'mfe.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
      extensions?: Array<{ presentation?: { icon?: unknown } }>;
    };
    for (const extension of manifest.extensions ?? []) {
      const icon = extension.presentation?.icon;
      if (icon !== undefined) found.push({ file: `${dir}/mfe.json`, icon });
    }
  }
  return found;
}

describe('bundled icons', () => {
  it('bundles every icon a built-in mfe.json names, so none is fetched', () => {
    const declared = declaredIcons();
    expect(declared.length).toBeGreaterThan(20);
    const missing = declared
      .filter(({ icon }) => typeof icon !== 'string' || bundledIcon(icon) === undefined)
      .map(({ file, icon }) => `${file}: ${String(icon)}`);
    // An icon named here must be `lucide:<name>` and in BUNDLED_ICONS
    // (icons/bundledIcons.ts): add it there, or pick one that is.
    expect(missing).toEqual([]);
  });

  it('reads a lucide name, and nothing else', () => {
    expect(lucideNameOf('lucide:users')).toBe('users');
    expect(lucideNameOf('lucide:')).toBeUndefined();
    expect(lucideNameOf('material-symbols:search')).toBeUndefined();
    expect(lucideNameOf(undefined)).toBeUndefined();
  });

  it('answers only for names it bundles', () => {
    expect(bundledIcon('lucide:search')).toBe(BUNDLED_ICONS.search);
    expect(bundledIcon('lucide:constructor')).toBeUndefined();
    expect(bundledIcon('lucide:toString')).toBeUndefined();
    expect(bundledIcon('material-symbols:search')).toBeUndefined();
    expect(FALLBACK_ICON).toBeDefined();
  });
});
