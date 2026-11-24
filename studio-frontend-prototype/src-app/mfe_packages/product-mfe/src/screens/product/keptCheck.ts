/**
 * The engine's verdict on the saved description, as the server keeps it.
 *
 * A check of a product of sixty gears outlasted the gateway's 30 s, so the
 * page no longer waits on one: it shows the verdict kept on the product
 * record (`checks.<profile>`, with when it was made), queues a check on the
 * server (`POST product-check-runs`) only when the kept verdict is about
 * another text than the saved revision -- or when somebody presses Check now
 * -- and reads the record again until the queued check has landed.
 */

import { useCallback, useEffect, useState } from 'react';
import { PRODUCT_CHANGED_EVENT, productApi } from '../../api/client';
import type { ProductCheck, ProductCheckRun, ProjectProduct } from '../../api/types';
import { errText } from '../common';

/** How often a queued check's record is read again, and for how long. */
export const CHECK_READ_EVERY_MS = 4_000;
export const CHECK_READS = 75;

/** The saved revision the verdict is about. */
export interface KeptRevision {
  revision: number;
  sha256: string;
}

/** Checks queued without anybody asking, this session: one per text and profile. */
const autoQueued = new Set<string>();

/** Forget which checks were queued on their own: for a test. */
export function forgetQueuedChecks(): void {
  autoQueued.clear();
}

/** Whether the kept verdict for `profile` is about a text other than the
 *  saved revision, with no check of it queued: then one is worth queueing. */
export function needsCheck(product: ProjectProduct | null | undefined, profile: string, kept: KeptRevision | null): boolean {
  if (!product || !kept?.sha256) return false;
  const check = product.checks?.[profile];
  if (check?.gdl_sha256 === kept.sha256) return false;
  const run = product.check_runs?.[profile];
  // Queued for this revision already: follow it rather than ask again.
  if (run?.state === 'queued' && (run.revision === undefined || run.revision === kept.revision)) return false;
  return true;
}

/** A queued check has landed: its run is no longer waiting, or the verdict is its own. */
export function landed(product: ProjectProduct | null | undefined, profile: string, runId: string): boolean {
  const run = product?.check_runs?.[profile];
  if (product?.checks?.[profile]?.run_id === runId) return true;
  return !!run && run.run_id === runId && run.state !== 'queued';
}

export interface KeptCheck {
  /** The kept verdict, whichever text it was about. */
  check: ProductCheck | null;
  /** The latest queued check. */
  run: ProductCheckRun | null;
  /** Whether the verdict is about the saved revision. */
  current: boolean;
  /** A queued check is being followed. */
  checking: boolean;
  /** Followed for as long as it is followed, and not landed. */
  stillChecking: boolean;
  /** Why the last ask could not be queued. */
  error: string | null;
  /** Check now. */
  start: () => void;
}

export function useKeptCheck(
  projectId: string,
  product: ProjectProduct | null | undefined,
  profile: string,
  kept: KeptRevision | null
): KeptCheck {
  const [following, setFollowing] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = product?.check_runs?.[profile] ?? null;
  const check = product?.checks?.[profile] ?? null;

  /** Queue a check; its run is followed once the server answers. */
  const queue = useCallback(() => {
    productApi.startProductCheck(projectId, profile).then(
      (r) => setFollowing(r.run_id),
      (e: unknown) => setError(errText(e))
    );
  }, [projectId, profile]);
  const start = useCallback(() => {
    setError(null);
    setGaveUp(null);
    queue();
  }, [queue]);

  // The kept verdict is about another text than the saved revision: ask
  // once, in the background.
  useEffect(() => {
    if (!kept || !needsCheck(product, profile, kept)) return;
    const key = `${projectId}|${profile}|${kept.sha256}`;
    if (autoQueued.has(key)) return;
    autoQueued.add(key);
    queue();
  }, [projectId, profile, kept, product, queue]);

  // Follow the queued check by reading the record until it lands.
  const runId = following ?? (run?.state === 'queued' ? run.run_id : null);
  const watched = runId && runId !== gaveUp ? runId : null;
  useEffect(() => {
    if (!watched) return;
    let live = true;
    let reads = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!live) return;
      reads += 1;
      try {
        const now = await productApi.projectProduct(projectId);
        if (!live) return;
        if (landed(now, profile, watched)) {
          setFollowing(null);
          window.dispatchEvent(new CustomEvent(PRODUCT_CHANGED_EVENT, { detail: projectId }));
          return;
        }
      } catch {
        /* read again next time */
      }
      if (reads >= CHECK_READS) {
        setGaveUp(watched);
        return;
      }
      timer = setTimeout(() => void tick(), CHECK_READ_EVERY_MS);
    };
    timer = setTimeout(() => void tick(), CHECK_READ_EVERY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [watched, projectId, profile]);

  return {
    check,
    run,
    current: !!check && !!kept?.sha256 && check.gdl_sha256 === kept.sha256,
    checking: !!watched,
    stillChecking: !!runId && runId === gaveUp,
    error,
    start,
  };
}
