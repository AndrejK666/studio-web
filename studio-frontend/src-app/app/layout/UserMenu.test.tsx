import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearUser } from '@gears-frontx/react';

/**
 * Identity used to live at the foot of the left menu. The menu became a drawer
 * that is closed most of the time, so sign-out moved to the top bar — these are
 * the menu's old user-block tests, following the control to its new home.
 */

interface TestUser {
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

const { mockAuth, mockDispatch, mockEventBus, headerState } = vi.hoisted(() => ({
  mockAuth: { logout: vi.fn() },
  mockEventBus: { emit: vi.fn() },
  mockDispatch: vi.fn(),
  headerState: {
    user: { displayName: 'Alexander Johanson', email: 'alex@studio' } as TestUser | null,
    loading: false,
  },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFrontX: () => ({ auth: mockAuth }),
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ 'layout/header': headerState }),
  eventBus: mockEventBus,
}));

vi.mock('@/app/i18n/shellTranslations', () => import('@frontx-test-utils/shellText'));

import { UserMenu } from './UserMenu';

/** The identity block and sign-out live behind the avatar trigger. */
function openMenu(label = 'Alexander Johanson') {
  fireEvent.click(screen.getByLabelText(label));
}

describe('UserMenu', () => {
  beforeEach(() => {
    headerState.user = { displayName: 'Alexander Johanson', email: 'alex@studio' };
    headerState.loading = false;
    mockAuth.logout.mockResolvedValue({ type: 'none' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('labels the trigger with the signed-in identity', () => {
    render(<UserMenu />);
    expect(screen.getByLabelText('Alexander Johanson')).toBeTruthy();
  });

  it('falls back to the email when no display name is known', () => {
    headerState.user = { email: 'alex@studio' };
    render(<UserMenu />);
    expect(screen.getByLabelText('alex@studio')).toBeTruthy();
  });

  it.each([
    ['two words of the display name', { displayName: 'alexander johanson', email: 'a@studio' }, 'AJ'],
    ['a one-word display name', { displayName: 'alexander' }, 'A'],
    ['the email when the display name is blank', { displayName: '  ', email: 'alex@studio' }, 'A'],
    ['a question mark when nothing is known', {}, '?'],
  ])('shows initials from %s', (_case, user, initials) => {
    headerState.user = user;
    render(<UserMenu />);
    expect(screen.getByText(initials)).toBeTruthy();
  });

  it('shows a placeholder rather than an identity while the user is loading', () => {
    headerState.user = null;
    headerState.loading = true;
    render(<UserMenu />);
    expect(screen.queryByLabelText('User')).toBeNull();
  });

  it('names the user and their email once opened', async () => {
    render(<UserMenu />);
    openMenu();
    await waitFor(() => expect(screen.getByText('alex@studio')).toBeTruthy());
  });

  // The path has no organization slot; this is the way back from any depth.
  it('leads to the organization by asking the shell for that level', async () => {
    render(<UserMenu />);
    openMenu();
    fireEvent.click(await screen.findByText('Organization'));

    expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/level/requested', {
      level: 'organization',
    });
  });

  it('sign-out clears the user and logs out via the auth runtime', async () => {
    render(<UserMenu />);
    openMenu();
    fireEvent.click(await screen.findByText('Sign out'));

    await waitFor(() => expect(mockAuth.logout).toHaveBeenCalled());
    expect(mockDispatch).toHaveBeenCalledWith(clearUser());
  });

  it('follows the IdP redirect returned by logout', async () => {
    mockAuth.logout.mockResolvedValue({ type: 'redirect', redirectUrl: 'https://idp/logout' });
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      set href(value: string) {
        assign(value);
      },
    } as unknown as Location);

    render(<UserMenu />);
    openMenu();
    fireEvent.click(await screen.findByText('Sign out'));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://idp/logout'));
    vi.restoreAllMocks();
  });
});
