import { describe, expect, it } from 'vitest';
import { KIT_ALIASES, kitIn, resolveKit } from './kitAliases';
import { kitAvailable } from './screens';

describe('kit slug aliases (ADR-0071 §8)', () => {
  it("are the backend's table; step 7 (#1089) removes them one release after the merge", () => {
    // The same list as studio-backend `kit_registry/aliases.rs` (its test
    // `the_aliases_are_the_adr_s_and_each_says_when_it_goes`): change both.
    expect(KIT_ALIASES).toEqual({
      'project-issues': ['project-domain-model', 'project-git'],
      'project-activity': ['project-git', 'project-lifecycle'],
      'product-releases': ['project-product', 'delivery'],
      'org-infrastructure': ['delivery'],
    });
  });

  it('resolves a retired slug and leaves a current one alone', () => {
    expect(resolveKit('org-infrastructure')).toEqual(['delivery']);
    expect(resolveKit('delivery')).toBeNull();
    expect(resolveKit('toString')).toBeNull();
  });

  it('counts a retired slug where everything it resolves to is installed', () => {
    const installed = new Set(['project-product', 'delivery', 'project-git']);
    expect(kitIn(installed, 'product-releases')).toBe(true);
    expect(kitIn(installed, 'org-infrastructure')).toBe(true);
    // project-lifecycle is not installed.
    expect(kitIn(installed, 'project-activity')).toBe(false);
    expect(kitIn(installed, 'project-tests')).toBe(false);
    expect(kitAvailable({ routes: [], kits: [...installed] }, 'product-releases')).toBe(true);
    expect(kitAvailable({ routes: [], kits: [...installed] }, 'project-activity')).toBe(false);
  });
});
