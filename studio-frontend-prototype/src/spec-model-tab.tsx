// The project's Domain model tab: what its documents say the application is,
// and where they disagree about it (docs/spec-domain-model.md).
//
// Problems first, because that is what a person acts on; Entities is the
// model itself, every fact with the passage it rests on; Glossary is the names
// the project uses for its things, decided by members, which Entities and the
// rules read through; Work is the issues, pull requests and commits that name
// what the documents define; Against the code is
// what the documents ask for that the code is not made of
// (docs/project-and-product.md); Coverage says which documents have been
// read, and is where a build starts. A build runs on the viewer's own model
// key, so the button says so.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  BASIS_LABEL,
  BASIS_ORDER,
  basisSummary,
  buildLine,
  codeSpans,
  coverageCounts,
  entitiesOf,
  factsByKind,
  filterRequirements,
  mergeTargets,
  orderFindings,
  orderProductFindings,
  orderRelated,
  RELATION_LABEL,
  relatedEntities,
  requirementKinds,
  traceGaps,
  ruleLabel,
  sideLabel,
  type Entity,
  type GlossaryEntry,
  type ProductFinding,
  type RequirementFilter,
  type RelatedRequirements,
  type RequirementTraces,
  type TraceGap,
  type SpecModel,
  type SpecModelFact,
  type SpecModelFinding,
  type SpecModelSide,
  type SpecRequirements,
  type WorkLinks,
  workLabel,
  workState,
} from "./spec-model";

type View = "problems" | "requirements" | "trace" | "elsewhere" | "entities" | "glossary" | "work" | "product" | "coverage";

/** The product findings as read, or why they could not be. */
type ProductRead = { repo: string | null; items: ProductFinding[] } | { error: string };

const POLL_MS = 3000;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SpecModelTab({
  token,
  projectId,
  onOpenFile,
}: {
  token: string;
  projectId: string;
  /** Open a document in the project's IDE session. */
  onOpenFile?: (path: string) => void;
}) {
  const [model, setModel] = useState<SpecModel | null>(null);
  const [findings, setFindings] = useState<SpecModelFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("problems");
  const [starting, setStarting] = useState(false);
  const [product, setProduct] = useState<ProductRead | null>(null);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [work, setWork] = useState<WorkLinks | { error: string } | null>(null);
  const [requirements, setRequirements] = useState<SpecRequirements | { error: string } | null>(null);
  const [related, setRelated] = useState<RelatedRequirements | { error: string } | null>(null);
  const [traces, setTraces] = useState<RequirementTraces | { error: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, f, g] = await Promise.all([
        api.specModel(token, projectId),
        api.specModelFindings(token, projectId),
        // A backend from before the glossary answers 404: the model still shows.
        api.glossary(token, projectId).catch(() => ({ items: [] as GlossaryEntry[], total: 0 })),
      ]);
      setModel(m);
      setFindings(f.items);
      setGlossary(g.items);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [token, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A separate read: the comparison with the code needs the catalogue and a
  // repository, and its absence must not hide the documents' own problems.
  useEffect(() => {
    let live = true;
    api
      .productFindings(token, projectId)
      .then((r) => live && setProduct({ repo: r.repo, items: orderProductFindings(r.items) }))
      .catch((e: unknown) => live && setProduct({ error: message(e) }));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  // Its own read, like the comparison with the code: no synced work must not
  // hide the documents' own problems.
  useEffect(() => {
    let live = true;
    api
      .workLinks(token, projectId)
      .then((r) => live && setWork(r))
      .catch((e: unknown) => live && setWork({ error: message(e) }));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  // Read without a model and without a key: what the documents define and
  // what each states it rests on.
  useEffect(() => {
    let live = true;
    api
      .specRequirements(token, projectId)
      .then((r) => live && setRequirements(r))
      .catch((e: unknown) => live && setRequirements({ error: message(e) }));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  // Read when the view is opened: it reads every code file of the checkouts.
  useEffect(() => {
    if (view !== "trace" || traces !== null) return;
    let live = true;
    api
      .requirementTrace(token, projectId)
      .then((r) => live && setTraces(r))
      .catch((e: unknown) => live && setTraces({ error: message(e) }));
    return () => {
      live = false;
    };
  }, [view, traces, token, projectId]);

  // Read only when the view is opened: it reads every other project's documents.
  useEffect(() => {
    if (view !== "elsewhere" || related !== null) return;
    let live = true;
    api
      .relatedRequirements(token, projectId)
      .then((r) => live && setRelated(r))
      .catch((e: unknown) => live && setRelated({ error: message(e) }));
    return () => {
      live = false;
    };
  }, [view, related, token, projectId]);

  // While a build runs, read again until it stops: the build is in the
  // backend's process, and nothing pushes its progress.
  const running = model?.build.running ?? false;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [running, load]);

  const startBuild = async () => {
    setStarting(true);
    try {
      await api.startSpecModelBuild(token, projectId);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setStarting(false);
    }
  };

  const decide = async (finding: SpecModelFinding, decision: "confirmed" | "dismissed") => {
    try {
      await api.decideSpecModelFinding(token, projectId, finding.fingerprint, decision);
      setFindings((all) => all.map((f) => (f.fingerprint === finding.fingerprint ? { ...f, decision } : f)));
    } catch (e) {
      setError(message(e));
    }
  };

  const decideTerm = async (key: string, decision: { name: string | null; alias_of: string | null }) => {
    try {
      await api.decideGlossaryEntry(token, projectId, key, decision);
      setGlossary((await api.glossary(token, projectId)).items);
    } catch (e) {
      setError(message(e));
    }
  };

  const entities = useMemo(() => entitiesOf(model?.facts ?? [], glossary), [model, glossary]);
  const ordered = useMemo(() => orderFindings(findings), [findings]);
  const open = ordered.filter((f) => f.decision !== "dismissed").length;
  const line = model ? buildLine(model.build) : "";

  return (
    <>
      <h1>Domain model</h1>
      <p className="subtitle">
        What this project&apos;s documents say the application is — its entities, what they hold, how
        they relate, what must always be true — each fact with the passage it comes from. And where
        the documents cannot all be right about it, so it is fixed before someone builds one side.
      </p>

      <div className="sm-bar">
        <div className="sm-views" role="tablist">
          <ViewChip id="problems" view={view} setView={setView} label="Problems" count={open} />
          <ViewChip
            id="requirements"
            view={view}
            setView={setView}
            label="Requirements"
            count={requirements && "items" in requirements ? requirements.total : 0}
          />
          <ViewChip
            id="trace"
            view={view}
            setView={setView}
            label="Trace"
            count={traces && "items" in traces ? traces.implemented : 0}
          />
          <ViewChip
            id="elsewhere"
            view={view}
            setView={setView}
            label="Elsewhere"
            count={related && "items" in related ? related.total : 0}
          />
          <ViewChip id="entities" view={view} setView={setView} label="Entities" count={entities.length} />
          <ViewChip id="glossary" view={view} setView={setView} label="Glossary" count={glossary.length} />
          <ViewChip id="work" view={view} setView={setView} label="Work" count={work && "items" in work ? work.total : 0} />
          <ViewChip
            id="product"
            view={view}
            setView={setView}
            label="Against the code"
            count={product && "items" in product ? product.items.length : 0}
          />
          <ViewChip
            id="coverage"
            view={view}
            setView={setView}
            label="Documents"
            count={model?.documents.length ?? 0}
          />
        </div>
        <div className="sm-build">
          {line && <span className={model?.build.error ? "sm-build-line sm-err" : "sm-build-line"}>{line}</span>}
          <button
            className="primary"
            disabled={running || starting}
            onClick={() => void startBuild()}
            title="Reads every document not yet read at its current revision, on your own model key"
          >
            {running ? "Building…" : "Build on my key"}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {!model && !error && <div className="empty">Loading…</div>}

      {model && view === "problems" && (
        <Problems findings={ordered} onDecide={decide} onOpenFile={onOpenFile} built={model.facts.length > 0} />
      )}
      {view === "requirements" && <Requirements read={requirements} onOpenFile={onOpenFile} />}
      {view === "elsewhere" && <Elsewhere read={related} onOpenFile={onOpenFile} />}
      {view === "trace" && <Trace read={traces} onOpenFile={onOpenFile} />}
      {model && view === "entities" && <Entities entities={entities} onOpenFile={onOpenFile} />}
      {model && view === "glossary" && <Glossary entries={glossary} onDecide={decideTerm} />}
      {view === "work" && <Work read={work} onOpenFile={onOpenFile} />}
      {view === "product" && <AgainstTheCode read={product} onOpenFile={onOpenFile} />}
      {model && view === "coverage" && <Coverage model={model} />}
    </>
  );
}

function ViewChip({
  id,
  view,
  setView,
  label,
  count,
}: {
  id: View;
  view: View;
  setView: (v: View) => void;
  label: string;
  count: number;
}) {
  return (
    <button
      role="tab"
      aria-selected={view === id}
      className={view === id ? "chip on" : "chip"}
      onClick={() => setView(id)}
    >
      {label}
      <span className="chip-n">{count}</span>
    </button>
  );
}

/** Text the backend wrote with backticked names, the names set as code. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {codeSpans(text).map((s, i) => (s.code ? <code key={i}>{s.text}</code> : s.text))}
    </>
  );
}

function SideLink({ side, onOpenFile }: { side: SpecModelSide; onOpenFile?: (path: string) => void }) {
  return (
    <div className="sm-side">
      <button
        className="sm-side-path"
        disabled={!onOpenFile}
        onClick={() => onOpenFile?.(side.path)}
        title="Open in the editor"
      >
        {sideLabel(side)}
      </button>
      {side.quote && <blockquote className="sm-quote">{side.quote}</blockquote>}
    </div>
  );
}

function Problems({
  findings,
  onDecide,
  onOpenFile,
  built,
}: {
  findings: SpecModelFinding[];
  onDecide: (f: SpecModelFinding, d: "confirmed" | "dismissed") => void;
  onOpenFile?: (path: string) => void;
  built: boolean;
}) {
  if (findings.length === 0) {
    return (
      <div className="empty">
        {built
          ? "No disagreements found, and every reference resolves."
          : "Every reference resolves. Build the model to look for disagreements between documents."}
      </div>
    );
  }
  return (
    <div className="sm-findings">
      {findings.map((f) => (
        <div key={f.fingerprint} className={`card sm-finding sm-${f.severity}${f.decision === "dismissed" ? " sm-dismissed" : ""}`}>
          <div className="card-head">
            <div>
              <span className={`sm-sev sm-sev-${f.severity}`}>{f.severity}</span>{" "}
              <strong>{ruleLabel(f.rule)}</strong>
            </div>
            <div className="sm-decide">
              <button
                className={f.decision === "confirmed" ? "chip on" : "chip"}
                onClick={() => onDecide(f, "confirmed")}
                title="A real problem"
              >
                ✓
              </button>
              <button
                className={f.decision === "dismissed" ? "chip on" : "chip"}
                onClick={() => onDecide(f, "dismissed")}
                title="Not a problem"
              >
                ✗
              </button>
            </div>
          </div>
          <p className="sm-message">
            <Prose text={f.message} />
          </p>
          <div className={f.sides.length === 2 ? "sm-sides sm-two" : "sm-sides"}>
            {f.sides.slice(0, 6).map((s, i) => (
              <SideLink key={i} side={s} onOpenFile={onOpenFile} />
            ))}
            {f.sides.length > 6 && <div className="hint">and {f.sides.length - 6} more places</div>}
          </div>
          {f.edit && (
            <div className="sm-fix">
              <span className="hint">Fix in {f.edit.path}:</span>
              <del>{f.edit.replace}</del>
              <ins>{f.edit.with}</ins>
            </div>
          )}
          {!f.edit && f.decide.length > 0 && (
            <div className="sm-fix">
              <span className="hint">Needs a decision:</span>
              <ul>
                {f.decide.map((o) => (
                  <li key={o}>
                    <Prose text={o} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AgainstTheCode({
  read,
  onOpenFile,
}: {
  read: ProductRead | null;
  onOpenFile?: (path: string) => void;
}) {
  if (!read) return <div className="empty">Loading…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;
  if (!read.repo) {
    return (
      <div className="empty">
        No code to compare: the project has no gear repository and no GitHub source whose Cargo
        manifests could be read.
      </div>
    );
  }
  if (read.items.length === 0) {
    return (
      <div className="empty">
        Every capability the documents ask for is filled by a gear in <code>{read.repo}</code>.
      </div>
    );
  }
  return (
    <div className="sm-findings">
      <p className="hint">
        The documents against the crates <code>{read.repo}</code> depends on and the gears it declares.
        A decision about which gear fills a capability is taken in the project&apos;s Components tab.
      </p>
      {read.items.map((f) => (
        <div key={f.fingerprint} className={`card sm-finding sm-${f.severity}`}>
          <div className="card-head">
            <div>
              <span className={`sm-sev sm-sev-${f.severity}`}>{f.severity}</span>{" "}
              <strong>{ruleLabel(f.rule)}</strong> <code>{f.capability}</code>
            </div>
          </div>
          <p className="sm-message">
            <Prose text={f.message} />
          </p>
          <div className={f.sides.length === 2 ? "sm-sides sm-two" : "sm-sides"}>
            {f.sides.slice(0, 6).map((s, i) => (
              <SideLink
                key={i}
                side={{ path: s.path, quote: s.quote }}
                onOpenFile={s.kind === "file" ? onOpenFile : undefined}
              />
            ))}
            {f.sides.length > 6 && <div className="hint">and {f.sides.length - 6} more documents</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Entities({ entities, onOpenFile }: { entities: Entity[]; onOpenFile?: (path: string) => void }) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const shown = entities.filter((e) => e.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const current = entities.find((e) => e.key === selected) ?? shown[0];
  if (entities.length === 0) {
    return <div className="empty">Nothing read yet. Build the model to read the documents.</div>;
  }
  return (
    <div className="sm-entities">
      <div className="sm-entity-list">
        <input placeholder="Filter entities" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ul className="rows">
          {shown.map((e) => (
            <li
              key={e.key}
              className={current?.key === e.key ? "sm-entity on" : "sm-entity"}
              onClick={() => setSelected(e.key)}
            >
              <span>{e.name}</span>
              <span className="hint">
                {e.facts.length} · {e.documents} doc{e.documents === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {current && (
        <div className="card sm-entity-card">
          <h2>{current.name}</h2>
          {relatedEntities(current, entities).length > 0 && (
            <div className="sm-related">
              Relates to:{" "}
              {relatedEntities(current, entities).map((k) => (
                <button key={k} className="chip" onClick={() => setSelected(k)}>
                  {entities.find((e) => e.key === k)?.name ?? k}
                </button>
              ))}
            </div>
          )}
          {factsByKind(current.facts).map((g) => (
            <section key={g.kind} className="sm-kind">
              <h3>{g.kind}</h3>
              {g.facts.map((f, i) => (
                <FactRow key={i} fact={f} onOpenFile={onOpenFile} />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** The issues, pull requests and commits that name an identifier the
 *  documents define, by identifier. A link is made only by the work naming
 *  the identifier; nothing is guessed. */
function Work({
  read,
  onOpenFile,
}: {
  read: WorkLinks | { error: string } | null;
  onOpenFile?: (path: string) => void;
}) {
  if (read === null) return <div className="empty">Loading…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;
  if (!read.synced) {
    return <div className="empty">Nothing syncs this deployment&apos;s issues and pull requests, so there is no work to link.</div>;
  }
  const summary = `${read.identifiers} identifier${read.identifiers === 1 ? "" : "s"} defined in the documents; ${read.total} named by work. ${read.unlinked} of ${read.work} issues, pull requests and commits name none.`;
  if (read.items.length === 0) {
    return (
      <div className="empty">
        {read.identifiers === 0
          ? "The documents define no identifiers with a label (**ID**: `…`), so there is nothing for work to name."
          : `No issue, pull request or commit names one of the ${read.identifiers} identifiers the documents define.`}
      </div>
    );
  }
  return (
    <>
      <p className="hint">{summary} A piece of work is linked when its title, text or commit message names the identifier.</p>
      <ul className="rows sm-work">
        {read.items.map((l) => (
          <li key={l.id} className="sm-work-row">
            <div className="sm-term-head">
              <code>{l.id}</code>
              <SideLink side={l.defined_in} onOpenFile={onOpenFile} />
            </div>
            <ul className="sm-work-items">
              {l.work.map((w, i) => (
                <li key={i}>
                  {w.url ? (
                    <a href={w.url} target="_blank" rel="noreferrer">
                      {workLabel(w)}
                    </a>
                  ) : (
                    <span>{workLabel(w)}</span>
                  )}{" "}
                  <span className="sm-work-title">{w.title}</span>{" "}
                  {workState(w) && <span className="sm-status">{workState(w)}</span>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}

/** What the documents define, and what each requirement states it rests on:
 *  a source it cites, a reason, or the words that make it an assumption or an
 *  open question. Shown, never raised as a problem. */
function Requirements({
  read,
  onOpenFile,
}: {
  read: SpecRequirements | { error: string } | null;
  onOpenFile?: (path: string) => void;
}) {
  const [filter, setFilter] = useState<RequirementFilter>({ basis: "all", kind: "all", text: "", noWork: false });
  if (read === null) return <div className="empty">Loading…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;
  if (read.total === 0) {
    return (
      <div className="empty">
        The documents define no identifiers with a label (**ID**: `…`), so there are no requirements to list.
      </div>
    );
  }
  const kinds = requirementKinds(read.items);
  const shown = filterRequirements(read.items, filter);
  return (
    <>
      <p className="hint">
        {basisSummary(read)} Read from each requirement&apos;s own block as written; nothing is asked of the
        documents.
      </p>
      <div className="sm-req-filters">
        <select
          aria-label="Basis"
          value={filter.basis}
          onChange={(e) => setFilter({ ...filter, basis: e.target.value as RequirementFilter["basis"] })}
        >
          <option value="all">Any basis</option>
          {BASIS_ORDER.map((b) => (
            <option key={b} value={b}>
              {BASIS_LABEL[b]} ({read.by_basis[b] ?? 0})
            </option>
          ))}
        </select>
        {kinds.length > 1 && (
          <select aria-label="Kind" value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value })}>
            <option value="all">Any kind</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
        {read.synced && (
          <label className="sm-req-nowork">
            <input
              type="checkbox"
              checked={filter.noWork}
              onChange={(e) => setFilter({ ...filter, noWork: e.target.checked })}
            />{" "}
            No work yet
          </label>
        )}
        <input
          type="search"
          placeholder="Filter by id, title or text"
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
        />
      </div>
      <ul className="rows sm-work">
        {shown.map((r) => (
          <li key={`${r.id}@${r.defined_in.path}:${r.defined_in.line_start}`} className="sm-work-row">
            <div className="sm-term-head">
              <code>{r.id}</code>
              {r.priority && <span className="sm-status">{r.priority}</span>}
              <span className={`sm-status sm-basis-${r.basis}`} title={r.because ? `Because of “${r.because}”` : undefined}>
                {BASIS_LABEL[r.basis]}
              </span>
              {read.synced && <span className="sm-status">{r.work === 0 ? "no work" : `${r.work} work`}</span>}
              <SideLink side={r.defined_in} onOpenFile={onOpenFile} />
            </div>
            {r.title && <div className="sm-req-title">{r.title}</div>}
            {r.text && <div className="sm-work-title">{r.text}</div>}
            {r.cites.length > 0 && (
              <div className="sm-req-cites">
                Cites: {r.cites.map((c, i) => (
                  <code key={i}>{c}</code>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {shown.length === 0 && <div className="empty">No requirement matches the filter.</div>}
    </>
  );
}

/** Each requirement with the documents, code and tests that name its
 *  identifier: what is implemented, what is tested, what nothing names. */
function Trace({
  read,
  onOpenFile,
}: {
  read: RequirementTraces | { error: string } | null;
  onOpenFile?: (path: string) => void;
}) {
  const [gap, setGap] = useState<TraceGap>("all");
  if (read === null) return <div className="empty">Reading the code and tests of the checkouts…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;
  if (read.total === 0) {
    return <div className="empty">The documents define no identifiers with a label, so there is nothing to trace.</div>;
  }
  const shown = traceGaps(read.items, gap);
  const places = (label: string, sides: SpecModelSide[]) =>
    sides.length > 0 && (
      <div className="sm-req-cites">
        {label}:{" "}
        {sides.map((s, i) => (
          <SideLink key={i} side={s} onOpenFile={onOpenFile} />
        ))}
      </div>
    );
  return (
    <>
      <p className="hint">
        {read.implemented} of {read.total} requirements are named in code, {read.tested} in tests, across {read.files}{" "}
        files read. A file is counted when it names the identifier itself; what is not named is not traced.
      </p>
      <div className="sm-req-filters">
        <select aria-label="Gap" value={gap} onChange={(e) => setGap(e.target.value as TraceGap)}>
          <option value="all">All requirements</option>
          <option value="no-code">Not named in code</option>
          <option value="no-test">Not named in a test</option>
          <option value="untraced">Named nowhere</option>
        </select>
      </div>
      <ul className="rows sm-work">
        {shown.map((t) => (
          <li key={`${t.id}@${t.defined_in.path}`} className="sm-work-row">
            <div className="sm-term-head">
              <code>{t.id}</code>
              <span className={t.code.length ? "sm-status sm-basis-cited" : "sm-status"}>
                {t.code.length ? `${t.code.length} in code` : "no code"}
              </span>
              <span className={t.tests.length ? "sm-status sm-basis-cited" : "sm-status"}>
                {t.tests.length ? `${t.tests.length} in tests` : "no test"}
              </span>
              <SideLink side={t.defined_in} onOpenFile={onOpenFile} />
            </div>
            {t.title && <div className="sm-req-title">{t.title}</div>}
            {places("Documents", t.documents)}
            {places("Code", t.code)}
            {places("Tests", t.tests)}
          </li>
        ))}
      </ul>
      {shown.length === 0 && <div className="empty">No requirement has this gap.</div>}
    </>
  );
}

/** What other projects of the organization require that reads like this
 *  project's requirements: the same, overlapping, or the opposite. A list of
 *  candidates to read side by side; nothing is decided here. */
function Elsewhere({
  read,
  onOpenFile,
}: {
  read: RelatedRequirements | { error: string } | null;
  onOpenFile?: (path: string) => void;
}) {
  if (read === null) return <div className="empty">Comparing with the organization&apos;s other projects…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;
  if (read.items.length === 0) {
    return (
      <div className="empty">
        {read.projects === 0
          ? "There is no other project in this organization you can read, so there is nothing to compare with."
          : `No requirement of the ${read.projects} other project${read.projects === 1 ? "" : "s"} reads like one of this project's.`}
      </div>
    );
  }
  return (
    <>
      <p className="hint">
        Compared with {read.projects} other project{read.projects === 1 ? "" : "s"}
        {read.truncated ? " (the first 40)" : ""}, by the words two statements share. Read both before deciding
        anything: a pair here is a question, not a finding.
      </p>
      <ul className="rows sm-work">
        {orderRelated(read.items).map((r, i) => (
          <li key={i} className="sm-work-row">
            <div className="sm-term-head">
              <span className={`sm-status sm-rel-${r.relation}`}>{RELATION_LABEL[r.relation]}</span>
              <span className="sm-status">{Math.round(r.score * 100)}%</span>
            </div>
            <div className="sm-rel-pair">
              <div>
                <code>{r.id}</code> <SideLink side={r.defined_in} onOpenFile={onOpenFile} />
                <div className="sm-work-title">{r.text}</div>
              </div>
              <div>
                <code>{r.other_id}</code>{" "}
                <span className="sm-status">
                  {r.other_workspace_name} / {r.other_project_name}
                </span>{" "}
                <span className="sm-work-title">
                  {r.other_defined_in.path}:{r.other_defined_in.line_start}
                </span>
                <div className="sm-work-title">{r.other_text}</div>
              </div>
            </div>
            <div className="sm-req-cites">Shared: {r.shared.join(", ")}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The project's names for its things. Each entry is proposed from the
 *  spellings the documents use; a member names it, or merges it into another
 *  entry as one more name of the same thing, and can split it out again. */
function Glossary({
  entries,
  onDecide,
}: {
  entries: GlossaryEntry[];
  onDecide: (key: string, decision: { name: string | null; alias_of: string | null }) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  if (entries.length === 0) {
    return <div className="empty">Nothing read yet. Build the model to read the documents.</div>;
  }
  const needle = filter.trim().toLowerCase();
  const shown = entries.filter(
    (e) => !needle || e.spellings.some((s) => s.toLowerCase().includes(needle)) || e.name.toLowerCase().includes(needle),
  );
  // An entry shown is never an alias itself, so its decision keeps
  // `alias_of` null; a split alias goes back to the name its documents use.
  const chosenName = (e: GlossaryEntry) => (e.chosen ? e.name : null);
  return (
    <>
      <p className="hint">
        One entry per thing the documents name. Spellings that differ only in case, articles or plurals are already
        one entry. Name the entry the way the project should say it, or merge an entry into another when the
        documents call one thing by two names: the rules then read both names as one thing.
      </p>
      <input placeholder="Filter the glossary" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="rows sm-glossary">
        {shown.map((e) => {
          const others = e.spellings.filter((s) => s !== e.name);
          const targets = mergeTargets(e, entries);
          return (
            <li key={e.key} className="sm-term">
              <div className="sm-term-head">
                {renaming?.key === e.key ? (
                  <form
                    className="sm-term-rename"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      void onDecide(e.key, { name: renaming.name.trim() || null, alias_of: null }).then(() =>
                        setRenaming(null),
                      );
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={`Name for ${e.name}`}
                      value={renaming.name}
                      onChange={(ev) => setRenaming({ key: e.key, name: ev.target.value })}
                    />
                    <button type="submit" className="primary">
                      Save
                    </button>
                    <button type="button" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <strong>{e.name}</strong>
                    {e.chosen && <span className="sm-status">chosen</span>}
                    <span className="hint">
                      {e.facts} fact{e.facts === 1 ? "" : "s"} · {e.documents} doc{e.documents === 1 ? "" : "s"}
                    </span>
                  </>
                )}
              </div>
              {others.length > 0 && <div className="hint">Also written: {others.join(", ")}</div>}
              {e.aliases.length > 0 && (
                <div className="sm-related">
                  Same thing as:{" "}
                  {e.aliases.map((a) => (
                    <button
                      key={a.key}
                      className="chip"
                      title={`Split “${a.name}” out into an entry of its own`}
                      onClick={() => void onDecide(a.key, { name: null, alias_of: null })}
                    >
                      {a.name} ×
                    </button>
                  ))}
                </div>
              )}
              {renaming?.key !== e.key && (
                <div className="sm-term-actions">
                  <button onClick={() => setRenaming({ key: e.key, name: e.name })}>Rename</button>
                  {e.chosen && (
                    <button onClick={() => void onDecide(e.key, { name: null, alias_of: null })}>
                      Use the documents&apos; name
                    </button>
                  )}
                  {targets.length > 0 && (
                    <select
                      aria-label={`Merge ${e.name} into another entry`}
                      value=""
                      onChange={(ev) =>
                        ev.target.value && void onDecide(e.key, { name: chosenName(e), alias_of: ev.target.value })
                      }
                    >
                      <option value="">Same thing as…</option>
                      {targets.map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function FactRow({ fact, onOpenFile }: { fact: SpecModelFact; onOpenFile?: (path: string) => void }) {
  const inactive = fact.status !== "active";
  return (
    <div className={inactive ? "sm-fact sm-inactive" : "sm-fact"}>
      <div>
        {fact.aspect && <span className="sm-aspect">{fact.aspect}: </span>}
        {fact.value ? <strong>{fact.value}</strong> : fact.text}
        {inactive && (
          <span className="sm-status" title={fact.status_because}>
            {fact.status}
          </span>
        )}
      </div>
      {fact.value && fact.text && <div className="hint">{fact.text}</div>}
      <SideLink side={fact.source} onOpenFile={onOpenFile} />
    </div>
  );
}

function Coverage({ model }: { model: SpecModel }) {
  const counts = coverageCounts(model.documents);
  return (
    <>
      <p className="hint">
        {counts.extracted} read at their current revision, {counts.failed} read part-way, {counts.stale} changed
        since they were read, {counts.pending} never read. A build reads only what is not read at its
        revision, so an unchanged document is never paid for twice.
      </p>
      <table className="sm-table">
        <thead>
          <tr>
            <th>Document</th>
            <th>State</th>
            <th>Facts</th>
            <th>Dropped</th>
          </tr>
        </thead>
        <tbody>
          {model.documents.map((d) => (
            <tr key={d.path}>
              <td>{d.path}</td>
              <td>
                <span className={`sm-state sm-state-${d.state}`} title={d.error ?? undefined}>
                  {d.state}
                </span>
              </td>
              <td>{d.facts}</td>
              <td title="Facts the model gave that the text did not bear out">{d.dropped}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
