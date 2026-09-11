/**
 * Where the top bar's organization list comes from.
 *
 * The rule under test: membership decides which organizations an ordinary person
 * may act in (ADR-0011 §2), while the home tenant on the token decides only
 * whether the caller is the platform administrator. Getting this wrong is
 * expensive in both directions — read the home tenant as membership and everyone
 * gains access to the whole tree, read the platform root's own membership as an
 * organization and every administrator loses their list — so both paths are
 * pinned here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FrontXApp } from '@gears-frontx/react';
import { PLATFORM_ROOT_TENANT_ID, TENANT_TYPES } from '@/app/api';
import { setContextAccess, setContextOrganizations } from '@/app/slices/appContextSlice';

type BusHandler = (payload?: unknown) => void | Promise<void>;

const { listeners, mockHas, mockGetService } = vi.hoisted(() => ({
  listeners: new Map<string, ((payload?: unknown) => void | Promise<void>)[]>(),
  mockHas: vi.fn(),
  mockGetService: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: {
    on: vi.fn((eventName: string, handler: BusHandler) => {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), handler]);
      return () => listeners.delete(eventName);
    }),
    emit: vi.fn(),
  },
  apiRegistry: {
    has: mockHas,
    getService: mockGetService,
  },
}));

vi.mock('@/app/mfe/sharedContext', () => ({
  publishSelectedOrganization: vi.fn(),
  publishSelectedProject: vi.fn(),
  publishSelectedWorkspace: vi.fn(),
}));

import { AccountsApiService, IdentityApiService } from '@/app/api';
import { registerAppContextEffects } from './appContextEffects';

async function emit(eventName: string, payload?: unknown): Promise<void> {
  await Promise.all((listeners.get(eventName) ?? []).map((h) => h(payload)));
}

const ORG_A = '00000000-0000-0000-0000-0000000000a1';
const ORG_B = '00000000-0000-0000-0000-0000000000b2';

function tenant(id: string, name: string, type: string = TENANT_TYPES.organization) {
  return { id, name, tenant_type: type };
}

/** `query(...)` / `queryWith(...)` endpoints both end in `.fetch()`. */
function endpoint<T>(value: T) {
  return { fetch: vi.fn().mockResolvedValue(value) };
}

describe('the organization list', () => {
  const dispatch = vi.fn();
  const app = {
    store: { dispatch, getState: () => ({}) },
  } as unknown as FrontXApp;

  /** Wire the two services the handler reaches for. */
  function services(options: {
    homeTenantId?: string;
    memberships?: { org_id: string; role: string }[];
    tenants?: Record<string, ReturnType<typeof tenant>>;
    children?: ReturnType<typeof tenant>[];
  }) {
    const accounts = {
      me: endpoint({ subject_id: 'who', subject_tenant_id: options.homeTenantId }),
      tenant: vi.fn(({ tenantId }: { tenantId: string }) => {
        const found = options.tenants?.[tenantId];
        return found
          ? endpoint(found)
          : { fetch: vi.fn().mockRejectedValue(new Error('404')) };
      }),
      tenantChildren: vi.fn(() => endpoint({ items: options.children ?? [] })),
      tenantChildrenOfType: vi.fn(() => endpoint({ items: [] })),
    };
    const identity = {
      myMemberships: endpoint({
        items: (options.memberships ?? []).map((m) => ({
          user_id: 'who',
          source: 'assignment',
          ...m,
        })),
      }),
    };
    mockGetService.mockImplementation((service: unknown) => {
      if (service === IdentityApiService) return identity;
      if (service === AccountsApiService) return accounts;
      return {};
    });
    return { accounts, identity };
  }

  function organizationsDispatched() {
    const call = dispatch.mock.calls.find(
      ([action]) => action?.type === setContextOrganizations({ current: null, items: [] }).type
    );
    return call?.[0]?.payload as { current: unknown; items: { id: string }[] } | undefined;
  }

  beforeEach(() => {
    registerAppContextEffects(app);
    mockHas.mockReturnValue(true);
  });

  afterEach(() => {
    listeners.clear();
    vi.clearAllMocks();
  });

  it('is the memberships of an ordinary person, not their home tenant', async () => {
    const { accounts, identity } = services({
      homeTenantId: ORG_A,
      memberships: [{ org_id: ORG_B, role: 'member' }],
      tenants: { [ORG_B]: tenant(ORG_B, 'Second Org') },
    });

    await emit('app/context/fetch');

    expect(identity.myMemberships.fetch).toHaveBeenCalled();
    // The home tenant is NOT consulted for the list: only the membership is.
    expect(accounts.tenantChildren).not.toHaveBeenCalled();
    expect(organizationsDispatched()?.items.map((o) => o.id)).toEqual([ORG_B]);
    expect(dispatch).toHaveBeenCalledWith(setContextAccess('ready'));
  });

  it('is the tree under the root for a platform administrator, whose access is not a membership', async () => {
    const { accounts, identity } = services({
      homeTenantId: PLATFORM_ROOT_TENANT_ID,
      children: [
        tenant(ORG_A, 'First Org'),
        tenant(ORG_B, 'Second Org'),
        // A workspace under the root must never reach the organization switcher.
        tenant('00000000-0000-0000-0000-0000000000c3', 'A Workspace', TENANT_TYPES.workspace),
      ],
    });

    await emit('app/context/fetch');

    expect(accounts.tenantChildren).toHaveBeenCalledWith({ tenantId: PLATFORM_ROOT_TENANT_ID });
    expect(identity.myMemberships.fetch).not.toHaveBeenCalled();
    expect(organizationsDispatched()?.items.map((o) => o.id)).toEqual([ORG_A, ORG_B]);
  });

  it('reports no access when a person is a member of nothing', async () => {
    services({ homeTenantId: ORG_A, memberships: [] });

    await emit('app/context/fetch');

    expect(organizationsDispatched()?.items).toEqual([]);
    expect(dispatch).toHaveBeenCalledWith(setContextAccess('unassigned'));
  });

  it('drops an organization whose tenant cannot be read rather than showing it nameless', async () => {
    // From outside a self-managed organization's subtree the backend answers 404
    // by design. That is isolation working, and the rest of the list must survive.
    services({
      homeTenantId: ORG_A,
      memberships: [
        { org_id: ORG_A, role: 'owner' },
        { org_id: ORG_B, role: 'member' },
      ],
      tenants: { [ORG_A]: tenant(ORG_A, 'Readable Org') },
    });

    await emit('app/context/fetch');

    expect(organizationsDispatched()?.items.map((o) => o.id)).toEqual([ORG_A]);
    expect(dispatch).toHaveBeenCalledWith(setContextAccess('ready'));
  });

  it('does not show the onboarding screen when the resolve merely failed', async () => {
    // A transient failure is not the same as having no organization: somebody
    // with access must not be told they have none because a request timed out.
    mockGetService.mockImplementation(() => ({
      me: { fetch: vi.fn().mockRejectedValue(new Error('network')) },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await emit('app/context/fetch');

    expect(dispatch).not.toHaveBeenCalledWith(setContextAccess('unassigned'));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
