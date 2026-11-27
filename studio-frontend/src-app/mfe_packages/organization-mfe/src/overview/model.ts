/* The organization's overview: what its leaders ask of it, in their words.
 *
 * The rules — which connection is refused, what is stuck, whose spend it is,
 * which workspace is worst — are the server's (`studio-backend/src/
 * organizations/overview.rs`, one request). A kit's block comes in the kit's
 * own words (`say`); what stays here is every word of the organization's own:
 * its needs, its people and its workspaces, decided once and tested. */

import type { BlockDetails, BlockLink, Line, OrgNeed, OrgOverview, OrgReason, OrgWorkspace, Words } from "./types";

/** Where one of the organization's own rows leads: a screen of the shell. */
export type NeedTarget = "connectors" | "projects" | "tasks" | "people";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Whether the answer was computed with `kit` installed: kits the server could not read count as yes. */
export function hasKit(o: Pick<OrgOverview, "kits">, kit: string): boolean {
  return o.kits == null || o.kits.includes(kit);
}

/** "+23%", "−5%", or "new" when nothing was spent before. */
export function growthText(current: number, previous: number): string {
  if (previous <= 0) return current > 0 ? "new" : "—";
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct > 0 ? `+${pct}%` : pct < 0 ? `−${-pct}%` : "±0%";
}

/* ── A kit's words ────────────────────────────────────────────────────────── */

/** The words in `language`, else its base language, else English. */
export function wordsIn(words: Words, language: string): string {
  return words[language] ?? words[language.split("-")[0]] ?? words.en ?? Object.values(words)[0] ?? "";
}

export interface SayOptions {
  language: string;
  /** A sum of money, in the reader's language. */
  money: (value: number, currency: string) => string;
  /** What an unknown figure is said as. */
  unknown: string;
}

/** A kit's line with its arguments filled in: money and counts formatted
 *  here, an unknown figure said as unknown, never as zero. */
export function say(line: Line, o: SayOptions): string {
  return wordsIn(line.text, o.language).replace(/\{(\w+)\}/g, (whole, name: string) => {
    const arg = line.args[name];
    if (!arg) return whole;
    if (arg.kind === "text") return arg.text ?? o.unknown;
    if (arg.value === null || arg.value === undefined) return o.unknown;
    return arg.kind === "money" ? o.money(arg.value, arg.currency || "USD") : String(arg.value);
  });
}

/* ── The organization's own needs ─────────────────────────────────────────── */

/** One of the organization's own needs: what is wrong, and where it is fixed. */
export function needText(n: OrgNeed): { title: string; detail: string; target: NeedTarget } {
  switch (n.kind) {
    case "connection": {
      const shown = n.projects.slice(0, 3).join(", ") + (n.projects.length > 3 ? "…" : "");
      return {
        title: `A ${n.provider ?? "git"} connection is refused (${n.status ?? "401"})`,
        detail: n.projects.length
          ? `${plural(n.projects.length, "project", "projects")} cannot sync: ${shown}`
          : `${plural(n.repos ?? 0, "repository", "repositories")} cannot sync`,
        target: "connectors",
      };
    }
    case "runs":
      return {
        title: `${plural(n.runs ?? 0, "background run", "background runs")} failed`,
        detail: "not a refused connection; the runs list says what",
        target: "tasks",
      };
  }
}

/** What is wrong with a project, in a few words. */
export function reasonText(r: OrgReason, stuckDays: number): string {
  const v = Math.round(r.value ?? 0);
  switch (r.kind) {
    case "refused":
      return "its repository connection is refused";
    case "specs_failing":
      return `${v} ${v === 1 ? "spec fails" : "specs fail"}`;
    case "stuck":
      return `${plural(v, "pull request waits", "pull requests wait")} over ${stuckDays} days`;
    case "spend_grows":
      return `spend +${Math.round((r.value ?? 0) * 100)}%`;
    case "quiet":
      return `quiet for ${v} days`;
  }
}

export function reasonLine(reasons: readonly OrgReason[], stuckDays: number): string {
  return reasons.map((r) => reasonText(r, stuckDays)).join(" · ");
}

/** A workspace's one line: its worst project and why, and how many more. */
export function workspaceLine(ws: OrgWorkspace, stuckDays: number): string {
  const troubled = ws.projects.filter((p) => p.reasons.length > 0);
  if (troubled.length === 0) return `${plural(ws.projects.length, "project", "projects")}, nothing wrong`;
  const more = troubled.length - 1;
  return (
    `${troubled[0].name}: ${reasonLine(troubled[0].reasons, stuckDays)}` +
    (more > 0 ? ` · ${plural(more, "more project", "more projects")}` : "")
  );
}

/** Days without activity: "today", "3 d", or "—" when unknown. */
export function quietText(days: number | null): string {
  return days === null ? "—" : days === 0 ? "today" : `${days} d`;
}

/** The headline over the needs. */
export function needsHeadline(n: number): string {
  return n === 0 ? "Nothing needs you" : `${n} ${n === 1 ? "thing needs" : "things need"} you`;
}

/* ── Needs attention: one list, grouped ───────────────────────────────────── */

/** A row of "Needs attention" for the others: one sentence, one action. */
export interface AttentionRow {
  key: string;
  sentence: string;
  /** What follows the sentence, quieter: where, or how much. */
  detail?: string;
  tone: "danger" | "warn" | "info";
  /** Where it is answered: one of the shell's screens (`target`) or a kit's (`link`). */
  action: { label: string; target?: NeedTarget; link?: BlockLink } | null;
  /** What a kit's need is about, folded out instead of its action. */
  details?: BlockDetails | null;
}

const ACTION: Record<OrgNeed["kind"], string> = {
  connection: "Fix the connection",
  runs: "Open runs",
};

const toneOf = (tone: string): AttentionRow["tone"] => (tone === "danger" || tone === "info" ? tone : "warn");

/** What needs the organization rather than the reader, from the overview:
 *  refused connections, then every kit's block's needs in the blocks' order,
 *  then failed runs and the idle people -- each said once. */
export function othersAttention(o: OrgOverview, words: SayOptions): AttentionRow[] {
  const own = (n: OrgNeed, i: number): AttentionRow => {
    const t = needText(n);
    return {
      key: `need:${n.kind}:${i}`,
      sentence: t.title,
      detail: t.detail,
      tone: n.tone === "danger" ? "danger" : "warn",
      action: { label: ACTION[n.kind], target: t.target },
    };
  };
  const rows: AttentionRow[] = o.needs.flatMap((n, i) => (n.kind === "connection" ? [own(n, i)] : []));
  for (const block of o.blocks ?? [])
    for (const n of block.needs)
      rows.push({
        key: `${block.kit}/${block.id}:${n.key}`,
        sentence: say(n.sentence, words),
        detail: n.detail ? say(n.detail, words) : undefined,
        tone: toneOf(n.tone),
        action: n.action ? { label: wordsIn(n.action.label, words.language), link: n.action } : null,
        details: n.details,
      });
  rows.push(...o.needs.flatMap((n, i) => (n.kind === "connection" ? [] : [own(n, i)])));
  const idle = o.people.idle ?? [];
  if (idle.length > 0) {
    const names = idle.slice(0, 3).map((p) => p.name ?? `Person ${p.person_id.slice(0, 8)}`);
    rows.push({
      key: "idle",
      sentence: `${plural(idle.length, "person has", "people have")} been idle for 30 days`,
      detail: names.join(", ") + (idle.length > 3 ? ` and ${idle.length - 3} more` : ""),
      tone: "info",
      action: { label: "Open People", target: "people" },
    });
  }
  return rows;
}

/** The overview header's one line: how much needs attention. */
export function attentionStatus(you: number | null, others: number): string {
  const total = (you ?? 0) + others;
  if (total === 0) return you === null ? "Reading what needs attention…" : "Nothing needs attention";
  return `${total} ${total === 1 ? "thing needs" : "things need"} attention`;
}

/* ── Workspaces ───────────────────────────────────────────────────────────── */

/** A workspace's line in the list, said by what is in it rather than the
 *  word "workspace" again: its projects by name, and whether it manages
 *  itself. A workspace carries no description of its own. */
export function workspaceDescription(projects: readonly string[] | undefined, selfManaged: boolean): string {
  const lead = selfManaged ? "Self-managed" : "";
  if (projects === undefined) return lead;
  const names =
    projects.length === 0
      ? "no projects yet"
      : projects.slice(0, 3).join(", ") + (projects.length > 3 ? ` and ${projects.length - 3} more` : "");
  if (lead) return `${lead} · ${names}`;
  return projects.length === 0 ? "No projects yet" : names;
}

/** A workspace page's status line: "3 projects · 213 findings". Unknown counts
 *  say nothing rather than 0. */
export function workspaceStatus(projects: number | null, findings: number | null): string {
  const parts: string[] = [];
  if (projects !== null) parts.push(plural(projects, "project", "projects"));
  if (findings !== null) parts.push(plural(findings, "finding", "findings"));
  return parts.join(" · ");
}
