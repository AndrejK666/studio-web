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

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "./api";
import { activityFeed, matchesQuery, type ActivityEvent, type EventKind } from "./activity";
import { errText, relTime } from "./format";
import { Tile, TileGrid, ViewToggle, useViewMode } from "./view-mode";

/** One page of the walk, and the most it reads. A feed nobody can scroll past
 *  two thousand rows of is a feed that needed a filter, not more pages. */
const PAGE = 200;
const MAX = 2000;

const KINDS: { id: EventKind; label: string }[] = [
  { id: "check", label: "Checks" },
  { id: "comment", label: "Comments" },
];

/** The product prints a full timestamp, not "4h ago": an activity row is
 *  evidence, and evidence carries a date. The relative form goes on the title,
 *  where it answers "recently?" without costing the column its precision. */
function stamp(recorded: string | null): { text: string; title: string } {
  if (!recorded) return { text: "—", title: "this record carries no time" };
  const ms = Date.parse(recorded);
  if (Number.isNaN(ms)) return { text: recorded, title: recorded };
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    text: `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    title: relTime(recorded),
  };
}

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
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<EventKind>>(() => new Set(KINDS.map((k) => k.id)));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [view, setView] = useViewMode("activity.view");

  const load = useCallback(async () => {
    setErr(null);
    try {
      const walk = async (type: string) => {
        const out: { instance_id: string; value: Record<string, unknown> }[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.listArtifactNodes(token, type, projectTenantId, cursor, PAGE);
          out.push(...(page.nodes ?? []));
          cursor = page.next_cursor;
        } while (cursor && out.length < MAX);
        return out;
      };
      // Bindings name the documents. Read alongside, and allowed to fail on
      // its own: losing the names leaves rows reading by path, which is worse
      // than a name and much better than no feed.
      const [findings, comments, bindings] = await Promise.all([
        walk("spec_finding"),
        walk("comment"),
        api.docBindings(token, workspaceId, projectTenantId, { limit: 500 }).catch(() => ({
          items: [],
          total: 0,
        })),
      ]);
      const nameByNode = new Map<string, string>();
      for (const b of bindings.items ?? []) {
        nameByNode.set(b.node_id, b.path.split("/").pop() ?? b.path);
      }
      setEvents(activityFeed(findings, comments, (id) => nameByNode.get(id)));
    } catch (e) {
      setErr(errText(e));
      setEvents([]);
    }
  }, [token, projectTenantId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (events ?? []).filter((e) => kinds.has(e.kind) && matchesQuery(e, query)),
    [events, kinds, query],
  );

  const toggleKind = (kind: EventKind) =>
    setKinds((current) => {
      const next = new Set(current);
      // Never empty: unticking the last kind would show nothing and read as a
      // broken feed rather than as a filter nobody meant to set.
      if (next.has(kind) && next.size > 1) next.delete(kind);
      else next.add(kind);
      return next;
    });

  return (
    <div className="card">
      <div className="card-head">
        <h2>Activity</h2>
        <ViewToggle mode={view} onChange={setView} />
      </div>
      <p className="hint">
        Latest checks and comments only; earlier history is not retained. A detector's verdict is
        one node per detector per document, so re-running one replaces its answer rather than
        adding to it.
      </p>

      <div className="act-controls">
        <div className="act-filters">
          <button className="ghost" onClick={() => setFiltersOpen((v) => !v)}>
            Filters {filtersOpen ? "⌃" : "⌄"}
          </button>
          {filtersOpen && (
            <div className="act-filter-menu">
              {KINDS.map((k) => (
                <label key={k.id} className="act-filter-opt">
                  <input
                    type="checkbox"
                    checked={kinds.has(k.id)}
                    onChange={() => toggleKind(k.id)}
                  />
                  {k.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <input
          className="act-search"
          placeholder="Search table…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {err && <p className="error">{err}</p>}
      {events === null ? (
        <p className="empty">Loading activity…</p>
      ) : shown.length === 0 ? (
        <p className="empty">
          {(events ?? []).length === 0
            ? "Nothing recorded yet — run a check on the Specs tab, or sync a repository to pull its comments."
            : "Nothing matches the current filters."}
        </p>
      ) : view === "tiles" ? (
        <TileGrid>
          {shown.map((e) => {
            const when = stamp(e.recorded);
            return (
              <Tile
                key={e.id}
                title={e.event}
                subtitle={e.subject}
                tone={e.severity === "high" ? "attn" : undefined}
                stats={[
                  { label: "by", value: e.by },
                  { label: "severity", value: e.severity ?? "—" },
                ]}
                footer={<span title={when.title}>{when.text}</span>}
              />
            );
          })}
        </TileGrid>
      ) : (
        <table className="ptable act-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Document</th>
              <th>By</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              const when = stamp(e.recorded);
              return (
                <tr key={e.id}>
                  <td className="acell-lead">{e.event}</td>
                  <td className="act-subject">{e.subject}</td>
                  <td className="sub">{e.by}</td>
                  <td className="sub" title={when.title}>
                    {when.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {events !== null && shown.length > 0 && (
        <div className="ptable-foot">
          <span>
            {shown.length} record{shown.length === 1 ? "" : "s"}
            {shown.length !== (events ?? []).length ? ` of ${(events ?? []).length}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
