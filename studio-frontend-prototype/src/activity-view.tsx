/** The project's Activity section.
 *
 *  Laid out as the product lays it out: a heading, one line saying what is and
 *  is not kept, a filter control and a search box over the table, columns of
 *  Event / Document / By / Recorded, and a record count under it.
 *
 *  The one place this deliberately differs is the By column. The product
 *  writes "Studio" against every check; we write the detector that made it —
 *  `leak`, `purpose`, `bloat`, `traceability` — which is the same claim with
 *  the useful part left in.
 */

import { useCallback, useEffect, useState } from "react";

import { api, type ActivityEvent, type ActivityEventKind } from "./api";
import { DataTable, When } from "./data-table";
import { errText } from "./format";
import { Tile } from "./view-mode";


const KINDS: { id: ActivityEventKind; label: string }[] = [
  { id: "check", label: "Checks" },
  { id: "comment", label: "Comments" },
];

export function ActivityView({
  token,
  projectTenantId,
  workspaceId,
}: {
  token: string;
  projectTenantId: string;
  /** Parent workspace, for the document bindings that name each subject. */
  workspaceId: string;
}) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    try {
      // Both kinds, in one feed, ordered and named by the gear that owns the
      // nodes. This used to be two paged walks plus a read of every binding
      // to name the rows.
      setEvents((await api.activityFeed(token, projectTenantId)).items);
    } catch (e) {
      setErr(errText(e));
      setEvents([]);
    }
  }, [token, projectTenantId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const recordedAt = (e: ActivityEvent) => {
    const t = Date.parse(e.recorded ?? "");
    // An undated row sorts last, whichever way the column is turned.
    return Number.isNaN(t) ? -Infinity : t;
  };

  return (
    <div className="card">
      <p className="hint">
        Latest checks and comments only; earlier history is not retained. A detector's verdict is
        one node per detector per document, so re-running one replaces its answer rather than
        adding to it.
      </p>
      <DataTable<ActivityEvent>
        list="activity"
        title="Activity"
        rows={events === null && err ? [] : events}
        error={err}
        onRetry={() => void load()}
        rowKey={(e) => e.id}
        rowLabel={(e) => `${e.event} ${e.subject}`}
        search={{ placeholder: "Search activity" }}
        searchText={(e) => [e.event, e.subject, e.by, e.severity, e.recorded]}
        filters={[
          {
            id: "kind",
            allLabel: "Everything",
            kind: "chips",
            options: KINDS.map((k) => ({ value: k.id, label: k.label })),
            match: (e, v) => e.kind === v,
          },
        ]}
        empty={{
          title: "Nothing recorded yet.",
          body: "Run a check on the Specs tab, or sync a repository to pull its comments.",
        }}
        columns={[
          { id: "event", header: "Event", className: "acell-lead", cell: (e) => e.event },
          { id: "subject", header: "Document", className: "act-subject", cell: (e) => e.subject },
          { id: "by", header: "By", cell: (e) => <span className="sub">{e.by}</span> },
          {
            // Relative, with the full timestamp on hover: an activity row is
            // evidence, and the date is one hover away and sorts.
            id: "recorded",
            header: "Recorded",
            compare: (a, b) => recordedAt(a) - recordedAt(b),
            cell: (e) => <When iso={e.recorded} className="sub" />,
          },
        ]}
        tile={(e) => (
          <Tile
            title={e.event}
            subtitle={e.subject}
            tone={e.severity === "high" ? "attn" : undefined}
            stats={[
              { label: "by", value: e.by },
              { label: "severity", value: e.severity ?? "—" },
            ]}
            footer={<When iso={e.recorded} />}
          />
        )}
      />
    </div>
  );
}
