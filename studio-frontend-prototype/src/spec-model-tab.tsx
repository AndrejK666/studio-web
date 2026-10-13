// The project's Domain model tab: what its documents say the application is,
// and where they disagree about it (docs/spec-domain-model.md).
//
// Problems first, because that is what a person acts on; Entities is the
// model itself, every fact with the passage it rests on; Glossary is the names
// the project uses for its things, decided by members, which Entities and the
// rules read through; Against the code is
// what the documents ask for that the code is not made of
// (docs/project-and-product.md); Coverage says which documents have been
// read, and is where a build starts. A build runs on the viewer's own model
// key, so the button says so.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  buildLine,
  codeSpans,
  coverageCounts,
  entitiesOf,
  factsByKind,
  mergeTargets,
  orderFindings,
  orderProductFindings,
  relatedEntities,
  ruleLabel,
  sideLabel,
  type Entity,
  type GlossaryEntry,
  type ProductFinding,
  type SpecModel,
  type SpecModelFact,
  type SpecModelFinding,
  type SpecModelSide,
} from "./spec-model";

type View = "problems" | "entities" | "glossary" | "product" | "coverage";

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
          <ViewChip id="entities" view={view} setView={setView} label="Entities" count={entities.length} />
          <ViewChip id="glossary" view={view} setView={setView} label="Glossary" count={glossary.length} />
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
      {model && view === "entities" && <Entities entities={entities} onOpenFile={onOpenFile} />}
      {model && view === "glossary" && <Glossary entries={glossary} onDecide={decideTerm} />}
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
