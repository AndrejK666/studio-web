/**
 * A tab's or a menu item's icon, as its manifest names it (`lucide:<name>`).
 *
 * A name the shell bundles (`icons/bundledIcons.ts`: every built-in screen's,
 * and the built-in kit catalogue's) draws at once, with no request. Any other
 * lucide name — a kit installed at run time may name one — goes through
 * `lucide-react/dynamic`, loaded on first use: its name map (every lucide icon,
 * each behind its own `import()`) was a quarter of a megabyte of the host's
 * entry chunk before minification. Both are our own origin; nothing is asked of
 * an icon service.
 */

import React, { Suspense } from 'react';
import { bundledIcon } from '@/app/icons/bundledIcons';
import { drawGlyph } from '@/app/icons/BundledIcon';
import { levelIconName } from './levelIcon';

export interface ManifestIconProps {
  /** What the manifest declares, e.g. `lucide:users`. */
  declared: string | undefined;
  /** Where a kit's own SVG icon is served (#1081); drawn instead of `declared`. */
  url?: string;
  className?: string;
}

const LucideByName = React.lazy(async () => {
  const { DynamicIcon, iconNames } = await import('lucide-react/dynamic');
  const ByName: React.FC<ManifestIconProps> = ({ declared, className }) => {
    const name = levelIconName(declared, iconNames);
    return name ? <DynamicIcon name={name} className={className} aria-hidden="true" /> : null;
  };
  return { default: ByName };
});

export const ManifestIcon: React.FC<ManifestIconProps> = ({ declared, url, className }) => {
  // A kit's SVG, served through the kit bundle route: an image, never inline markup.
  if (url) return <img src={url} alt="" aria-hidden="true" className={className} data-kit-icon-url />;
  // Not a lucide name: nothing to load, nothing to draw.
  if (!declared?.startsWith('lucide:')) return null;
  const bundled = bundledIcon(declared);
  if (bundled) return drawGlyph(bundled, declared, className);
  return (
    <Suspense fallback={null}>
      <LucideByName declared={declared} className={className} />
    </Suspense>
  );
};

ManifestIcon.displayName = 'ManifestIcon';
