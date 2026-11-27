/**
 * A derived view (studio-backend `derived_view.rs`): what a gear computed from
 * a project's synced repositories and kept, rather than read from the
 * provider on every open. The answer says what it was computed from (each
 * repository and its commit), when, and whether a computation is running.
 *
 * A screen reading one shows that line — "by commit a1b2c3d · computed
 * 5 min ago ↻" — reads again while a computation runs, and offers ↻ to ask
 * for one. The Components tab is the first; the line and the polling are
 * here so the next view (project status, conformance) reads the same.
 */

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { usePollWhileVisible } from '../polling/pollWhileVisible';

/** One repository a view was computed from. */
export interface DerivedViewInput {
  source: string;
  /** The commit of the server's clone it was read at; null without a clone. */
  commit?: string | null;
  /** What could not be read from it, and why. */
  note?: string | null;
}

/** What a view was computed from, when, and how that went. */
export interface DerivedViewState {
  status: 'computing' | 'ready' | 'failed' | string;
  computed_at?: string | null;
  requested_at?: string | null;
  error?: string | null;
  inputs: DerivedViewInput[];
}

/** Whether a computation is queued or running. */
export function isComputing(view: DerivedViewState | null | undefined): boolean {
  return view?.status === 'computing';
}

/** The commits a view was read at, short and distinct, in input order. */
export function viewCommits(view: DerivedViewState | null | undefined): string[] {
  const out: string[] = [];
  for (const i of view?.inputs ?? []) {
    const short = i.commit?.slice(0, 7);
    if (short && !out.includes(short)) out.push(short);
  }
  return out;
}

/** How long ago `iso` was, in the largest whole unit: `5 min`, `3 h`, `2 d`. */
export function agoText(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Reads `reread` every `ms` while the view is being computed (and the tab is shown). */
export function useDerivedViewPoll(view: DerivedViewState | null | undefined, reread: () => void, ms = 4000): void {
  usePollWhileVisible(reread, ms, isComputing(view));
}

/** The words of the line, in the screen's language. */
export interface DerivedViewLabels {
  /** `by commit {commits}` */
  byCommit: (commits: string) => string;
  /** `computed {ago} ago` */
  computed: (ago: string) => string;
  computing: string;
  /** `the last computation failed: {error}` */
  failed: (error: string) => string;
  /** `not computed yet` */
  never: string;
  refresh: string;
}

/** "by commit a1b2c3d · computed 5 min ago ↻", with each input's note as its title. */
export const DerivedViewStrip: React.FC<{
  view: DerivedViewState | null | undefined;
  labels: DerivedViewLabels;
  onRefresh?: () => void;
  className?: string;
}> = ({ view, labels, onRefresh, className }) => {
  if (!view) return null;
  const commits = viewCommits(view);
  const ago = agoText(view.computed_at);
  const parts: string[] = [];
  if (commits.length) parts.push(labels.byCommit(commits.join(', ')));
  parts.push(ago ? labels.computed(ago) : labels.never);
  const notes = view.inputs
    .filter((i) => i.note)
    .map((i) => `${i.source}: ${i.note}`)
    .join('\n');
  const computing = isComputing(view);
  return (
    <span
      className={className}
      data-derived-view={view.status}
      title={notes || undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <span>{parts.join(' · ')}</span>
      {computing && <span data-derived-view-computing>· {labels.computing}</span>}
      {view.status === 'failed' && view.error && <span data-derived-view-error>· {labels.failed(view.error)}</span>}
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={computing}
          aria-label={labels.refresh}
          title={labels.refresh}
          data-derived-view-refresh
          style={{
            background: 'none',
            border: 0,
            padding: 0,
            cursor: computing ? 'default' : 'pointer',
            color: 'inherit',
            display: 'inline-flex',
          }}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      )}
    </span>
  );
};
