/**
 * A stand-in for the domain data layer in a screen's tests, without a query
 * client or a network: `useDomainTypes` answers what the test set, and
 * `useDomainQuery` calls the test's `query` and calls it again after an
 * `invalidateDomainObjects`. Spread over the real module in `vi.mock`:
 *
 *     const { domain } = vi.hoisted(() => ({ domain: { stub: null as DomainStub | null } }));
 *     vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => {
 *       const { createDomainStub } = await import('@constructor-studio/mfe-shared/testing');
 *       domain.stub = createDomainStub();
 *       return { ...(await importOriginal()), ...domain.stub.hooks };
 *     });
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DomainQueryRequest, DomainQueryResult } from '../domain/domainQuery';

export interface DomainStub {
  /** What `/types` answers: a value, or an error. */
  types: unknown;
  /** What `/query` answers for a body. */
  query: (body: DomainQueryRequest) => Promise<unknown>;
  /** What `/mutate` answers for a body. */
  mutate: (body: unknown) => Promise<unknown>;
  /** The modules' members the stub replaces. */
  hooks: {
    useDomainTypes: (orgId: string | null | undefined) => {
      data: unknown;
      error: unknown;
      isError: boolean;
      isLoading: boolean;
      refetch: () => void;
    };
    useDomainQuery: (
      orgId: string | null | undefined,
      body: DomainQueryRequest | null
    ) => { data: DomainQueryResult | undefined; error: unknown; isError: boolean; isLoading: boolean; refetch: () => void };
    invalidateDomainObjects: () => void;
    invalidateDomainTypes: () => void;
    domainMutate: () => { fetch: (body: unknown) => Promise<unknown> };
  };
}

export function createDomainStub(): DomainStub {
  let version = 0;
  const listeners = new Set<() => void>();
  const bump = () => {
    version += 1;
    for (const l of [...listeners]) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  const stub: DomainStub = {
    types: undefined,
    query: () => Promise.resolve({ items: [], total: 0, complete: true }),
    mutate: () => Promise.resolve({ results: [] }),
    hooks: {
      useDomainTypes: (orgId) => {
        const v = stub.types;
        if (!orgId || v === undefined) return { data: undefined, error: null, isError: false, isLoading: !!orgId, refetch: bump };
        if (v instanceof Error) return { data: undefined, error: v, isError: true, isLoading: false, refetch: bump };
        return { data: v, error: null, isError: false, isLoading: false, refetch: bump };
      },
      useDomainQuery: (orgId, body) => {
        const seen = useSyncExternalStore(subscribe, () => version);
        const [state, setState] = useState<{ data?: DomainQueryResult; error: unknown }>({ error: null });
        const key = body ? JSON.stringify(body) : '';
        useEffect(() => {
          if (!orgId || !body) return undefined;
          let live = true;
          stub.query(body).then(
            (data) => live && setState({ data: data as DomainQueryResult, error: null }),
            (error: unknown) => live && setState({ error })
          );
          return () => {
            live = false;
          };
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [orgId, key, seen]);
        return {
          data: state.data,
          error: state.error,
          isError: state.error !== null,
          isLoading: !!body && state.data === undefined && state.error === null,
          refetch: bump,
        };
      },
      invalidateDomainObjects: bump,
      invalidateDomainTypes: bump,
      domainMutate: () => ({ fetch: (body: unknown) => stub.mutate(body) }),
    },
  };
  return stub;
}
