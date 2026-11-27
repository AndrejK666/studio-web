import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => ({ completeSignIn: { fetch: complete } }) },
}));

// Imported once, at collection: a fresh module per case (vi.resetModules)
// re-imported the whole module graph inside each test, which passed the 5 s
// test timeout on a loaded machine.
import {
  ConnectionSignInCallback,
  isConnectionSignInCallback,
  resetConnectionSignInArrivalForTests,
} from './ConnectionSignInCallback';

/** A new page load at this address: the arrival is read once per page load. */
function page(address: string): void {
  window.history.replaceState({}, '', address);
  resetConnectionSignInArrivalForTests();
}

beforeEach(() => {
  complete.mockReset();
  sessionStorage.clear();
});

afterEach(() => window.history.replaceState({}, '', '/'));

describe('ConnectionSignInCallback', () => {
  it('knows its own address and no other', () => {
    page('/');
    expect(isConnectionSignInCallback('/connections/oauth/callback')).toBe(true);
    expect(isConnectionSignInCallback('/')).toBe(false);
  });

  it('hands the code to studio-connector once, off the address, and says who was connected', async () => {
    complete.mockResolvedValue({ connection: { label: 'My Research' }, account: 'ann', display_name: 'Ann' });
    sessionStorage.setItem('studio.connection-sign-in.return', '/?screen=admin;section=integrations');
    page('/connections/oauth/callback?code=abc&state=s1');
    render(<ConnectionSignInCallback />);
    expect(window.location.search).toBe('');
    await waitFor(() => expect(screen.getByText('Ann')).toBeTruthy());
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ state: 's1', code: 'abc' });
    expect(screen.getByText('← Back').getAttribute('href')).toBe('/?screen=admin;section=integrations');
  });

  it('says a cancelled sign-in was cancelled, and asks nothing', () => {
    page('/connections/oauth/callback?error=access_denied');
    render(<ConnectionSignInCallback />);
    expect(screen.getByRole('alert').textContent).toBe('The sign-in was cancelled.');
    expect(complete).not.toHaveBeenCalled();
  });

  it('shows the backend’s refusal', async () => {
    complete.mockRejectedValue(
      Object.assign(new Error('400'), { response: { status: 400, data: { detail: 'The sign-in expired' } } })
    );
    page('/connections/oauth/callback?code=abc&state=s1');
    render(<ConnectionSignInCallback />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The sign-in expired'));
  });
});
