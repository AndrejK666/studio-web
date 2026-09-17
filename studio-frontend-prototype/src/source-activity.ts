/** What has been happening in each source, from the graph the sync already
 *  filled.
 *
 *  The product's Sources table shows a week of pull-request activity and a
 *  week of commits per repository, and labels its own numbers "demo values".
 *  Ours are not: every figure here is folded out of the `pull_request` and
 *  `commit` nodes an ingest run wrote, so a repository that has not been
 *  synced reports nothing rather than reporting a plausible seven.
 *
 *  The window is closed at both ends on purpose. "Open" is deliberately NOT
 *  windowed — a pull request opened three weeks ago and still open is the one
 *  most worth seeing, and counting only the last seven days would hide it.
 *  "Merged" and "commits" are, because those are rates: the interesting thing
 *  about a merge is that it happened *recently*.
 */

/** Only the fields the fold reads. Anything else on the node is the caller's. */
export interface ActivityNode {
  value: {
    repo?: unknown;
    state?: unknown;
    merged?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
  };
}

export interface RepoActivity {
  /** Pull requests open right now, whenever they were opened. */
  open: number;
  /** Pull requests merged inside the window. */
  merged: number;
  /** Commits inside the window. */
  commits: number;
  /** One bucket per day, oldest first: pull requests that moved that day.
   *  Length is always `days`, so a sparkline never has to guess its own
   *  x-axis and a quiet repository draws a flat line rather than nothing. */
  days: number[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Epoch millis, or `null` for anything that is not a date we can read. */
function at(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function empty(days: number): RepoActivity {
  return { open: 0, merged: 0, commits: 0, days: new Array(days).fill(0) };
}

/** Fold pull-request and commit nodes into one summary per repository id.
 *
 *  `now` is a parameter rather than `Date.now()` so the buckets are testable
 *  and so every row on one screen is measured against the same instant —
 *  otherwise a render spanning midnight puts two repositories on different
 *  axes.
 */
export function repoActivity(
  pulls: ActivityNode[],
  commits: ActivityNode[],
  now: number,
  days = 7,
): Record<string, RepoActivity> {
  const out: Record<string, RepoActivity> = {};
  // Buckets run to the END of today, so the last one is the day in progress
  // rather than a stub 3 hours wide that reads as a quiet day.
  const end = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  const start = end - days * DAY_MS;

  /** Which bucket a moment falls in, or -1 when it is outside the window. */
  const bucket = (ms: number | null) => {
    if (ms == null || ms < start || ms >= end) return -1;
    return Math.floor((ms - start) / DAY_MS);
  };

  const row = (node: ActivityNode): RepoActivity | null => {
    const repo = node.value.repo;
    if (typeof repo !== "string" || !repo) return null;
    return (out[repo] ??= empty(days));
  };

  for (const pull of pulls) {
    const activity = row(pull);
    if (!activity) continue;
    const merged = pull.value.merged === true || pull.value.state === "merged";
    const closed = merged || pull.value.state === "closed";
    if (!closed) activity.open += 1;
    // `updated_at` is when the pull request last moved, which for a merged one
    // is the merge. The node carries no merged_at of its own, and inventing a
    // more precise claim than the data supports is worse than this one.
    const moved = bucket(at(pull.value.updated_at) ?? at(pull.value.created_at));
    if (merged && moved >= 0) activity.merged += 1;
    if (moved >= 0) activity.days[moved] += 1;
  }

  for (const commit of commits) {
    const activity = row(commit);
    if (!activity) continue;
    if (bucket(at(commit.value.created_at)) >= 0) activity.commits += 1;
  }

  return out;
}

/** Whether a node is old enough to stop a walk that reads newest-first.
 *
 *  Commits outnumber everything else in a repository, and paging all of them
 *  to count one week is a lot of requests for a number that stops changing
 *  after the seventh page. A caller sorting by `updated` can stop at the first
 *  node this returns true for.
 */
export function olderThanWindow(node: ActivityNode, now: number, days = 7): boolean {
  const ms = at(node.value.updated_at) ?? at(node.value.created_at);
  // A node with no readable date never stops the walk: it is the walk's job to
  // page, not to guess, and one undated row must not truncate the rest.
  if (ms == null) return false;
  const end = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  return ms < end - days * DAY_MS;
}
