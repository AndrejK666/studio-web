import { describe, expect, it } from 'vitest';
import { PageCursors, domainObjectsKey, domainTypesPath, invalidateDomainObjects, invalidateDomainTypes } from './domain';
import { gatewayKey, withQuery } from './gateway';

describe('the domain model as cached data', () => {
  it('reads the model by one gateway path per organization, the dormant types apart', () => {
    expect(domainTypesPath('o1')).toBe('/studio-domain-model/v1/types?organization_id=o1');
    expect(domainTypesPath('o1', { dormant: true })).toBe('/studio-domain-model/v1/types?organization_id=o1&include=dormant');
    expect(gatewayKey(domainTypesPath('o1'))).toEqual(['/cf', 'GET', '/studio-domain-model/v1/types?organization_id=o1']);
  });

  it('marks both reads of the model stale', () => {
    const keys: unknown[] = [];
    invalidateDomainTypes({ invalidate: (k) => keys.push(k) }, 'o1');
    expect(keys).toEqual([
      ['/cf', 'GET', '/studio-domain-model/v1/types?organization_id=o1'],
      ['/cf', 'GET', '/studio-domain-model/v1/types?organization_id=o1&include=dormant'],
    ]);
  });

  it('keys a query by organization and type, so a type’s queries are invalidated together', () => {
    expect(domainObjectsKey('o1', 'milestone')).toEqual(['/cf', 'POST', '/studio-domain-model/v1/query', 'o1', 'milestone']);
    const filters: unknown[] = [];
    invalidateDomainObjects({ invalidateMany: (f) => filters.push(f) }, 'o1', 'milestone');
    expect(filters).toEqual([{ queryKey: ['/cf', 'POST', '/studio-domain-model/v1/query', 'o1', 'milestone'] }]);
  });

  it('writes a query string without the empty values', () => {
    expect(withQuery('/x', { a: 'b', c: undefined, d: '', e: 0 })).toBe('/x?a=b&e=0');
    expect(withQuery('/x?y=1', { a: 'b' })).toBe('/x?y=1&a=b');
  });
});

describe('PageCursors', () => {
  it('asks a page that follows one already read by its cursor, a jump by offset', () => {
    const cursors = new PageCursors<{ type: string; offset?: number; limit?: number; cursor?: string }>();
    const first = { type: 'milestone', offset: 0, limit: 50 };
    expect(cursors.place(first)).toEqual(first);
    cursors.note(first, 50, 'c50');
    expect(cursors.place({ type: 'milestone', offset: 50, limit: 50 })).toEqual({ type: 'milestone', limit: 50, cursor: 'c50' });
    expect(cursors.place({ type: 'milestone', offset: 100, limit: 50 })).toEqual({ type: 'milestone', offset: 100, limit: 50 });
    expect(cursors.place({ type: 'other', offset: 50, limit: 50 })).toEqual({ type: 'other', offset: 50, limit: 50 });
  });
});
