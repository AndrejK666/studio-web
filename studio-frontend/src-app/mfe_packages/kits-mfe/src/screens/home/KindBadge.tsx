/**
 * A kit's type (the server's `kind`), as a short label whose tooltip says what the tier is and
 * every tier the kit brings: `runtime` (its own code runs in Studio), `gears` (built on Studio's
 * gears), `model` (types and rules only), `material` (files for a checkout only).
 */

import React from 'react';
import { Badge } from '@gears-frontx/ui-kit';
import type { CatalogKit, KitKind } from '../../api/KitsApiService';
import type { Text } from './kit/text';

const VARIANT: Record<KitKind, 'info' | 'secondary' | 'outline'> = {
  runtime: 'info',
  gears: 'secondary',
  model: 'outline',
  material: 'outline',
};

/** The tooltip: what the kit's type means, and the other tiers it brings. */
export function kindHint(kit: Pick<CatalogKit, 'kind' | 'brings'>, t: Text): string {
  if (!kit.kind) return '';
  const others = (kit.brings ?? []).filter((b) => b !== kit.kind).map((b) => t(`kind_${b}`));
  const hint = t(`kind_${kit.kind}_hint`);
  return others.length > 0 ? `${hint} ${t('kind_also', { list: others.join(', ') })}` : hint;
}

export const KindBadge: React.FC<{ kit: Pick<CatalogKit, 'kind' | 'brings'>; t: Text }> = ({ kit, t }) => {
  if (!kit.kind) return null;
  return (
    <span title={kindHint(kit, t)} data-kit-kind={kit.kind}>
      <Badge variant={VARIANT[kit.kind] ?? 'outline'}>{t(`kind_${kit.kind}`)}</Badge>
    </span>
  );
};
