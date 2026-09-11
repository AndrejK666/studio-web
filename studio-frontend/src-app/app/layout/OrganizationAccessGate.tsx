/**
 * Organization Access Gate
 *
 * What an authenticated person sees when they belong to no organization.
 *
 * This is a supported state, not an error (ADR-0011 §3). Authentication
 * establishes who somebody is; it does not grant organization membership, so
 * "signed in with nowhere to go" is a normal place to be — on a first login
 * before an invitation, or after a membership is revoked.
 *
 * It deliberately shows nothing about the installation: no organization names,
 * no workspaces, no member directory, no create-organization control. Naming an
 * organization to somebody with no membership would leak the tenant tree to
 * anybody who can authenticate, which is the whole failure ADR-0011 exists to
 * prevent.
 */

import React from 'react';
import { useAppSelector } from '@gears-frontx/react';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';

export const OrganizationAccessGate: React.FC = () => (
  <div className="flex h-full w-full items-center justify-center p-8">
    <div className="max-w-md text-center">
      <h1 className="mb-3 text-xl font-semibold">You do not have access to an organization yet</h1>
      <p className="text-sm opacity-70">
        Ask a Studio administrator or an organization owner for an invitation. Once you have one,
        your organizations appear in the top bar.
      </p>
    </div>
  </div>
);

OrganizationAccessGate.displayName = 'OrganizationAccessGate';

/**
 * Whether the shell should show the gate instead of the mounted screen.
 *
 * `loading` deliberately does NOT gate: the context resolves after the shell
 * mounts, and flashing an onboarding message at everybody on every load would
 * be worse than a moment of empty chrome.
 */
export function useHasNoOrganization(): boolean {
  const context = useAppSelector(
    (state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined
  );
  return context?.access === 'unassigned';
}
