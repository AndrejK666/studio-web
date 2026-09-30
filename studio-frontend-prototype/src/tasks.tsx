/**
 * Background work — the Platform surface over `studio-tasks` and
 * `studio-scheduler`.
 *
 * Two lists, because they answer different questions. **Runs** is "what has
 * this deployment been doing, and what went wrong" — the durable history that
 * replaced three in-memory registries. **Schedules** is "what fires on its
 * own", with the one control a person needs: run it now.
 *
 * Scope note: runs are tenant-scoped and this page reads the caller's own
 * tenant, which on the Platform surface is the platform root — where every
 * *scheduled* run lives. A repository import started inside an organization
 * belongs to that organization's tenant and is not listed here.
 */

import { useCallback, useEffect, useState } from "react";

import { api, type TaskRun, type TaskSchedule } from "./api";
import { DataTable, When, type PageRequest, type PageResult } from "./data-table";
import { errText } from "./format";
import { subscribeStudioEvents } from "./studio-events";

/** How often the list refreshes while something is still moving. */
const LIVE_POLL_MS = 4000;

const STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

/** Run state → the badge the rest of the prototype already uses. */
function stateBadge(state: string): string {
  switch (state) {
    case "succeeded":
      return "ok";
    case "running":
      return "syncing";
    case "failed":
      return "failed";
    case "cancelled":
      return "warn";
    default:
      return "neutral";
  }
}

/** The whole timestamp, for the details a run expands to. */
function when(iso?: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/** How long a run took, or has been going. */
function duration(run: TaskRun): string {
  if (!run.started_at) return "—";
  const from = new Date(run.started_at).getTime();
  const to = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
  const ms = to - from;
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * The one line worth showing per run: what it did, why it stopped, or where it
 * has got to — in that order. Same rule the backend's own poll endpoint uses.
 */
function headline(run: TaskRun): string {
  return run.summary || run.last_error || run.progress || "—";
}

export function BackgroundWork({ token }: { token: string; query?: string }) {
  const [schedules, setSchedules] = useState<TaskSchedule[] | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [taskTypes, setTaskTypes] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to read the page on screen again: a run moved, or time passed
  // while something on the page was still moving.
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);

  useEffect(() => {
    api.taskTypes(token).then(
      (page) => setTaskTypes(page.items),
      () => setTaskTypes([]),
    );
  }, [token]);

  const loadSchedules = useCallback(() => {
    setScheduleError(null);
    // The scheduler is optional — a deployment can run background work with
    // nothing firing on its own — so its absence is an empty list, not an error.
    api.schedules(token).then(
      (page) => setSchedules(page.items),
      () => setSchedules([]),
    );
  }, [token]);
  useEffect(() => loadSchedules(), [loadSchedules, tick]);

  // The backend pages, and narrows by state and task type. It has no text
  // search, so the list offers none rather than searching one page of it.
  const loadRuns = useCallback(
    async (req: PageRequest): Promise<PageResult<TaskRun>> => {
      try {
        const page = await api.taskRuns(token, {
          state: req.filters.state || undefined,
          taskType: req.filters.type || undefined,
          limit: req.limit,
          offset: req.offset,
        });
        setUnavailable(null);
        return { items: page.items, total: page.total ?? page.items.length };
      } catch (reason) {
        const text = errText(reason);
        // 503 means studio-tasks has no database in this deployment: a
        // configuration fact, said as one rather than as a failure.
        if (text.includes("not available in this deployment")) {
          setUnavailable(text);
          return { items: [], total: 0 };
        }
        throw reason;
      }
    },
    [token],
  );

  // studio-tasks announces every run transition on studio-events, so the list
  // refreshes when something happens. The poll stays as a floor while a run on
  // screen is still moving: it covers a deployment without the channel.
  useEffect(() => {
    let coalesce: ReturnType<typeof setTimeout> | null = null;
    const refreshSoon = () => {
      if (coalesce) return;
      coalesce = setTimeout(() => {
        coalesce = null;
        setTick((t) => t + 1);
      }, 300);
    };
    const unsubscribe = subscribeStudioEvents(token, {
      onEvent: (event) => {
        if (event.subject_type === "task_run") refreshSoon();
      },
    });
    const timer = live ? setInterval(() => setTick((t) => t + 1), LIVE_POLL_MS) : null;
    return () => {
      if (coalesce) clearTimeout(coalesce);
      if (timer) clearInterval(timer);
      unsubscribe();
    };
  }, [token, live]);

  async function act(run: TaskRun, what: "cancel" | "retry") {
    setError(null);
    if (what === "cancel") await api.cancelTaskRun(token, run.id);
    else await api.retryTaskRun(token, run.id);
    setTick((t) => t + 1);
  }

  const finished = (run: TaskRun) =>
    run.state === "succeeded" || run.state === "failed" || run.state === "cancelled";

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Background work</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Every run this deployment has queued, and the schedules that fire them. Runs survive a
            restart, are retried with backoff, and end up in a dead-letter table rather than
            nowhere.
          </p>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {unavailable && <div className="hint">{unavailable}</div>}

      <div className="card">
        <DataTable<TaskRun>
          list="runs"
          title="Runs"
          load={loadRuns}
          reloadKey={tick}
          onLoaded={(page) => setLive(page.items.some((r) => r.state === "queued" || r.state === "running"))}
          rowKey={(run) => run.id}
          rowLabel={(run) => `${run.task_type} ${run.id.slice(0, 8)}`}
          filters={[
            {
              id: "state",
              allLabel: "All states",
              kind: "chips",
              options: STATES.map((st) => ({ value: st, label: st })),
            },
            ...(taskTypes.length > 0
              ? [
                  {
                    id: "type",
                    allLabel: "Every task type",
                    kind: "select" as const,
                    options: taskTypes.map((t) => ({ value: t, label: t })),
                  },
                ]
              : []),
          ]}
          extra={live ? <span className="sub">live · refreshing</span> : null}
          empty={{ title: "Nothing has been queued yet." }}
          columns={[
            {
              id: "task",
              header: "Task",
              cell: (run) => (
                <>
                  <div className="pname plain">{run.task_type}</div>
                  <div className="sub">{run.id.slice(0, 8)}</div>
                </>
              ),
            },
            {
              id: "state",
              header: "State",
              cell: (run) => (
                <>
                  <span className={`badge ${stateBadge(run.state)}`}>{run.state}</span>
                  {run.cancel_requested && !finished(run) && (
                    <div className="sub" style={{ marginTop: 4 }}>
                      stop requested
                    </div>
                  )}
                </>
              ),
            },
            { id: "what", header: "What happened", cell: (run) => <span className="sub">{headline(run)}</span> },
            { id: "tries", header: "Tries", num: true, cell: (run) => run.attempts },
            { id: "took", header: "Took", cell: (run) => <span className="sub">{duration(run)}</span> },
            { id: "started", header: "Started", cell: (run) => <When iso={run.started_at ?? run.created_at} /> },
          ]}
          expand={(run) => (
            <div className="rows">
              <Detail label="Run id" value={run.id} />
              <Detail label="Requested by" value={run.requested_by} />
              {run.partition_key && <Detail label="Ordered with" value={run.partition_key} />}
              <Detail label="Created" value={when(run.created_at)} />
              <Detail label="Finished" value={when(run.finished_at)} />
              {run.progress && <Detail label="Last phase" value={run.progress} />}
              {run.last_error && <Detail label="Error" value={run.last_error} />}
              <Json label="Payload" value={run.payload} />
              {run.result && <Json label="Result" value={run.result} />}
            </div>
          )}
          actions={(run) => [
            ...(run.state === "failed" || run.state === "cancelled"
              ? [{ label: "Retry", onSelect: () => act(run, "retry") }]
              : []),
            ...(!finished(run)
              ? [
                  {
                    label: "Cancel",
                    disabled: run.cancel_requested,
                    danger: {
                      title: `Stop ${run.task_type} ${run.id.slice(0, 8)}?`,
                      body:
                        "A queued run will not start. A running one stops where its handler next checks — one that never checks runs to the end.",
                      confirmLabel: "Stop the run",
                    },
                    onSelect: () => act(run, "cancel"),
                  },
                ]
              : []),
          ]}
        />
      </div>

      <div className="card">
        <DataTable<TaskSchedule>
          list="schedules"
          urlPrefix="sch."
          title="Schedules"
          rows={schedules}
          error={scheduleError}
          onRetry={loadSchedules}
          rowKey={(sc) => sc.id}
          rowLabel={(sc) => sc.name}
          empty={{
            title: "Nothing is scheduled.",
            body:
              "Schedules are platform-level and fire under a database lock, so one deployment fires each instant once however many replicas are running.",
          }}
          columns={[
            {
              id: "name",
              header: "Schedule",
              compare: (a, b) => a.name.localeCompare(b.name),
              cell: (sc) => (
                <>
                  <div className="pname plain">{sc.name}</div>
                  {!sc.enabled && <span className="badge warn">disabled</span>}
                </>
              ),
            },
            { id: "type", header: "Runs", cell: (sc) => <span className="sub">{sc.task_type}</span> },
            {
              id: "cadence",
              header: "Cadence",
              cell: (sc) => (
                <span className="sub">
                  {sc.expression}
                  <div className="sub">
                    {sc.expression_kind} · {sc.timezone}
                  </div>
                </span>
              ),
            },
            {
              id: "policies",
              header: "Policies",
              cell: (sc) => (
                <span className="sub">
                  {sc.concurrency} · {sc.missed_policy}
                  {sc.missed_policy === "backfill" && ` (≤${sc.max_catch_up_runs})`}
                </span>
              ),
            },
            {
              id: "next",
              header: "Next",
              compare: (a, b) => Date.parse(a.next_run_at) - Date.parse(b.next_run_at),
              cell: (sc) => <When iso={sc.next_run_at} />,
            },
            { id: "last", header: "Last", cell: (sc) => <When iso={sc.last_fired_at} /> },
          ]}
          inline={(sc) => (
            <button
              className="ghost"
              onClick={() =>
                api.runScheduleNow(token, sc.id).then(
                  () => setTick((t) => t + 1),
                  (reason) => setError(errText(reason)),
                )
              }
            >
              Run now
            </button>
          )}
        />
      </div>

      {taskTypes.length > 0 && (
        <div className="card">
          <h2>What this deployment can run</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            One entry per registered handler. A task type missing from this list cannot run here
            because the gear that owns it is not linked into the assembly.
          </p>
          <div className="chipset">
            {taskTypes.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <li>
      <div className="grow">
        <div className="sub">{label}</div>
        <div className="name" style={{ fontWeight: 400, wordBreak: "break-word" }}>
          {value}
        </div>
      </div>
    </li>
  );
}

function Json({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <li>
      <div className="grow">
        <div className="sub">{label}</div>
        <pre
          style={{
            margin: "4px 0 0",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 12,
          }}
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      </div>
    </li>
  );
}
