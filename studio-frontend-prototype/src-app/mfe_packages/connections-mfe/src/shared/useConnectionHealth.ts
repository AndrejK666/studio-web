// @cpt-dod:cpt-studiofrontend-dod-connection-list-health:p1
// @cpt-algo:cpt-studiofrontend-algo-connection-list-health:p2
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRegistry } from '@gears-frontx/react';
import {
  ConnectorsApiService,
  refusalText,
  violationOfType,
  type Violation,
} from '@constructor-studio/mfe-shared';
import type { ConnectionHealth } from '../model/connection';

/** Long enough that a re-render is free; short enough that a fix shows up. */
const HEALTH_STALE_TIME = 5 * 60 * 1000;

const CREDENTIAL_UNUSABLE = 'CONNECTOR_CREDENTIAL_UNUSABLE';

export interface ConnectionHealthView {
  health: ConnectionHealth | null;
  reason: string | null;
  loading: boolean;
  failed: boolean;
}

function reasonFor(error: unknown, refusal: Violation): string | null {
  const described = refusal.description;
  if (typeof described === 'string' && described.trim()) return described;
  return refusalText(error);
}

/**
 * The last settled answer per connection, kept in localStorage for HEALTH_STALE_TIME: a test of a GitHub connection is
 * a live call that spends the token's rate limit, and the query cache alone is gone with every page load, so each
 * visit tested every connection again (walk 2026-11-16).
 */
const HEALTH_STORE_KEY = 'studio.connections.health.v1';

type StoredHealth = { health: ConnectionHealth; reason: string | null; at: number };

function storedHealth(key: string, now: number): StoredHealth | null {
  try {
    const raw = window.localStorage.getItem(HEALTH_STORE_KEY);
    const entry = raw ? (JSON.parse(raw) as Record<string, StoredHealth>)[key] : undefined;
    return entry && typeof entry.at === 'number' && now - entry.at < HEALTH_STALE_TIME ? entry : null;
  } catch {
    return null;
  }
}

function storeHealth(key: string, entry: StoredHealth): void {
  try {
    const raw = window.localStorage.getItem(HEALTH_STORE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, StoredHealth>) : {};
    // Expired entries go on every write, so the record never grows past the live connections.
    const kept = Object.fromEntries(Object.entries(all).filter(([, e]) => entry.at - e.at < HEALTH_STALE_TIME));
    window.localStorage.setItem(HEALTH_STORE_KEY, JSON.stringify({ ...kept, [key]: entry }));
  } catch {
    // A private window or blocked storage: the answer lasts this page load only.
  }
}

export function useConnectionHealth(
  connectionId: string,
  tenantId: string
): ConnectionHealthView {
  const connectors = apiRegistry.getService(ConnectorsApiService);
  const storeKey = `${tenantId}/${connectionId}`;
  // Read once per mount: a stored answer is as good as the query's own cache until it is stale.
  const [stored] = useState(() => storedHealth(storeKey, Date.now()));

  // @cpt-begin:cpt-studiofrontend-algo-connection-list-health:p2:inst-1
  // @cpt-begin:cpt-studiofrontend-algo-connection-list-health:p2:inst-2
  const { isPending, isError, error, data } = useQuery({
    queryKey: ['studio-connector', 'connection-health', tenantId, connectionId],
    queryFn: ({ signal }) =>
      connectors.connectionTest({ connectionId, tenantId }).fetch(undefined, { signal }),
    enabled: Boolean(tenantId && connectionId) && stored === null,
    retry: false,
    staleTime: HEALTH_STALE_TIME,
    gcTime: HEALTH_STALE_TIME,
    refetchOnWindowFocus: false,
  });
  // @cpt-end:cpt-studiofrontend-algo-connection-list-health:p2:inst-1
  // @cpt-end:cpt-studiofrontend-algo-connection-list-health:p2:inst-2

  const unusable = isError ? violationOfType(error, CREDENTIAL_UNUSABLE) : null;
  const settled: StoredHealth | null = unusable
    ? { health: 'unusable', reason: reasonFor(error, unusable), at: 0 }
    : !isError && data !== undefined
      ? { health: 'healthy', reason: null, at: 0 }
      : null;
  useEffect(() => {
    if (settled) storeHealth(storeKey, { ...settled, at: Date.now() });
    // Once per answer: `settled` is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey, settled?.health, settled?.reason]);

  if (stored) return { health: stored.health, reason: stored.reason, loading: false, failed: false };

  // @cpt-begin:cpt-studiofrontend-algo-connection-list-health:p2:inst-3
  // @cpt-begin:cpt-studiofrontend-algo-connection-list-health:p2:inst-4
  if (isPending) return { health: null, reason: null, loading: true, failed: false };
  // @cpt-end:cpt-studiofrontend-algo-connection-list-health:p2:inst-3
  // @cpt-end:cpt-studiofrontend-algo-connection-list-health:p2:inst-4

  if (isError) {
    const refusal = violationOfType(error, CREDENTIAL_UNUSABLE);

    // @cpt-begin:cpt-studiofrontend-algo-connection-list-health:p2:inst-5
    // @cpt-begin:cpt-studiofrontend-algo-connection-list-health:p2:inst-6
    if (!refusal) return { health: null, reason: null, loading: false, failed: true };
    // @cpt-end:cpt-studiofrontend-algo-connection-list-health:p2:inst-5
    // @cpt-end:cpt-studiofrontend-algo-connection-list-health:p2:inst-6

    // @cpt-begin:cpt-studiofrontend-algo-connection-list-health:p2:inst-7
    // @cpt-begin:cpt-studiofrontend-algo-connection-list-health:p2:inst-8
    return {
      health: 'unusable',
      reason: reasonFor(error, refusal),
      loading: false,
      failed: false,
    };
    // @cpt-end:cpt-studiofrontend-algo-connection-list-health:p2:inst-7
    // @cpt-end:cpt-studiofrontend-algo-connection-list-health:p2:inst-8
  }

  // @cpt-begin:cpt-studiofrontend-algo-connection-list-health:p2:inst-9
  return { health: 'healthy', reason: null, loading: false, failed: false };
  // @cpt-end:cpt-studiofrontend-algo-connection-list-health:p2:inst-9
}
