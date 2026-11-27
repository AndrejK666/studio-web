import { describe, expect, it } from 'vitest';
import { type ConnectionDto } from '@constructor-studio/mfe-shared';
import { TEXT_SEARCH_FILTER_KEY, shownRows } from '@constructor-studio/mfe-shared/grid';
import { CONNECTION_GRID_OPTIONS } from '../screens/connection-list/components/ConnectionsGrid';
import { type ConnectionRow } from './useConnectionList';

/**
 * The search is the only logic around the list worth isolating: the two reads
 * are query calls with nothing of ours in them, and the matching rule is what
 * a member notices when it is wrong. It runs as the grid runs it.
 */
function row(over: Partial<ConnectionDto>, providerName = 'GitHub'): ConnectionRow {
  const connection: ConnectionDto = {
    id: 'c-1',
    owner_tenant_id: 'org-1',
    provider: 'gh',
    label: 'Platform GitHub',
    account: 'constructorfabric',
    base_url: 'https://api.github.com',
    scope: 'organization',
    secret_ref: 'ref',
    created_at_epoch_secs: 1_700_000_000,
    ...over,
  };
  return { id: connection.id, connection, providerName };
}

const matches = (candidate: ConnectionRow, query: string): boolean =>
  shownRows([candidate], { filters: { [TEXT_SEARCH_FILTER_KEY]: { value: query } } } as never, CONNECTION_GRID_OPTIONS)
    .length === 1;

describe('the connections search', () => {
  it('keeps every row when nothing is typed', () => {
    expect(matches(row({}), '   ')).toBe(true);
  });

  it('matches the connection name, whatever the case', () => {
    expect(matches(row({}), 'PLATFORM')).toBe(true);
  });

  it('matches the account, which is what tells two GitHub rows apart', () => {
    expect(matches(row({ label: 'A' }), 'constructorfabric')).toBe(true);
  });

  it('matches the provider by its display name', () => {
    expect(matches(row({ label: 'A', account: 'b' }), 'hub')).toBe(true);
  });

  it('matches the provider by its wire key', () => {
    expect(matches(row({ label: 'A', account: 'b' }), 'gh')).toBe(true);
  });

  it('drops a row nothing in it matches', () => {
    expect(matches(row({}), 'gitlab')).toBe(false);
  });
});
