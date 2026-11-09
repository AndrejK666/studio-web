import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChildMfeBridge } from '@gears-frontx/react';
import manifest from '../mfe.json';

const { section } = vi.hoisted(() => ({ section: { value: undefined as unknown } }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useSharedProperty: () => section.value,
}));
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useHostChrome: () => ({ containerRef: { current: null }, dataTheme: 'light', language: 'en' }),
  OrganizationProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('./i18n', () => {
  const t = Object.assign((key: string) => key, { count: (key: string) => key });
  return { useAdminTranslations: () => ({ t, loading: false }) };
});
vi.mock('./screens/admin/OrganizationsSection', () => ({ OrganizationsSection: () => 'organizations' }));
vi.mock('./screens/admin/PeopleSection', () => ({ PeopleSection: () => 'people' }));
vi.mock('./screens/admin/AccessSection', () => ({ AccessSection: () => 'access' }));
vi.mock('./screens/admin/SecretsSection', () => ({ SecretsSection: () => 'secrets' }));
vi.mock('./screens/admin/ObjectsSection', () => ({ ObjectsSection: () => 'objects' }));
vi.mock('./screens/admin/IdentitiesSection', () => ({ IdentitiesSection: () => 'identities' }));
vi.mock('./screens/admin/TenantsSection', () => ({ TenantsSection: () => 'tenants' }));

import { ADMIN_SECTIONS, AdminRoot } from './AdminRoot';

const bridge = {} as ChildMfeBridge;

describe('AdminRoot', () => {
  it.each(ADMIN_SECTIONS)('shows the %s section the shell names', (name) => {
    section.value = name;
    render(<AdminRoot bridge={bridge} />);
    expect(screen.getByText(name)).toBeTruthy();
  });

  it('falls back to People, where the prototype opened Admin', () => {
    section.value = 'nonsense';
    render(<AdminRoot bridge={bridge} />);
    expect(screen.getByText('people')).toBeTruthy();
  });

  it('has one admin-level extension per section, in the prototype order, and no kit', () => {
    const shown = manifest.extensions.map((e) => e.presentation);
    expect(shown.map((p) => p.section)).toEqual([...ADMIN_SECTIONS]);
    expect(shown.every((p) => p.level === 'admin' && !('kit' in p))).toBe(true);
    const orders = shown.map((p) => p.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});
