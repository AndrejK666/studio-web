// The project's Domain model tab: what its documents say the application is,
// and where they disagree about it (docs/spec-domain-model.md).
//
// Three views over one read. Problems first, because that is what a person
// acts on; Entities is the model itself, every fact with the passage it rests
// on; Coverage says which documents have been read, and is where a build
// starts. A build runs on the viewer's own model key, so the button says so.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  buildLine,
  codeSpans,
  coverageCounts,
  entitiesOf,
  factsByKind,
  orderFindings,
  relatedEntities,
  ruleLabel,
  sideLabel,
  type Entity,
  type SpecModel,
  type SpecModelFact,
  type SpecModelFinding,
  type SpecModelSide,
} from "./spec-model";

type View = "problems" | "entities" | "coverage";

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

  const load = useCallback(async () => {
    try {
      const [m, f] = await Promise.all([
        api.specModel(token, projectId),
        api.specModelFindings(token, projectId),
      ]);
      setModel(m);
      setFindings(f.items);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [token, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const entities = useMemo(() => entitiesOf(model?.facts ?? []), [model]);
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
          <ViewChip id="entities" view={view} setView={setView} label="Entities" count={entities.length} />
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
      {model && view === "entities" && <Entities entities={entities} onOpenFile={onOpenFile} />}
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
