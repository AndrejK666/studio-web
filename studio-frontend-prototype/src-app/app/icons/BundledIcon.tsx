/**
 * A glyph where the shell must draw one (the header's pills): the bundled icon
 * `declared` names, or a neutral placeholder — never a request for it.
 */

import React from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { FALLBACK_ICON, bundledIcon } from './bundledIcons';

export interface BundledIconProps {
  /** What the manifest declares, e.g. `lucide:search`. */
  declared: string | undefined;
  className?: string;
}

/**
 * One of the module-level glyphs of `BUNDLED_ICONS`, drawn by element rather
 * than JSX: the component is picked, never created, during render.
 */
export function drawGlyph(glyph: LucideIcon, declared: string | undefined, className?: string): React.ReactElement {
  const props: LucideProps & { 'data-icon'?: string } = { className, 'aria-hidden': true, 'data-icon': declared };
  return React.createElement(glyph, props);
}

export const BundledIcon: React.FC<BundledIconProps> = ({ declared, className }) =>
  drawGlyph(bundledIcon(declared) ?? FALLBACK_ICON, declared, className);

BundledIcon.displayName = 'BundledIcon';
