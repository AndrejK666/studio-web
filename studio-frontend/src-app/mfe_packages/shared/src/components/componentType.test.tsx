import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  COMPONENT_TYPES,
  ComponentTypeIcon,
  catalogueComponentType,
  isComponentType,
  registryComponentType,
} from './componentType';

describe('component types', () => {
  it('reads the type the catalogue laid on a node, and nothing else', () => {
    expect(catalogueComponentType({ component_type: 'infra' })).toBe('infra');
    expect(catalogueComponentType({ component_type: 'micro-frontend' })).toBe('other');
    expect(catalogueComponentType({ kind: 'gear' })).toBe('other');
    expect(catalogueComponentType(null)).toBe('other');
  });

  it('maps a registry kind word for word', () => {
    expect(registryComponentType('gear')).toBe('gear');
    expect(registryComponentType('plugin')).toBe('plugin');
    expect(registryComponentType('kit')).toBe('kit');
    expect(registryComponentType('frontx')).toBe('other');
    expect(registryComponentType(undefined)).toBe('other');
  });

  it('draws a distinct glyph for every type', () => {
    expect(COMPONENT_TYPES.every(isComponentType)).toBe(true);
    const svgs = COMPONENT_TYPES.map((type) => {
      const { container } = render(<ComponentTypeIcon type={type} />);
      const host = container.querySelector(`[data-component-type-icon="${type}"]`);
      expect(host?.getAttribute('aria-hidden')).toBe('true');
      return host?.querySelector('svg')?.innerHTML ?? '';
    });
    expect(new Set(svgs).size).toBe(COMPONENT_TYPES.length);
  });
});
