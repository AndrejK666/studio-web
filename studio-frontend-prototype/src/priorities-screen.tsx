/* Priorities (prioritise.ts): pick the requirements to compare, give each an
 * Impact, take Confidence from what it rests on or correct it, give an effort
 * for Ease, and read the ICE score and the order it leads to. Every value
 * says where it comes from, an unknown stays unknown, a tie stays a tie. */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  confidenceFromBasis,
  easeFromEffort,
  ICE_LABEL,
  iceScore,
  orderItems,
  unknown,
  type Criterion,
  type IceCriterion,
  type IceInputs,
} from "./prioritise";
import type { SpecModelWrite } from "./api";
import { classify, REQUIREMENT_TYPE_LABEL } from "./requirement-types";
import type { SpecRequirement, SpecRequirements } from "./spec-model";

/** What a person entered for one item. */
interface Entry {
  impact?: number;
  confidence?: number;
  /** Person-weeks: "3", or a range "1.5-3". */
  effort?: string;
}

interface Saved {
  items: string[];
  entries: Record<string, Entry>;
}

const ORIGIN_LABEL: Record<Criterion["origin"], string> = {
  measured: "measured",
  estimated: "Studio's estimate",
  entered: "entered",
  unknown: "unknown",
};

const storeKey = (projectId: string) => `studio.priorities.${projectId}`;

function load(projectId: string): Saved {
  try {
    const raw = localStorage.getItem(storeKey(projectId));
    if (raw) return JSON.parse(raw) as Saved;
  } catch {
    // Private window or blocked storage: start empty.
  }
  return { items: [], entries: {} };
}

/** "3" or "1.5-3" as person-weeks; undefined when it is neither. */
function parseEffort(text: string | undefined): number | [number, number] | undefined {
  if (!text?.trim()) return undefined;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:[-–]\s*(\d+(?:[.,]\d+)?))?\s*$/.exec(text);
  if (!m) return undefined;
  const a = Number(m[1].replace(",", "."));
  return m[2] ? [a, Number(m[2].replace(",", "."))] : a;
}

/** The three criteria of one item: what was entered, else what Studio can
 *  propose, else unknown. */
function inputsOf(r: SpecRequirement, e: Entry): IceInputs {
  const effort = parseEffort(e.effort);
  return {
    impact: e.impact !== undefined ? { score: e.impact, origin: "entered", basis: "Entered by a person." } : unknown("Needs the expected contribution to the goal."),
    confidence: e.confidence !== undefined ? { score: e.confidence, origin: "entered", basis: "Entered by a person." } : confidenceFromBasis(r.basis),
    ease: effort !== undefined ? easeFromEffort(effort, `${e.effort} person-weeks, entered.`, "entered") : unknown("Needs an effort estimate in person-weeks."),
  };
}

export function PrioritiesScreen({
  read,
  projectId,
  onTrace,
  onConfirm,
}: {
  read: SpecRequirements | { error: string } | null;
  projectId: string;
  /** Propose the confirmed order as docs/priorities.md: versioned by the
   *  repository, reviewed like any change. */
  onConfirm?: (content: string) => Promise<SpecModelWrite>;
  /** Follow a requirement in the Requirements view. */
  onTrace: (id: string) => void;
}) {
  const [saved, setSaved] = useState<Saved>(() => load(projectId));
  const [adding, setAdding] = useState("");
  const [confirm, setConfirm] = useState<{ busy: boolean; done?: SpecModelWrite; error?: string }>({ busy: false });
  useEffect(() => {
    try {
      localStorage.setItem(storeKey(projectId), JSON.stringify(saved));
    } catch {
      // Not kept; the screen still works for this visit.
    }
  }, [saved, projectId]);

  const items = read && "items" in read ? read.items : [];
  const candidates = useMemo(
    () => items.filter((r) => {
      const c = classify(r);
      return c && (c.type === "functional" || c.type === "user");
    }),
    [items],
  );
  const byId = useMemo(() => new Map(items.map((r) => [r.id, r])), [items]);
  const chosen = saved.items.map((id) => byId.get(id)).filter((r): r is SpecRequirement => !!r);
  const scored = chosen.map((r) => {
    const inputs = inputsOf(r, saved.entries[r.id] ?? {});
    return { r, inputs, ice: iceScore(inputs) };
  });
  const ordering = orderItems(
    scored.map((s) => ({ id: s.r.id, score: s.ice.score ?? s.ice.range?.[0] ?? null })),
    new Map(),
  );
  const rank = new Map(ordering.order.map((id, n) => [id, n + 1]));
  const rows = [...scored].sort((a, b) => rank.get(a.r.id)! - rank.get(b.r.id)!);

  const setEntry = (id: string, patch: Partial<Entry>) =>
    setSaved((s) => ({ ...s, entries: { ...s.entries, [id]: { ...s.entries[id], ...patch } } }));
  const add = (ids: string[]) => setSaved((s) => ({ ...s, items: [...s.items, ...ids.filter((id) => !s.items.includes(id))] }));
  const remove = (id: string) => setSaved((s) => ({ ...s, items: s.items.filter((x) => x !== id) }));
  const q = adding.trim().toLowerCase();
  const matches = q ? candidates.filter((r) => !saved.items.includes(r.id) && `${r.id} ${r.title ?? ""}`.toLowerCase().includes(q)).slice(0, 8) : [];
  const num = (v: string) => (v.trim() === "" ? undefined : Math.min(10, Math.max(1, Math.round(Number(v)))));

  if (!read) return <div className="empty">Loading…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;

  return (
    <div className="pr">
      <p className="dm-howto">
        <b>Compare what to build first.</b> ICE: the mean of Impact, Confidence and Ease, each 1–10, higher is better.
        Each value says where it comes from; one nobody knows leaves the score incomplete rather than guessed. Order puts a
        prerequisite before what needs it, and a tie stays a tie.
      </p>
      <div className="card pr-add">
        <input type="search" placeholder="Add a functional or user requirement by id or title" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a requirement" />
        <button
          type="button"
          className="ghost"
          onClick={() => add(candidates.filter((r) => r.priority === "p1").map((r) => r.id))}
          title="Every functional and user requirement the documents mark p1"
        >
          Add all p1 ({candidates.filter((r) => r.priority === "p1").length})
        </button>
        {matches.length > 0 && (
          <ul className="pr-matches">
            {matches.map((r) => (
              <li key={r.id}>
                <button type="button" className="dm-link" onClick={() => add([r.id])}>
                  {r.title ?? r.id}
                </button>{" "}
                <code className="hint">{r.id}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="empty">Nothing to compare yet. Add the requirements to weigh against each other.</div>
      ) : (
        <div className="card pr-table" role="table" aria-label="Requirements by ICE">
          <div className="pr-row pr-head" role="row">
            <span>#</span>
            <span>Requirement</span>
            <span>Impact</span>
            <span>Confidence</span>
            <span>Effort, person-weeks → Ease</span>
            <span>ICE</span>
            <span />
          </div>
          {rows.map(({ r, inputs, ice }) => {
            const e = saved.entries[r.id] ?? {};
            const cell = (k: IceCriterion, field: ReactNode) => (
              <span className={`pr-cell pr-${inputs[k].origin}`} title={inputs[k].basis}>
                {field}
                <small>
                  {inputs[k].range ? `${inputs[k].range![0]}–${inputs[k].range![1]}` : (inputs[k].score ?? "?")} · {ORIGIN_LABEL[inputs[k].origin]}
                </small>
              </span>
            );
            return (
              <div key={r.id} className="pr-row" role="row">
                <span className="pr-rank">
                  {rank.get(r.id)}
                  {ordering.ties.has(r.id) && <small title="Same score as its neighbour: a tie, not a decision">tie</small>}
                </span>
                <span>
                  <button type="button" className="dm-link" onClick={() => onTrace(r.id)}>
                    {r.title ?? r.id}
                  </button>
                  <small className="hint">
                    {REQUIREMENT_TYPE_LABEL[classify(r)!.type]} · {r.priority ?? "no mark"} · <code>{r.id}</code>
                  </small>
                </span>
                {cell(
                  "impact",
                  <input type="number" min={1} max={10} aria-label={`${ICE_LABEL.impact} of ${r.id}`} value={e.impact ?? ""} onChange={(ev) => setEntry(r.id, { impact: num(ev.target.value) })} />,
                )}
                {cell(
                  "confidence",
                  <input
                    type="number"
                    min={1}
                    max={10}
                    aria-label={`${ICE_LABEL.confidence} of ${r.id}`}
                    placeholder={inputs.confidence.origin === "estimated" ? String(inputs.confidence.score) : ""}
                    value={e.confidence ?? ""}
                    onChange={(ev) => setEntry(r.id, { confidence: num(ev.target.value) })}
                  />,
                )}
                {cell(
                  "ease",
                  <input type="text" aria-label={`Effort of ${r.id}`} placeholder="e.g. 3 or 1.5-3" value={e.effort ?? ""} onChange={(ev) => setEntry(r.id, { effort: ev.target.value })} />,
                )}
                <span className="pr-score">
                  {ice.score !== null ? ice.score : ice.range ? `${ice.range[0]}–${ice.range[1]}` : "—"}
                  {ice.missing.length > 0 && <small>needs {ice.missing.map((k) => ICE_LABEL[k]).join(", ")}</small>}
                </span>
                <button type="button" className="ghost" onClick={() => remove(r.id)} aria-label={`Take ${r.id} out of the comparison`}>
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      {rows.length > 0 && onConfirm && (
        <div className="dm-actions">
          <button
            type="button"
            className="primary"
            disabled={confirm.busy}
            onClick={() => {
              setConfirm({ busy: true });
              const lines = [
                "---",
                "type: material",
                "---",
                "",
                "# Priorities",
                "",
                "<!-- Confirmed in Studio. ICE: the mean of Impact, Confidence and Ease, each 1–10. -->",
                "",
                "| # | Requirement | Impact | Confidence | Ease | ICE |",
                "|---|---|---|---|---|---|",
                ...rows.map(({ r, inputs, ice }) => {
                  const v = (k: IceCriterion) =>
                    `${inputs[k].range ? `${inputs[k].range![0]}–${inputs[k].range![1]}` : (inputs[k].score ?? "unknown")} (${ORIGIN_LABEL[inputs[k].origin]})`;
                  const score = ice.score ?? (ice.range ? `${ice.range[0]}–${ice.range[1]}` : "incomplete");
                  return `| ${rank.get(r.id)}${ordering.ties.has(r.id) ? " (tie)" : ""} | ${(r.title ?? r.id).replace(/\|/g, "\\|")} \`${r.id}\` | ${v("impact")} | ${v("confidence")} | ${v("ease")} | ${score} |`;
                }),
                "",
              ];
              onConfirm(lines.join("\n"))
                .then((done) => setConfirm({ busy: false, done }))
                .catch((e: unknown) => setConfirm({ busy: false, error: e instanceof Error ? e.message : String(e) }));
            }}
            title="Write this order to docs/priorities.md as a pull request: a confirmed, versioned snapshot"
          >
            {confirm.busy ? "Proposing…" : "Confirm as docs/priorities.md"}
          </button>
          {confirm.done && (
            <span className="dm-saved">
              ✓ Proposed{" "}
              {confirm.done.pr_url ? (
                <a href={confirm.done.pr_url} target="_blank" rel="noreferrer">
                  as a pull request
                </a>
              ) : (
                <>on {confirm.done.branch}</>
              )}
            </span>
          )}
          {confirm.error && <span className="error-inline">{confirm.error}</span>}
        </div>
      )}
      {rows.length > 0 && (
        <p className="hint">
          The working set is kept in this browser; a confirmed order is a document in the repository. Confidence starts from what each requirement
          rests on — an assumption is a weak claim, a citation indirect evidence — and is yours to correct with what was observed.
        </p>
      )}
    </div>
  );
}
