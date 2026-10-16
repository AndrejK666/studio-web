/* The need and the hypotheses (need-view.ts): who has which problem, what
 * they want, what the materials propose — and which benefits someone expects,
 * each a hypothesis with a way to check it and where it stands. Read off the
 * same facts and passages as the model; every line opens its source. */
import { useState } from "react";

import type { SpecModelWrite } from "./api";
import { FactRow } from "./domain-model-screens";
import {
  CHECK_METHOD_LABEL,
  CHECK_METHOD_WHAT,
  EVIDENCE_LABEL,
  hypothesesOf,
  needGaps,
  needsByRole,
  needDocument,
  type CheckMethod,
  type EvidenceState,
} from "./need-view";
import type { SpecModelFact } from "./spec-model";

type OpenFile = ((path: string) => void) | undefined;

export function NeedsScreen({
  facts,
  onOpenFile,
  accepted,
  onAddMaterial,
  onPropose,
}: {
  facts: SpecModelFact[];
  onOpenFile: OpenFile;
  /** Whether a member accepted a reading. */
  accepted: (f: SpecModelFact) => boolean;
  /** Keep a pasted material in the project and read it at once. */
  onAddMaterial?: (title: string, content: string) => Promise<void>;
  /** Propose the accepted need as docs/discovery.md. */
  onPropose?: (content: string) => Promise<SpecModelWrite>;
}) {
  const roles = needsByRole(facts);
  const gaps = needGaps(facts);
  const any = roles.some((r) => r.problems.length + r.outcomes.length + r.ideas.length + r.scenarios.length > 0);
  const [adding, setAdding] = useState<{ title: string; content: string } | null>(null);
  const [state, setState] = useState<{ busy: boolean; error?: string; done?: SpecModelWrite; added?: string }>({ busy: false });
  const run = async (act: () => Promise<SpecModelWrite | void>, added?: string) => {
    setState({ busy: true });
    try {
      const done = await act();
      setState({ busy: false, done: done || undefined, added });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const acceptedNeed = facts.filter((f) => accepted(f));
  const intake = (
    <section className="card nd-intake">
      {adding ? (
        <>
          <input
            type="text"
            placeholder="What it is: Interview with an operator, 2026-10-12"
            value={adding.title}
            onChange={(e) => setAdding({ ...adding, title: e.target.value })}
            aria-label="Material title"
          />
          <textarea rows={8} placeholder="Paste the interview, the request or the report as it is." value={adding.content} onChange={(e) => setAdding({ ...adding, content: e.target.value })} />
          <div className="dm-actions">
            <button
              type="button"
              className="primary"
              disabled={state.busy || !adding.title.trim() || !adding.content.trim()}
              onClick={() => void run(async () => {
                await onAddMaterial!(adding.title.trim(), adding.content);
                setAdding(null);
              }, adding.title.trim())}
            >
              {state.busy ? "Adding…" : "Add and read it"}
            </button>
            <button type="button" className="ghost" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="dm-actions">
          {onAddMaterial && (
            <button type="button" className="ghost" onClick={() => setAdding({ title: "", content: "" })}>
              Add material
            </button>
          )}
          {onPropose && (
            <button
              type="button"
              className="primary"
              disabled={state.busy || acceptedNeed.length === 0}
              title={acceptedNeed.length ? "Write what was accepted to docs/discovery.md, as a pull request" : "Accept readings first: only what a person accepted is written"}
              onClick={() => void run(() => onPropose(needDocument(acceptedNeed)))}
            >
              Accept the need ({acceptedNeed.filter((f) => f.kind !== "role").length} readings)
            </button>
          )}
          <span className="hint">Materials are read as soon as they are added, on your model key.</span>
        </div>
      )}
      {state.added && <span className="dm-saved">✓ “{state.added}” added; it is being read.</span>}
      {state.done && (
        <span className="dm-saved">
          ✓ Proposed{" "}
          {state.done.pr_url ? (
            <a href={state.done.pr_url} target="_blank" rel="noreferrer">
              as a pull request
            </a>
          ) : (
            <>on {state.done.branch}</>
          )}
        </span>
      )}
      {state.error && <span className="error-inline">{state.error}</span>}
    </section>
  );
  if (!any)
    return (
      <div className="nd">
        {intake}
        <div className="empty">
          No problems, goals or ideas read yet. They come from the project&apos;s materials — interviews, requests, a
          PRD&apos;s problem statement — once a build reads them with the current extractor.
        </div>
      </div>
    );
  return (
    <div className="nd">
      <p className="dm-howto">
        <b>What the need is.</b> Who has which problem, what they want to reach and what the materials propose, each with
        the passage it comes from. Accept or reject each reading; a link nobody stated is shown as a gap, never filled in.
        What you accept becomes the need, proposed as a document.
      </p>
      {intake}
      {gaps.length > 0 && (
        <section className="card dm-rproblems" aria-label="Gaps in the need">
          <div className="dm-h">Gaps</div>
          {gaps.map((g, i) => (
            <div key={i} className="dm-rproblem">
              <span className="dm-pill dm-warn">
                {g.kind === "problem-without-idea" ? "No solution" : g.kind === "idea-without-problem" ? "No problem" : "No need"}
              </span>
              <div>
                <b>{g.title}.</b>
                {g.fact && (
                  <div className="dm-rwhere">
                    {g.fact.source.path}
                    {g.fact.source.line_start ? `:${g.fact.source.line_start}` : ""}
                  </div>
                )}
              </div>
            </div>
          ))}
        </section>
      )}
      {roles.map((r) => (
        <section key={r.role || "—"} className="card nd-role">
          <div className="dm-h">{r.role || "No role named"}</div>
          {(
            [
              ["Problems", r.problems],
              ["Wants to reach", r.outcomes],
              ["Ideas", r.ideas],
              ["Scenarios", r.scenarios],
            ] as const
          ).map(([title, list]) =>
            list.length ? (
              <div key={title} className="sm-kind">
                <h3>{title}</h3>
                {list.map((f, i) => (
                  <div key={i}>
                    <b className="nd-subject">{f.subject}</b>
                    <FactRow fact={f} onOpenFile={onOpenFile} />
                  </div>
                ))}
              </div>
            ) : null,
          )}
        </section>
      ))}
    </div>
  );
}

export function HypothesesScreen({
  facts,
  stateOf,
  onEvidence,
  onOpenFile,
}: {
  facts: SpecModelFact[];
  /** Where a hypothesis stands, as members recorded it. */
  stateOf: (f: SpecModelFact) => EvidenceState;
  onEvidence?: (f: SpecModelFact, state: EvidenceState) => Promise<void>;
  onOpenFile: OpenFile;
}) {
  const list = hypothesesOf(facts);
  const [method, setMethod] = useState<Record<number, CheckMethod>>({});
  if (list.length === 0)
    return (
      <div className="empty">
        No expected benefits read yet. A hypothesis comes from what someone expects a solution to do for someone — “the search
        will let operators find a request in seconds” — once a build reads it with the current extractor.
      </div>
    );
  const counts = list.reduce<Record<EvidenceState, number>>(
    (c, h) => ({ ...c, [stateOf(h.fact)]: c[stateOf(h.fact)] + 1 }),
    { unchecked: 0, supports: 0, contradicts: 0, insufficient: 0 },
  );
  return (
    <div className="nd">
      <p className="dm-howto">
        <b>Check what is expected, not what is written.</b> Each benefit someone expects is a hypothesis: which solution,
        for whom, with what effect. Studio proposes how to check it; what the check found is yours to record. Accepting the
        wording is not validating it, and an unchecked hypothesis stops nothing.
      </p>
      <div className="dm-filters">
        {(Object.keys(EVIDENCE_LABEL) as EvidenceState[]).map((s) => (
          <span key={s} className={`chip nd-ev-${s}`}>
            {EVIDENCE_LABEL[s]} <span className="chip-n">{counts[s]}</span>
          </span>
        ))}
      </div>
      {list.map((h, i) => {
        const m = method[i] ?? h.method;
        const state = stateOf(h.fact);
        return (
          <article key={i} className={`card dm-item nd-hyp nd-ev-${state}`}>
            <header>
              <span className="dm-pill dm-warn">{EVIDENCE_LABEL[state]}</span>
              <b>{h.solution || "A solution not named"}</b>
            </header>
            <div className="nd-claim">
              <span>
                For <b>{h.role || <i>a role not named</i>}</b>
              </span>
              <span>
                expected: <b>{h.effect || <i>an effect not stated</i>}</b>
              </span>
            </div>
            <FactRow fact={h.fact} onOpenFile={onOpenFile} />
            <div className="nd-check">
              <label>
                Check by{" "}
                <select value={m} onChange={(e) => setMethod((x) => ({ ...x, [i]: e.target.value as CheckMethod }))}>
                  {(Object.keys(CHECK_METHOD_LABEL) as CheckMethod[]).map((k) => (
                    <option key={k} value={k}>
                      {CHECK_METHOD_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <span className="hint">{CHECK_METHOD_WHAT[m]}</span>
            </div>
            {onEvidence && (
              <div className="dm-actions">
                <span className="hint">What checking found:</span>
                {(["supports", "contradicts", "insufficient", "unchecked"] as EvidenceState[]).map((s) => (
                  <button key={s} type="button" className={state === s ? "primary" : "ghost"} aria-pressed={state === s} onClick={() => void onEvidence(h.fact, s)}>
                    {EVIDENCE_LABEL[s]}
                  </button>
                ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
