import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRegistry } from '@gears-frontx/react';
import { ProductApiService, orgScoped } from './ProductApiService';
import { api, forgetGearConfigSchemas, productApiFor } from './client';

/** The path in a read's cache key (`[baseURL, method, path, ...]`). */
const pathOf = (key: readonly unknown[]): string =>
  String(key.find((part) => typeof part === 'string' && part.startsWith('/studio-')));

describe('the routes that name the organization on screen', () => {
  it('name the one they are given, once, and none when there is none', () => {
    expect(orgScoped('/studio-product/v1/gearbox/catalogue', 'o 1')).toBe(
      '/studio-product/v1/gearbox/catalogue?organization_id=o%201'
    );
    expect(orgScoped('/studio-spec-mapping/v1/plan?project_id=p1', 'o1')).toBe(
      '/studio-spec-mapping/v1/plan?project_id=p1&organization_id=o1'
    );
    expect(orgScoped('/studio-product/v1/assembly-strategy?organization_id=a', 'b')).toBe(
      '/studio-product/v1/assembly-strategy?organization_id=a'
    );
    expect(orgScoped('/studio-product/v1/gearbox/catalogue', null)).toBe('/studio-product/v1/gearbox/catalogue');
    // Not one of the organization's routes: the caller's tenant answers.
    expect(orgScoped('/studio-environments/v1/targets?project_id=p1', 'o1')).toBe(
      '/studio-environments/v1/targets?project_id=p1'
    );
  });

  it('take the organization from each read, so one organization never reads under another', () => {
    const svc = new ProductApiService();
    const first = svc.projectProduct({ projectId: 'p1', org: 'o1' });
    const second = svc.projectProduct({ projectId: 'p1', org: 'o2' });
    expect(pathOf(first.key)).toBe('/studio-product/v1/projects/p1/product?organization_id=o1');
    expect(pathOf(second.key)).toBe('/studio-product/v1/projects/p1/product?organization_id=o2');
    // A read made for the first organization still names it after the second was asked for.
    expect(pathOf(svc.projectProduct({ projectId: 'p1', org: 'o1' }).key)).toBe(pathOf(first.key));
    expect(pathOf(svc.gearboxCatalogue({ org: 'o2' }).key)).toBe('/studio-product/v1/gearbox/catalogue?organization_id=o2');
  });
});

describe('productApiFor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    forgetGearConfigSchemas();
  });

  it('binds the organization it was made for to every call', async () => {
    const read = vi.spyOn(api, 'projectProduct').mockResolvedValue(null);
    const one = productApiFor('o1');
    const two = productApiFor('o2');
    await two.projectProduct('p1');
    await one.projectProduct('p1');
    expect(read.mock.calls).toEqual([
      ['o2', 'p1'],
      ['o1', 'p1'],
    ]);
  });

  it("never serves one organization's kept gear schemas to another", async () => {
    const asked: (string | null)[] = [];
    const service = {
      gearConfigSchemas: (org: string | null) => ({
        fetch: async () => {
          asked.push(org);
          return { items: [], total: 0 };
        },
      }),
    };
    vi.spyOn(apiRegistry, 'getService').mockReturnValue(service as never);
    await productApiFor('o1').gearConfigSchemas(['a', 'b']);
    await productApiFor('o1').gearConfigSchemas(['b', 'a']);
    await productApiFor('o2').gearConfigSchemas(['a', 'b']);
    expect(asked).toEqual(['o1', 'o2']);
  });
});
