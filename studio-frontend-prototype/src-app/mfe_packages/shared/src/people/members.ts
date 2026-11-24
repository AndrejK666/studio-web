/**
 * An organization's members and the caller's colleagues, every page, read the
 * one way every MFE shares (`studio-user`, through the gateway): the same URL
 * from People, Team, Admin, Issues and Reports, so the second reader within
 * the cache's 30 s gets the first one's answer. `fresh` reads past the cache —
 * for a screen that has just changed the members.
 */

import { gateway, withQuery } from '../data/gateway';
import { fetchAllPages } from '../data/pages';
import type { Colleague, OrgMember } from './types';

/** studio-user's page ceiling. */
const PAGE = 200;

const FRESH = { staleTime: 0 };

type Page<T> = { items?: T[]; total?: number };

/** `GET /studio-user/v1/organizations/{id}/members`, one page. */
export function orgMembersPagePath(orgId: string, offset: number, include?: string): string {
  return withQuery(`/studio-user/v1/organizations/${encodeURIComponent(orgId)}/members`, {
    offset,
    limit: PAGE,
    ...(include ? { include } : {}),
  });
}

/** `GET /studio-user/v1/me/colleagues`, one page. */
export function colleaguesPagePath(offset: number): string {
  return withQuery('/studio-user/v1/me/colleagues', { offset, limit: PAGE });
}

/** Every member of `orgId` (`people.view`); `include: 'aliases'` answers each one's attributed identities too. */
export async function readOrgMembers<T = OrgMember>(
  orgId: string,
  { fresh = false, include }: { fresh?: boolean; include?: 'aliases' } = {}
): Promise<T[]> {
  const read = await fetchAllPages(
    (offset) => gateway().get<Page<T>>(orgMembersPagePath(orgId, offset, include)).fetch(fresh ? FRESH : undefined),
    { pageSize: PAGE }
  );
  return read.items;
}

/** Everybody the caller shares an organization with. */
export async function readColleagues<T = Colleague>({ fresh = false }: { fresh?: boolean } = {}): Promise<T[]> {
  const read = await fetchAllPages(
    (offset) => gateway().get<Page<T>>(colleaguesPagePath(offset)).fetch(fresh ? FRESH : undefined),
    { pageSize: PAGE }
  );
  return read.items;
}
