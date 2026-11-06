import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgOverview } from '../../overview/types';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../i18n', () => ({
  useOverviewTranslations: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    loading: false,
  }),
}));
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useOrganization: () => ({ org: { id: 'o1', name: 'Acme' }, loading: false, failed: false }),
}));
vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => ({ overview: () => ({}) }) },
  useApiQuery: query,
  useSharedProperty: () => 'en',
  useMfeBridge: () => null,
}));

import { OverviewScreen } from './OverviewScreen';

const overview: OrgOverview = {
  organization_id: 'o1',
  name: 'Acme',
  period_from: '',
  period_to: '',
  previous_from: '',
  previous_to: '',
  stuck_days: 7,
  growth_alert: 0.2,
  quiet_days: 14,
  costs: 'shown',
  needs: [{ kind: 'connection', tone: 'danger', provider: 'github', status: '401', projects: ['app'] }],
  spend: { currency: 'USD', current: 120, previous: 100, forecast: 180, own_keys: 0, attributed: 0, unattributed: 0, sessions: 0, unpriced: [] },
  delivery: { merged: 12, window_days: 30, open: 4, median_wait_days: 2 },
  specs: { specs: 10, failing: 1, open_findings: 5 },
  people: { active: 6, with_spend: 3, per_person: 20, idle: [] },
  workspaces: [
    { id: 'w1', name: 'Main', spend: null, previous: null, specs_failing: 0, stuck: 0, quiet_days: 1, score: 0, projects: [] },
  ],
  money: null,
  waiting_on: null,
  decisions: null,
};

describe('OverviewScreen', () => {
  beforeEach(() => query.mockReturnValue({ data: overview, isLoading: false, isError: false, error: null }));

  it('names the refused connection, the figures and the workspaces', () => {
    render(<OverviewScreen />);
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText('A github connection is refused (401)')).toBeTruthy();
    expect(screen.getByText(/"merged":"12"/)).toBeTruthy();
    expect(screen.getByText('Main')).toBeTruthy();
    expect(screen.getByText('1 thing needs attention')).toBeTruthy();
    // A refused connection is fixed on Connections, which this portal has.
    expect(screen.getByRole('button', { name: 'Fix the connection' })).toBeTruthy();
  });

  it('says when the overview cannot be read', () => {
    query.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('403') });
    render(<OverviewScreen />);
    expect(screen.getByText('unreadable')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
