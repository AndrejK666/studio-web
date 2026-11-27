/** How a run reads on the page: its stage and counter while it goes, its outcome after. */

import type { Run } from '../api/types';

export const ENDED = ['succeeded', 'failed', 'cancelled', 'interrupted'];

export const ended = (r: Run | null | undefined) => !!r && ENDED.includes(r.state);

/** `facts 40/85`, `embeddings 1,200/9,000`, `judging 10`, or the bare stage; null before a step reports. */
export function progressOf(r: Run | null | undefined): { stage: string; done?: number; total?: number } | null {
  const p = r?.progress;
  if (!p?.stage) return null;
  return { stage: p.stage, done: p.done ?? undefined, total: p.total ?? undefined };
}

/** Minutes and seconds since `iso`, as `3:07`. */
export function elapsed(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The newest succeeded run of a list (newest first), if any. */
export const lastSucceeded = (runs: readonly Run[]) => runs.find((r) => r.state === 'succeeded') ?? null;
