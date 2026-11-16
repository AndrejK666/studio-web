/**
 * What a component IS, in the one word a person reads first, and its icon —
 * the same on every screen that lists components (Organization and Platform
 * › Components, the project's Components tab).
 *
 * The word is the catalogue's (`studio-components-catalog`, its
 * `component_detail::component_type`): `GET /components` lays it on each
 * node as `component_type`, and `GET /components/{name}` answers it with the
 * evidence. Nothing here guesses it: a value the catalogue did not send is
 * `other`, and a registry entry's kind maps word for word.
 */

import React from 'react';
import { AppWindow, Cog, Container, Library, Package, Plug, Server, Shapes, type LucideIcon } from 'lucide-react';

export type ComponentType = 'gear' | 'plugin' | 'mfe' | 'service' | 'infra' | 'library' | 'kit' | 'other';

/** Every type, in the order a filter offers them. */
export const COMPONENT_TYPES: readonly ComponentType[] = ['gear', 'plugin', 'mfe', 'service', 'infra', 'library', 'kit', 'other'];

export function isComponentType(value: unknown): value is ComponentType {
  return typeof value === 'string' && (COMPONENT_TYPES as readonly string[]).includes(value);
}

/** The type the catalogue laid on a node (`component_type`), or `other` when it sent none. */
export function catalogueComponentType(value: Record<string, unknown> | null | undefined): ComponentType {
  const t = value?.component_type;
  return isComponentType(t) ? t : 'other';
}

/** A registry entry's kind (`gear`, `plugin`, `kit`, `frontx`) as a type; a
 *  FrontX package the registry alone knows is not known to be a screen. */
export function registryComponentType(kind: string | null | undefined): ComponentType {
  return kind === 'gear' || kind === 'plugin' || kind === 'kit' ? kind : 'other';
}

const ICONS: Record<ComponentType, LucideIcon> = {
  gear: Cog,
  plugin: Plug,
  mfe: AppWindow,
  service: Server,
  infra: Container,
  library: Library,
  kit: Package,
  other: Shapes,
};

/** The type's glyph; decorative, so the label beside it says the word. */
export const ComponentTypeIcon: React.FC<{ type: ComponentType; className?: string; size?: number }> = ({
  type,
  className,
  size = 16,
}) => {
  const Icon = ICONS[type] ?? Shapes;
  return (
    <span className={className} data-component-type-icon={type} aria-hidden="true" style={{ display: 'inline-flex', flex: 'none' }}>
      <Icon size={size} />
    </span>
  );
};

ComponentTypeIcon.displayName = 'ComponentTypeIcon';
