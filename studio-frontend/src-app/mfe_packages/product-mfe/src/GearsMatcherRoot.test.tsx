import { describe, expect, it } from 'vitest';
import { matcherViewOf } from './GearsMatcherRoot';

describe('GearsMatcherRoot', () => {
  it('switches on the section the shell publishes', () => {
    expect(matcherViewOf(undefined, 'gear-match')).toBe('gear-match');
    expect(matcherViewOf(undefined, 'gears-matcher')).toBe('gears-matcher');
  });

  it('falls back on the extension id where no section is published', () => {
    expect(matcherViewOf('gts…~constructor_studio.product.screens.gears_matcher.v1', null)).toBe('gears-matcher');
    expect(matcherViewOf('gts…~constructor_studio.product.screens.gear_match.v1', null)).toBe('gear-match');
    expect(matcherViewOf(undefined, undefined)).toBe('gear-match');
  });
});
