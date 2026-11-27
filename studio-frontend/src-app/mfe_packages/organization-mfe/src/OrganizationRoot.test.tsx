import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION,
  STUDIO_SHARED_PROPERTY_CONTEXT_SECTION,
  useOrganization,
} from '@constructor-studio/mfe-shared';

const { section } = vi.hoisted(() => ({ section: { value: 'tasks' as unknown } }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useSharedProperty: (id: string) => {
    if (id === STUDIO_SHARED_PROPERTY_CONTEXT_SECTION) return section.value;
    if (id === STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION) return { id: 'o1', name: 'Acme' };
    return undefined;
  },
}));

// Each screen says which organization it reads, and nothing else.
function Reads({ name }: { name: string }) {
  const { org } = useOrganization();
  return <p>{`${name}: ${org?.id ?? 'none'}`}</p>;
}
vi.mock('./screens/background/BackgroundScreen', () => ({ BackgroundScreen: () => <Reads name="background" /> }));
vi.mock('./screens/overview/OverviewScreen', () => ({ OverviewScreen: () => <Reads name="overview" /> }));
vi.mock('./screens/workspaces/WorkspacesScreen', () => ({ WorkspacesScreen: () => <Reads name="workspaces" /> }));
vi.mock('./screens/settings/SettingsScreen', () => ({ SettingsScreen: () => <Reads name="settings" /> }));
vi.mock('./screens/inbox/InboxScreen', () => ({ InboxScreen: () => <Reads name="inbox" /> }));

import { OrganizationRoot } from './OrganizationRoot';

describe('OrganizationRoot', () => {
  // Outside the provider Background work had no organization, so it listed no
  // run and no schedule (walk 2026-11-17).
  it('gives Background work the organization in view', () => {
    section.value = 'tasks';
    render(<OrganizationRoot bridge={{} as never} />);
    expect(screen.getByText('background: o1')).toBeTruthy();
  });

  it('gives the overview the organization in view', () => {
    section.value = 'overview';
    render(<OrganizationRoot bridge={{} as never} />);
    expect(screen.getByText('overview: o1')).toBeTruthy();
  });
});
