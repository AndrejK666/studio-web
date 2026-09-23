import type { ActivityEvent } from "./api";

/** Free-text filter across everything a row shows.
 *
 *  Across every column, because the search box sits over the table and a
 *  reader typing a detector name into it means "find that", not "find that in
 *  the column I have not told you about".
 *
 *  This stays in the browser deliberately, unlike the fold that produced the
 *  rows: it narrows what is already on screen as somebody types, and a request
 *  per keystroke would be a worse answer to the same question.
 */
export function matchesQuery(event: ActivityEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [event.event, event.subject, event.by, event.severity ?? "", event.recorded ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(q);
}
