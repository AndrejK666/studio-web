/* Small shared formatting/matching helpers.
 *
 * Extracted from App.tsx so the concept-v2 screens (projects.tsx, people.tsx)
 * can use them without importing the shell — which imports them back. */

import { ApiError } from "./api";

/** A canonical error's body, as much of it as this helper reads. */
interface ProblemBody {
  title?: string;
  detail?: string;
  context?: {
    /** `invalid_argument`: what the caller broke. */
    constraint?: string;
    /** `failed_precondition`: one entry per unmet precondition. */
    violations?: { description?: string }[];
  };
}

/**
 * The backend's own sentence, where it wrote one.
 *
 * `detail` is enough for most canonical errors, but two shapes keep the part
 * worth reading somewhere else: a `failed_precondition` says "Operation
 * precondition not met" in `detail` and puts the reason in
 * `context.violations[].description`, and an `invalid_argument` repeats itself
 * in `context.constraint`. The notification surfaces live on exactly those two
 * — "this connection is an incoming webhook, its channel is fixed in the URL",
 * "no IDE session to notify for workspace X" — so dropping them left a person
 * reading the name of a category instead of the answer.
 */
export function errText(e: unknown): string {
  if (!(e instanceof ApiError)) return String(e);

  const body = e.body as ProblemBody | undefined;
  const detail = body?.detail?.trim();
  const reasons = (body?.context?.violations ?? [])
    .map((v) => v.description?.trim())
    .filter((d): d is string => Boolean(d));
  const constraint = body?.context?.constraint?.trim();
  if (reasons.length === 0 && constraint) {
    reasons.push(constraint);
  }

  // Kept only when it adds something: `invalid_argument` already puts the
  // constraint in `detail`, and repeating it reads as a stutter.
  const said = reasons.filter((r) => r !== detail);
  const parts = [detail, ...said].filter((p): p is string => Boolean(p));

  return `HTTP ${e.status}${body?.title ? ` · ${body.title}` : ""}${
    parts.length > 0 ? ` — ${parts.join(" — ")}` : ""
  }`;
}

/** Case-insensitive "does any of these fields contain the needle". */
export function matches(q: string, ...fields: (string | undefined | null)[]): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

/** "8 min ago" / "2 hours ago" / "3 days ago" — the UPDATED column's vocabulary. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/** Two-letter avatar initials from a display name or username. */
export function initials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
