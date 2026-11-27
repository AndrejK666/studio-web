/* How far a Research build and its deploy are (#1053): the run's `result`
 * carries `progress` -- the step out of the known steps and, within the
 * upload, files and bytes done of total; within the image builds, images --
 * as `environments/research_progress.rs` writes it. Read here into what a
 * bar draws: the overall share by step, and a determinate share for the step
 * where a total is known, none (indeterminate) where it is not. */

/** The steps from a build to an application that runs, in order. */
export const RESEARCH_STEPS = ["prepare", "desk", "upload", "images", "deploy", "ready"] as const;
export type ResearchStep = (typeof RESEARCH_STEPS)[number];

export interface Count {
  done: number;
  total: number;
}

export interface ResearchProgress {
  step: ResearchStep;
  files?: Count;
  bytes?: Count;
  images?: Count;
}

function count(v: unknown): Count | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { done, total } = v as Record<string, unknown>;
  return typeof done === "number" && typeof total === "number" && total >= 0 ? { done: Math.max(0, done), total } : undefined;
}

/** The progress a run's `result` carries; `null` when it carries none. */
export function researchProgressOf(result: unknown): ResearchProgress | null {
  if (!result || typeof result !== "object") return null;
  const p = (result as Record<string, unknown>).progress;
  if (!p || typeof p !== "object") return null;
  const raw = p as Record<string, unknown>;
  const step = RESEARCH_STEPS.find((s) => s === raw.step);
  if (!step) return null;
  return { step, files: count(raw.files), bytes: count(raw.bytes), images: count(raw.images) };
}

/** The share of the step done, 0..1; `null` where no total is known yet
 *  (the desk starting, a step just begun): an indeterminate bar. */
export function stepShare(p: ResearchProgress): number | null {
  const of = (c?: Count) => (c && c.total > 0 ? Math.min(1, c.done / c.total) : null);
  switch (p.step) {
    case "upload":
      return of(p.bytes) ?? of(p.files);
    case "images":
      return of(p.images);
    default:
      return null;
  }
}

/** The whole way's share, 0..1: each step an equal part, the current one
 *  as far as it is (nothing where it is not known). */
export function overallShare(p: ResearchProgress): number {
  const index = RESEARCH_STEPS.indexOf(p.step);
  const within = p.step === "ready" ? 1 : (stepShare(p) ?? 0);
  return Math.min(1, (index + within) / RESEARCH_STEPS.length);
}

/** A byte count as people read it: 46 MB, 820 KB, 1.2 GB. */
export function bytesLabel(n: number, language = "en"): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u += 1;
  }
  const digits = u === 0 || v >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(v)} ${units[u]}`;
}

/** A count as people read it in `language`: 1,240 in English, 1 240 in Russian. */
export function numberLabel(n: number, language = "en"): string {
  return new Intl.NumberFormat(language).format(n);
}
