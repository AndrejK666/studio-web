import { describe, expect, it, vi } from 'vitest';
import { installWithRequired, missingKits } from './requires';

const requires = (...missing: string[]) => ({
  response: {
    data: {
      detail: 'Operation precondition not met',
      context: {
        violations: missing.map((m) => ({ type: 'KIT_REQUIRES_KIT', subject: m, description: `requires ${m}` })),
      },
    },
  },
});

describe('missingKits', () => {
  it('names the kits a KIT_REQUIRES_KIT refusal lists', () => {
    expect(missingKits(requires('project-product', 'delivery'))).toEqual(['project-product', 'delivery']);
  });
  it('is empty for any other refusal', () => {
    expect(missingKits(new Error('boom'))).toEqual([]);
  });
});

describe('installWithRequired', () => {
  it('installs what the kit requires first, then the kit', async () => {
    const installed = new Set<string>();
    const needs: Record<string, string[]> = { 'gears-project': ['project-product', 'delivery'] };
    const install = vi.fn(async (slug: string) => {
      const missing = (needs[slug] ?? []).filter((n) => !installed.has(n));
      if (missing.length) throw requires(...missing);
      installed.add(slug);
    });
    await expect(installWithRequired('gears-project', install)).resolves.toEqual([
      'project-product',
      'delivery',
      'gears-project',
    ]);
  });

  it('throws other refusals as they came', async () => {
    const refusal = new Error('forbidden');
    await expect(installWithRequired('x', () => Promise.reject(refusal))).rejects.toBe(refusal);
  });

  it('stops at a cycle', async () => {
    const install = vi.fn(async (slug: string) => {
      throw requires(slug === 'a' ? 'b' : 'a');
    });
    await expect(installWithRequired('a', install)).rejects.toBeTruthy();
  });
});
