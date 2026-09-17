/** The project's activity feed, folded out of what the graph actually keeps.
 *
 *  The product's own Activity page says it plainly: *"Latest checks and
 *  comments only; earlier history is not retained."* That is true of our data
 *  too, and for a reason worth stating rather than working around — a
 *  `spec_finding` node's instance id is keyed on (detector, subject), so
 *  re-running a detector **upserts**. There is one finding per detector per
 *  document, carrying when it was last produced. That is a current state with
 *  a timestamp on it, not a log, and a feed built from it shows the latest
 *  check per document and nothing before it.
 *
 *  Comments are the other half, and they are a genuine history: every comment
 *  a sync pulled is its own node with its own `created_at`.
 */

/** Only what the fold reads. */
export interface FeedNode {
  instance_id: string;
  value: Record<string, unknown>;
}

export type EventKind = "check" | "comment";

export interface ActivityEvent {
  id: string;
  kind: EventKind;
  /** What happened, in the product's words. */
  event: string;
  /** What it happened to — a document path, or the issue a comment is on. */
  subject: string;
  /** Who or what did it. A detector is a "who" here; the product writes
   *  "Studio" for its own checks and we name the detector, which is the same
   *  claim with more in it. */
  by: string;
  /** RFC 3339, or `null` when the node carries no time. */
  recorded: string | null;
  /** The detector's own word for how it went, when there is one. */
  severity: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The last path segment, which is what a reader recognises. */
function leaf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Fold findings and comments into one feed, newest first.
 *
 *  `nameOf` resolves a document node id to something worth reading — the
 *  Specs list knows the paths and this does not, so the caller supplies it.
 *  A subject nothing can name falls back to its path and then to its id: a row
 *  naming an opaque id is still a row somebody can chase, and dropping it
 *  would hide a check that really happened.
 */
export function activityFeed(
  findings: FeedNode[],
  comments: FeedNode[],
  nameOf: (subjectId: string) => string | undefined,
): ActivityEvent[] {
  const out: ActivityEvent[] = [];

  for (const node of findings) {
    const v = node.value;
    const subject = str(v.subject);
    const path = str(v.path);
    out.push({
      id: node.instance_id,
      kind: "check",
      event: "Document checked",
      subject: (subject && nameOf(subject)) ?? (path ? leaf(path) : (subject ?? node.instance_id)),
      by: str(v.detector) ?? "Studio",
      recorded: str(v.recorded_at),
      severity: str(v.severity),
    });
  }

  for (const node of comments) {
    const v = node.value;
    const number = typeof v.target_number === "number" ? v.target_number : null;
    out.push({
      id: node.instance_id,
      kind: "comment",
      event: "Comment",
      // The comment's own text is its title; what it is ON is the number.
      subject: number != null ? `#${number}` : (str(v.title) ?? node.instance_id),
      by: str(v.author) ?? "unknown",
      recorded: str(v.created_at) ?? str(v.updated_at),
      severity: null,
    });
  }

  // Newest first, and everything undated last rather than first: a missing
  // timestamp sorting to the top would put the least informative rows where
  // the most recent ones belong. Findings written before `recorded_at`
  // existed are exactly that case.
  return out.sort((a, b) => {
    const at = a.recorded ? Date.parse(a.recorded) : Number.NEGATIVE_INFINITY;
    const bt = b.recorded ? Date.parse(b.recorded) : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(at) || Number.isNaN(bt) || at === bt) return a.id.localeCompare(b.id);
    return bt - at;
  });
}

/** Free-text filter across everything a row shows.
 *
 *  Across every column, because the search box sits over the table and a
 *  reader typing a detector name into it means "find that", not "find that in
 *  the column I have not told you about".
 */
export function matchesQuery(event: ActivityEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [event.event, event.subject, event.by, event.severity ?? "", event.recorded ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(q);
}
