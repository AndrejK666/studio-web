/**
 * Which open pull requests a review is for. The review names branches only and
 * runs against the project's configured Git source, so a pull request of
 * another repository (the same branch name in two repositories) would be
 * reviewed against the wrong code: only the configured repository's are kept.
 */

import type { OpenPullRequest } from '../api/types';

/** `owner/name` as providers compare it: case-insensitive, no `.git`, no slashes at the ends. */
const key = (repo: string) =>
  repo
    .trim()
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();

/**
 * The pull requests of `repository` (`owner/name`), and how many of other
 * repositories were left out. Without a known repository none is kept: a
 * review could not say which code it read.
 */
export function pullsOf(
  pulls: readonly OpenPullRequest[],
  repository: string | null | undefined
): { mine: OpenPullRequest[]; others: number } {
  if (!repository) return { mine: [], others: pulls.length };
  const want = key(repository);
  const mine = pulls.filter((p) => p.repo != null && key(p.repo) === want);
  return { mine, others: pulls.length - mine.length };
}
