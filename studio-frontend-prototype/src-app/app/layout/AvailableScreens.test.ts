import { describe, expect, it } from 'vitest';
import type { StudioScreenExtension } from '@/app/mfe/screenLevels';
import { availableScreens, shellTabs } from './AvailableScreens';

function screen(route: string, kit?: string, more: Record<string, unknown> = {}): StudioScreenExtension {
  return {
    id: `ext${route}`,
    domain: 'screen',
    entry: 'entry',
    presentation: { label: route, route, ...(kit ? { kit } : {}), ...more },
  } as unknown as StudioScreenExtension;
}

const screens = [
  screen('/organization/overview'),
  screen('/issues', 'project-issues'),
  screen('/releases', 'product-releases'),
];

describe('availableScreens', () => {
  it("lists the shell's screens and a kit's only where its kit is installed", () => {
    const { tabs: _tabs, ...rest } = availableScreens(screens, new Set(['project-issues']));
    expect(rest).toEqual({
      routes: ['/issues', '/organization/overview'],
      kits: ['project-issues'],
    });
  });

  it('hides nothing while the installed kits are unknown', () => {
    const { tabs: _tabs, ...rest } = availableScreens(screens, null);
    expect(rest).toEqual({
      routes: ['/issues', '/organization/overview', '/releases'],
      kits: null,
    });
  });

  it("lists every level's tabs, installed or not, for a kit's page", () => {
    const tabs = availableScreens(screens, new Set()).tabs ?? [];
    expect(tabs.map((tab) => tab.route).sort()).toEqual(['/issues', '/organization/overview', '/releases']);
    expect(tabs.find((tab) => tab.route === '/issues')).toMatchObject({ kit: 'project-issues', modelTab: 'issues' });
  });
});

describe('shellTabs', () => {
  it("orders by level, main before settings, then order; leaves out what is not a tab", () => {
    const tabs = shellTabs([
      screen('/projects/settings', undefined, { level: 'project', placement: 'settings', order: 1 }),
      screen('/tests', 'project-tests', { level: 'project', order: 40, icon: 'lucide:flask-conical' }),
      screen('/projects/overview', undefined, { level: 'project', order: 10 }),
      screen('/space', undefined, { level: 'project', placement: 'hidden' }),
      screen('/kits', undefined, { level: 'platform', order: 10 }),
    ]);
    expect(tabs.map((tab) => tab.route)).toEqual(['/kits', '/projects/overview', '/tests', '/projects/settings']);
    expect(tabs[2]).toEqual({
      level: 'project',
      route: '/tests',
      label: '/tests',
      icon: 'lucide:flask-conical',
      placement: 'main',
      order: 40,
      kit: 'project-tests',
      modelTab: 'tests',
      entry: 'entry',
    });
  });
});
