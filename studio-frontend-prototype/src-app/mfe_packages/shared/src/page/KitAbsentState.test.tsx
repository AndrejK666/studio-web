import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { available, sent } = vi.hoisted(() => ({ available: { value: null as unknown }, sent: [] as unknown[] }));

vi.mock('@gears-frontx/react', async (importOriginal) => {
  const en = (await import('./i18n/en.json')).default as Record<string, string>;
  const fill = (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(p?.[k] ?? `{${k}}`));
  return {
    ...(await importOriginal<typeof import('@gears-frontx/react')>()),
    useMfeBridge: () => ({ executeActionsChain: (chain: unknown) => sent.push(chain) }),
    useSharedProperty: (id: string) => (id.includes('screens.available') ? available.value : null),
    useScreenTranslations: () => ({ isLoaded: true }),
    useTranslation: () => ({
      language: 'en',
      t: (key: string, p?: Record<string, unknown>) => {
        const own = key.replace(/^screen\.shared\.kit-absent:/, '');
        return own in en ? fill(en[own], p) : key;
      },
    }),
  };
});

import { KitAbsentState, kitDisplayName } from './KitAbsentState';

afterEach(cleanup);
beforeEach(() => {
  available.value = null;
  sent.length = 0;
});

describe('KitAbsentState', () => {
  it('names the kit and offers Kits while the shell has not said otherwise', () => {
    render(<KitAbsentState absence={{ kit: 'project-git', reason: 'not_installed', detail: null }} />);
    expect(screen.getByText('Project git is not installed here')).toBeTruthy();
    fireEvent.click(screen.getByText('Open Kits'));
    expect(JSON.stringify(sent)).toContain('/project-kits');
  });

  it("prefers the gear's own sentence and the caller's name", () => {
    render(
      <KitAbsentState
        absence={{ kit: 'delivery', reason: 'not_installed', detail: 'An administrator installs it under Kits.' }}
        name="Delivery"
        level="organization"
      />
    );
    expect(screen.getByText('Delivery is not installed here')).toBeTruthy();
    expect(screen.getByText('An administrator installs it under Kits.')).toBeTruthy();
  });

  it('offers no link where the viewer has no Kits screen', () => {
    available.value = { routes: ['/tests'], kits: [] };
    render(<KitAbsentState absence="components" />);
    expect(screen.queryByText('Open Kits')).toBeNull();
    expect(document.querySelector('[data-kit-absent="components"]')).toBeTruthy();
  });

  it('says the service does not run for a gear that is absent', () => {
    render(<KitAbsentState absence={{ kit: 'insight', reason: 'gear_absent', detail: null }} canInstall={false} />);
    expect(screen.getByText(/whose service does not run/)).toBeTruthy();
  });

  it('makes a slug readable', () => {
    expect(kitDisplayName('org-costs')).toBe('Org costs');
  });
});
