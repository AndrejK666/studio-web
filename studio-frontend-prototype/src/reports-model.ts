// The reports a Studio draws, as `studio-reports` serves them
// (`studio-backend/src/reports`), and the little logic the Reports screen
// needs that is worth testing without a screen: what a save sends, which
// schedule keeps a report current, and how a source's state reads.

import type { TaskSchedule } from "./api";

export interface PlanSnapshot {
  /** `owner/repo:path@ref`, or `upload`. */
  from: string;
  sha: string | null;
  read_at: string;
  size: number;
}

export interface ReportRefresh {
  at: string;
  sync_run: string | null;
  error: string | null;
}

export interface ReportSource {
  report: string;
  connection_id: string | null;
  plan_file: string | null;
  plan_uploaded: boolean;
  board: string | null;
  roots: string[];
  consumers: Record<string, string>;
  snapshot: PlanSnapshot | null;
  last_refresh: ReportRefresh | null;
}

export interface Report {
  id: string;
  title: string;
  description: string;
  definition: string;
  sheets: string[];
  definition_error: string | null;
  source: ReportSource;
}

/** What `PUT …/reports/{id}/source` takes: a field left out keeps its value. */
export interface ReportSourceInput {
  connection_id?: string | null;
  plan_file?: string;
  plan_yaml?: string;
  board?: string;
  roots?: string[];
  consumers?: Record<string, string>;
}

/** What the Source form edits. */
export interface SourceDraft {
  connectionId: string;
  planFile: string;
  /** Text of a file the person picked, not yet saved; `""` clears an upload. */
  planYaml: string | null;
  board: string;
  roots: string;
  consumers: string;
}

export function draftOf(s: ReportSource): SourceDraft {
  return {
    connectionId: s.connection_id ?? "",
    planFile: s.plan_file ?? "",
    planYaml: null,
    board: s.board ?? "",
    roots: s.roots.join(" "),
    consumers: Object.entries(s.consumers)
      .map(([k, v]) => `${k}=${v}`)
      .join(", "),
  };
}

/** `A=Acronis, C=Constructor` → `{ A: "Acronis", C: "Constructor" }`. */
export function parseConsumers(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[,;\n]/)) {
    const [k, ...v] = part.split("=");
    const key = k?.trim();
    const value = v.join("=").trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/** The body a save sends: everything the form shows, the upload only when
 *  the person picked or cleared one. */
export function inputOf(d: SourceDraft): ReportSourceInput {
  const input: ReportSourceInput = {
    connection_id: d.connectionId || null,
    plan_file: d.planFile.trim(),
    board: d.board.trim(),
    roots: d.roots.split(/[\s,;]+/).filter(Boolean),
    consumers: parseConsumers(d.consumers),
  };
  if (d.planYaml !== null) input.plan_yaml = d.planYaml;
  return input;
}

/** The task type a schedule targets to keep a report current. */
export const REFRESH_TASK = "reports.refresh";

/** Hourly, on the hour. */
export const HOURLY = "0 * * * *";

/** The schedule that refreshes this report, if there is one. */
export function scheduleOf(schedules: TaskSchedule[], report: string): TaskSchedule | undefined {
  return schedules.find(
    (s) => s.task_type === REFRESH_TASK && (s.payload as { report?: unknown })?.report === report,
  );
}

/** The body that creates one. */
export function newSchedule(report: string) {
  return {
    name: `Refresh the ${report} report`,
    task_type: REFRESH_TASK,
    payload: { report },
    expression_kind: "cron",
    expression: HOURLY,
    timezone: "UTC",
    // A refresh still running when the next is due is let finish.
    concurrency: "forbid",
    missed_policy: "skip",
    enabled: true,
  };
}

export type SourceState =
  | { kind: "empty" }
  | { kind: "unread"; what: string }
  | { kind: "failed"; error: string }
  | { kind: "ready"; from: string; at: string };

/** Where a source stands, in one line's worth. */
export function stateOf(s: ReportSource): SourceState {
  if (s.last_refresh?.error) return { kind: "failed", error: s.last_refresh.error };
  if (s.snapshot) return { kind: "ready", from: s.snapshot.from, at: s.snapshot.read_at };
  if (s.plan_file) return { kind: "unread", what: s.plan_file };
  if (s.board) return { kind: "unread", what: s.board };
  return { kind: "empty" };
}

export function stateText(st: SourceState): string {
  switch (st.kind) {
    case "empty":
      return "Not configured: name the plan file (it can name the board itself), or upload it.";
    case "unread":
      return `${st.what} has not been read yet — refresh to read it and sync the board.`;
    case "failed":
      return `The last refresh failed: ${st.error}`;
    case "ready":
      return `Plan from ${st.from === "upload" ? "an uploaded file" : st.from}, read ${st.at.slice(0, 16).replace("T", " ")}.`;
  }
}
