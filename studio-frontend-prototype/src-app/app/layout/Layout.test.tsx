import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { noOrganization } = vi.hoisted(() => ({ noOrganization: { value: false } }));

vi.mock('@/app/actions/bootstrapActions', () => ({
  fetchCurrentUser: vi.fn(),
  fetchAppContext: vi.fn(),
}));
vi.mock('./Header', () => ({ Header: () => <div data-testid="top-bar" /> }));
vi.mock('./LevelHeader', () => ({ LevelHeader: () => <div data-testid="level-header" /> }));
vi.mock('./LevelTabs', () => ({ LevelTabs: () => <div data-testid="level-tabs" /> }));
vi.mock('./Popup', () => ({ Popup: () => null }));
vi.mock('./Overlay', () => ({ Overlay: () => null }));
vi.mock('./OverlayDialog', () => ({ OverlayDialog: () => null }));
vi.mock('./OrganizationAccessGate', () => ({
  OrganizationAccessGate: () => <div data-testid="access-gate" />,
  useHasNoOrganization: () => noOrganization.value,
}));

import { Layout } from './Layout';

const renderLayout = () =>
  render(
    <Layout>
      <div data-testid="mounted-screen" />
    </Layout>
  );

describe('Layout', () => {
  afterEach(() => {
    cleanup();
    noOrganization.value = false;
  });

  it('draws the level header and its tabs between the top bar and the screen', () => {
    renderLayout();
    expect(screen.getByTestId('top-bar')).toBeTruthy();
    expect(screen.getByTestId('level-header')).toBeTruthy();
    expect(screen.getByTestId('level-tabs')).toBeTruthy();
    expect(screen.getByTestId('mounted-screen')).toBeTruthy();
  });

  // Onboarding: there is no level to name and no section to offer.
  it('draws neither for a person with no organization, who gets the gate instead', () => {
    noOrganization.value = true;
    renderLayout();
    expect(screen.getByTestId('top-bar')).toBeTruthy();
    expect(screen.queryByTestId('level-header')).toBeNull();
    expect(screen.queryByTestId('level-tabs')).toBeNull();
    expect(screen.queryByTestId('mounted-screen')).toBeNull();
    expect(screen.getByTestId('access-gate')).toBeTruthy();
  });
});
