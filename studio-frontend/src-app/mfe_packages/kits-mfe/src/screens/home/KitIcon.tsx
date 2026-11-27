/**
 * A kit's icon (#1081): the SVG its bundle carries, served through the kit
 * bundle route, or a lucide glyph by name (`lucide:<name>`), as a screen's
 * `mfe.json` names one. A kit that names none, or a name lucide does not have,
 * shows the generic package glyph, so every row and tile keeps its shape.
 *
 * lucide's name map is loaded on first use, as the shell's `ManifestIcon`
 * does: it is a quarter of a megabyte the list does not need to paint.
 */

import React, { Suspense } from 'react';
import { Package } from 'lucide-react';
import type { CatalogKit } from '../../api/KitsApiService';
import styles from './HomeScreen.module.css';

const LUCIDE_PREFIX = 'lucide:';

/** The lucide name `icon` declares, or `null` when it declares none. */
export function lucideName(icon: string | null | undefined): string | null {
  return icon?.startsWith(LUCIDE_PREFIX) ? icon.slice(LUCIDE_PREFIX.length) || null : null;
}

const LucideByName = React.lazy(async () => {
  const { DynamicIcon, iconNames } = await import('lucide-react/dynamic');
  const ByName: React.FC<{ name: string }> = ({ name }) => {
    const known = (iconNames as readonly string[]).includes(name);
    return known ? (
      <DynamicIcon name={name as (typeof iconNames)[number]} aria-hidden="true" />
    ) : (
      <Package aria-hidden="true" />
    );
  };
  return { default: ByName };
});

export const KitIcon: React.FC<{ kit: Pick<CatalogKit, 'icon' | 'icon_url'> }> = ({ kit }) => {
  const name = lucideName(kit.icon);
  return (
    <span className={styles.kitIcon} data-kit-icon={kit.icon ?? ''} aria-hidden="true">
      {kit.icon_url ? (
        <img src={kit.icon_url} alt="" />
      ) : name ? (
        <Suspense fallback={<Package />}>
          <LucideByName name={name} />
        </Suspense>
      ) : (
        <Package />
      )}
    </span>
  );
};

KitIcon.displayName = 'KitIcon';
