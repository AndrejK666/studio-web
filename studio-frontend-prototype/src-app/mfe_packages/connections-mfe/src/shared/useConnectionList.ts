// @cpt-algo:cpt-studiofrontend-algo-connection-list-read:p2
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRegistry, useApiQuery } from '@gears-frontx/react';
import { type ConnectionDto, ConnectorsApiService, type OrganizationRef, useOrganization } from '@constructor-studio/mfe-shared';

export interface ConnectionRow {
  /** The connection's id: the grid's row key. */
  id: string;
  connection: ConnectionDto;
  providerName: string;
}

export interface ConnectionListView {
  /** Every connection of the organization: the grid searches and pages them. */
  rows: ConnectionRow[];
  loading: boolean;
  failed: boolean;
  org: OrganizationRef | null;
  /** Reads the connections again, after a failed read. */
  retry: () => void;
}

// @cpt-begin:cpt-studiofrontend-algo-connection-list-read:p2:inst-4
/**
 * What the grid's search matches, case-insensitively, as a substring: the
 * name, the account (what tells two GitHub rows apart), and the provider by
 * its wire key and by its display name.
 */
export function connectionSearchTexts(row: ConnectionRow): string[] {
  const { label, account, provider } = row.connection;
  return [label, account, provider, row.providerName];
}
// @cpt-end:cpt-studiofrontend-algo-connection-list-read:p2:inst-4

export function useConnectionList(): ConnectionListView {
  const connectors = apiRegistry.getService(ConnectorsApiService);
  const { org, loading: orgLoading } = useOrganization();

  // @cpt-begin:cpt-studiofrontend-algo-connection-list-read:p2:inst-2
  const { data: providerData, isLoading: providersLoading } = useApiQuery(connectors.providers);
  // @cpt-end:cpt-studiofrontend-algo-connection-list-read:p2:inst-2

  // @cpt-begin:cpt-studiofrontend-algo-connection-list-read:p2:inst-1
  const listing = connectors.connections({ tenantId: org?.id ?? '' });
  const {
    data: connectionData,
    isLoading: connectionsLoading,
    isError: connectionsFailed,
    refetch,
  } = useQuery({
    queryKey: listing.key,
    queryFn: ({ signal }) => listing.fetch({ signal }),
    enabled: Boolean(org?.id),
  });
  // @cpt-end:cpt-studiofrontend-algo-connection-list-read:p2:inst-1

  const rows = useMemo<ConnectionRow[]>(() => {
    const names = new Map(
      (providerData?.items ?? []).map((provider) => [provider.provider, provider.display_name])
    );
    return (connectionData?.items ?? []).map((connection) => ({
      id: connection.id,
      connection,
      // @cpt-begin:cpt-studiofrontend-algo-connection-list-read:p2:inst-3
      providerName: names.get(connection.provider) ?? connection.provider,
      // @cpt-end:cpt-studiofrontend-algo-connection-list-read:p2:inst-3
    }));
  }, [providerData, connectionData]);

  // @cpt-begin:cpt-studiofrontend-algo-connection-list-read:p2:inst-6
  return {
    rows,
    loading: orgLoading || providersLoading || connectionsLoading,
    failed: connectionsFailed,
    org,
    retry: () => void refetch(),
  };
  // @cpt-end:cpt-studiofrontend-algo-connection-list-read:p2:inst-6
}
