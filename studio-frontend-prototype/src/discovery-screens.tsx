/* The need and the hypotheses (need-view.ts): who has which problem, what
 * they want, what the materials propose — and which benefits someone expects,
 * each a hypothesis with a way to check it and where it stands. Read off the
 * same facts and passages as the model; every line opens its source. */
import { useState } from "react";

import type { SpecModelWrite } from "./api";
import { obligations, type Obligation } from "./behaviour";
import { conflicts, describe as sayRule, readRule } from "./rule-checks";
import { FactRow } from "./domain-model-screens";
import {
  CHECK_METHOD_LABEL,
  CHECK_METHOD_WHAT,
  EVIDENCE_LABEL,
  hypothesesOf,
  needGaps,
  needsByRole,
  needDocument,
  unlinkedRequirements,
  type CheckMethod,
  type EvidenceState,
} from "./need-view";
import type { SpecModelFact, SpecRequirement } from "./spec-model";

type OpenFile = ((path: string) => void) | undefined;

export function NeedsScreen({
  facts,
  onOpenFile,
  accepted,
  onAddMaterial,
  onPropose,
  requirements,
}: {
  facts: SpecModelFact[];
  onOpenFile: OpenFile;
  /** Whether a member accepted a reading. */
  accepted: (f: SpecModelFact) => boolean;
  /** Keep a pasted material in the project and read it at once. */
  onAddMaterial?: (title: string, content: string) => Promise<void>;
  /** Propose the accepted need as docs/discovery.md. */
  onPropose?: (content: string) => Promise<SpecModelWrite>;
  /** The functional and user requirements, to say which trace to no need. */
  requirements?: SpecRequirement[];
}) {
  const roles = needsByRole(facts);
  const unlinked = unlinkedRequirements(requirements ?? [], facts);
  const gaps = [
    ...needGaps(facts),
    ...(unlinked.length
      ? [{ kind: "idea-without-problem" as const, title: `${unlinked.length} requirement${unlinked.length === 1 ? "" : "s"} name no problem or goal of the need — ${unlinked.slice(0, 3).map((r) => r.id).join(", ")}${unlinked.length > 3 ? "…" : ""}` }]
      : []),
  ];
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

/** Bounded behaviour coverage: what the specification must say about each
 *  action in each state, answered by a passage, asked, or excluded with a
 *  reason. Nothing here is a release gate. */
export function BehaviourScreen({
  facts,
  decisionOf,
  onExclude,
  onOpenFile,
}: {
  facts: SpecModelFact[];
  decisionOf: (key: string) => { state: string; note: string | null } | undefined;
  /** Record a reason an obligation does not apply, or `null` to ask it again. */
  onExclude?: (o: Obligation, reason: string | null) => Promise<void>;
  onOpenFile: OpenFile;
}) {
  const list = obligations(facts);
  const [reason, setReason] = useState<Record<string, string>>({});
  if (list.length === 0)
    return (
      <div className="empty">
        No behaviour questions yet. They come from an entity&apos;s states (a lifecycle that lists them) and the actions roles
        take on it, once a build reads them with the current extractor.
      </div>
    );
  const excluded = list.filter((o) => decisionOf(o.key)?.state === "excluded");
  const answered = list.filter((o) => o.answer && !excluded.includes(o));
  const open = list.filter((o) => !o.answer && !excluded.includes(o));
  const row = (o: Obligation) => (
    <div key={o.key} className="nd-ob">
      <div>
        May <b>{o.role || "someone"}</b> {o.action} a <b>{o.entity}</b> that is <b>{o.state}</b>?
      </div>
      {o.answer ? (
        <FactRow fact={o.answer} onOpenFile={onOpenFile} />
      ) : decisionOf(o.key)?.state === "excluded" ? (
        <div className="hint">
          Excluded: {decisionOf(o.key)?.note}{" "}
          {onExclude && (
            <button type="button" className="dm-link" onClick={() => void onExclude(o, null)}>
              ask again
            </button>
          )}
        </div>
      ) : (
        onExclude && (
          <div className="dm-actions">
            <input
              type="text"
              placeholder="Why it does not apply"
              value={reason[o.key] ?? ""}
              onChange={(e) => setReason((r) => ({ ...r, [o.key]: e.target.value }))}
              aria-label="Reason to exclude"
            />
            <button type="button" className="ghost" disabled={!reason[o.key]?.trim()} onClick={() => void onExclude(o, reason[o.key].trim())}>
              Exclude with this reason
            </button>
          </div>
        )
      )}
    </div>
  );
  return (
    <div className="nd">
      <p className="dm-howto">
        <b>What the specification must say about behaviour.</b> For each action roles take on a thing and each state it goes
        through: may it happen then? A question is answered only where one passage names both; otherwise answer it in the
        documents, or exclude it with a reason. None of this blocks a build.
      </p>
      <div className="dm-filters">
        <span className="chip">
          Open <span className="chip-n">{open.length}</span>
        </span>
        <span className="chip">
          Answered <span className="chip-n">{answered.length}</span>
        </span>
        <span className="chip">
          Excluded <span className="chip-n">{excluded.length}</span>
        </span>
      </div>
      {open.length > 0 && (
        <section className="card nd-role">
          <div className="dm-h">Not answered</div>
          {open.map(row)}
        </section>
      )}
      {answered.length > 0 && (
        <section className="card nd-role">
          <div className="dm-h">Answered by a passage</div>
          {answered.map(row)}
        </section>
      )}
      {excluded.length > 0 && (
        <section className="card nd-role">
          <div className="dm-h">Excluded</div>
          {excluded.map(row)}
        </section>
      )}
    </div>
  );
}

/** The rules a member confirmed, read into a precise form, and checked
 *  against each other: a conflict with the two passages that witness it,
 *  none among what was read, incomplete, or a rule this check has no form
 *  for. Unconfirmed rules give no verdict. */
export function RulesScreen({
  facts,
  accepted,
  onOpenFile,
}: {
  facts: SpecModelFact[];
  accepted: (f: SpecModelFact) => boolean;
  onOpenFile: OpenFile;
}) {
  const all = facts.filter((f) => f.kind === "constraint" && f.status === "active");
  const confirmed = all.filter(accepted).map(readRule);
  const pending = all.length - confirmed.length;
  const found = conflicts(confirmed);
  const read = confirmed.filter((r) => r.outcome === "read");
  const incomplete = confirmed.filter((r) => r.outcome === "incomplete");
  const unsupported = confirmed.filter((r) => r.outcome === "unsupported");
  return (
    <div className="nd">
      <p className="dm-howto">
        <b>Check the rules against each other.</b> Only rules a member accepted are checked. Each is read into a precise
        form — who may do what, a number that bounds something — shown so you can say it is what the rule means. Two that
        cannot both hold are a conflict, shown with both passages.
      </p>
      <div className="dm-filters">
        <span className={`chip${found.length ? " nd-ev-contradicts" : ""}`}>
          Conflicts <span className="chip-n">{found.length}</span>
        </span>
        <span className="chip">
          Read <span className="chip-n">{read.length}</span>
        </span>
        <span className="chip">
          Incomplete <span className="chip-n">{incomplete.length}</span>
        </span>
        <span className="chip">
          Unsupported <span className="chip-n">{unsupported.length}</span>
        </span>
        <span className="chip">
          Not accepted yet <span className="chip-n">{pending}</span>
        </span>
      </div>
      {confirmed.length === 0 && (
        <div className="empty">
          No rule is accepted yet. Accept the constraints you agree with on the model map&apos;s cards; only those are
          checked, so an unconfirmed reading never becomes a verdict.
        </div>
      )}
      {found.length > 0 && (
        <section className="card nd-role">
          <div className="dm-h">Cannot both hold</div>
          {found.map((x, i) => (
            <article key={i} className="nd-ob">
              <b>{x.witness}</b>
              <FactRow fact={x.a.fact} onOpenFile={onOpenFile} />
              <FactRow fact={x.b.fact} onOpenFile={onOpenFile} />
            </article>
          ))}
        </section>
      )}
      {confirmed.length > 0 && found.length === 0 && (
        <div className="hint">No conflict among the {read.length} rules read. Rules it could not read are listed below.</div>
      )}
      {read.length > 0 && (
        <section className="card nd-role">
          <div className="dm-h">Read as</div>
          {read.map((r, i) => (
            <div key={i} className="nd-ob">
              <span>
                Studio reads it as: <b>{sayRule(r.reading!)}</b>
              </span>
              <FactRow fact={r.fact} onOpenFile={onOpenFile} />
            </div>
          ))}
        </section>
      )}
      {incomplete.length + unsupported.length > 0 && (
        <section className="card nd-role">
          <div className="dm-h">Not checked</div>
          {[...incomplete, ...unsupported].map((r, i) => (
            <div key={i} className="nd-ob">
              <span className="hint">{r.outcome === "incomplete" ? `Incomplete: it ${r.why}.` : `Unsupported: ${r.why}.`}</span>
              <FactRow fact={r.fact} onOpenFile={onOpenFile} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
