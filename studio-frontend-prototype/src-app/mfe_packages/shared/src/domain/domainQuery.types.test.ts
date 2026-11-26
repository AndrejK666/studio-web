/**
 * The query client typed by the generated model: what compiles and what does
 * not. The assertions are the type checker's (`tsc` over `src`, and vitest's
 * transform for the runtime half): a `@ts-expect-error` that stops failing
 * fails the type check.
 */

import { describe, expect, it } from 'vitest';
import { domainQuery, fetchDomainAll } from '../data/domain';
import type { DomainQueryOf, DomainQueryRequest, DomainResultOf, DomainRowOf } from './domainQuery';

/** `true` only when `A` and `B` are the same type. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(): T => true as T;

describe('the query client typed by the generated model', () => {
  it('checks a known type’s fields, order and relations', () => {
    const ok: DomainQueryOf<'milestone'> = {
      type: 'milestone',
      fields: ['name', 'id'],
      order_by: [{ field: 'name', direction: 'desc' }],
    };
    expect(ok.type).toBe('milestone');

    // @ts-expect-error `nickname` is not a field of `milestone`.
    const wrongField: DomainQueryOf<'milestone'> = { type: 'milestone', fields: ['nickname'] };
    // @ts-expect-error nor can a query order by it.
    const wrongOrder: DomainQueryOf<'milestone'> = { type: 'milestone', order_by: [{ field: 'nickname' }] };
    expect([wrongField, wrongOrder]).toHaveLength(2);

    const team: DomainQueryOf<'team'> = {
      type: 'team',
      include: {
        has_members: { fields: ['display_name'] },
        // Backwards and qualified names are the gear's to check.
        '~delivers': {},
        'team.delivers': { fields: ['anything'] },
      },
    };
    expect(Object.keys(team.include ?? {})).toHaveLength(3);
    // @ts-expect-error a relation's selection is checked against its target, `person`.
    const wrongInclude: DomainQueryOf<'team'> = { type: 'team', include: { has_members: { fields: ['nickname'] } } };
    expect(wrongInclude.type).toBe('team');
  });

  it('infers the type from the body, and reads rows as it', () => {
    const descriptor = domainQuery('o1', { type: 'milestone', fields: ['name'] });
    type Rows = Awaited<ReturnType<typeof descriptor.fetch>>['items'];
    is<Equal<Rows[number]['value']['name'], string | undefined>>();
    expect(descriptor.key).toContain('milestone');

    // @ts-expect-error inferred from `type`, `nickname` is refused here too.
    domainQuery('o1', { type: 'milestone', fields: ['nickname'] });
    // A literal fed to `fetchDomainAll` is checked the same way.
    const read = () =>
      // @ts-expect-error
      fetchDomainAll('o1', { type: 'risk', order_by: [{ field: 'nickname' }] });
    expect(typeof read).toBe('function');
  });

  it('reads a type the generated model does not have untyped, and the plain shapes stay', () => {
    const kit: DomainQueryOf<'deals-project'> = { type: 'deals-project', fields: ['deal_size'] };
    const row = {} as DomainRowOf<'deals-project'>;
    is<Equal<typeof row.value, Record<string, unknown>>>();
    const plain: DomainQueryRequest = kit;
    const fromPlain = domainQuery('o1', plain);
    type Plain = Awaited<ReturnType<typeof fromPlain.fetch>>;
    is<Equal<Plain['items'][number]['value'], Record<string, unknown>>>();
    const typed: DomainResultOf<'milestone'> = { items: [], total: 0, complete: true };
    expect([plain.type, typed.total]).toEqual(['deals-project', 0]);
  });
});
