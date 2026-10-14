/* The Domain model tab's three views (domain-model-views.ts): what to resolve
 * before building, the model as a map of connected entities, and each
 * requirement followed from its passage to its code. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import {
  blockItems,
  entityArea,
  findEntities,
  findRequirements,
  layout,
  mapEdges,
  neighbours,
  readiness,
  RESOLVE_LABEL,
  resolveQueue,
  traceChain,
  type ResolveItem,
  type ResolveType,
} from "./domain-model-views";
import {
  BASIS_LABEL,
  BASIS_ORDER,
  codeSpans,
  factsByKind,
  sideLabel,
  workLabel,
  workState,
  type Entity,
  type RequirementTraces,
  type SpecModelFact,
  type SpecModelFinding,
  type SpecModelSide,
  type SpecRequirement,
  type SpecRequirements,
  type WorkItem,
  type WorkLinks,
} from "./spec-model";

type OpenFile = ((path: string) => void) | undefined;

/** Text the backend wrote with backticked names, the names set as code. */
export function Prose({ text }: { text: string }) {
  return <>{codeSpans(text).map((s, i) => (s.code ? <code key={i}>{s.text}</code> : s.text))}</>;
}

export function SideLink({ side, onOpenFile }: { side: SpecModelSide; onOpenFile?: (path: string) => void }) {
  return (
    <div className="sm-side">
      <button className="sm-side-path" disabled={!onOpenFile} onClick={() => onOpenFile?.(side.path)} title="Open in the editor">
        {sideLabel(side)}
      </button>
      {side.quote && <blockquote className="sm-quote">{side.quote}</blockquote>}
    </div>
  );
}

export function FactRow({ fact, onOpenFile }: { fact: SpecModelFact; onOpenFile?: (path: string) => void }) {
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

// ── 1 · To resolve ──────────────────────────────────────────────────────────

export function ResolveView({
  findings,
  requirements,
  onDecide,
  onTrace,
  onOpenFile,
  built,
}: {
  findings: SpecModelFinding[];
  requirements: SpecRequirements | null;
  onDecide: (f: SpecModelFinding, d: "confirmed" | "dismissed") => void;
  /** Follow a requirement in the Requirements view. */
  onTrace: (id: string) => void;
  onOpenFile: OpenFile;
  built: boolean;
}) {
  const [only, setOnly] = useState<ResolveType | "all">("all");
  const queue = useMemo(() => resolveQueue(findings, requirements?.items ?? []), [findings, requirements]);
  const ready = readiness(queue, requirements?.by_basis ?? {}, requirements?.total ?? 0);
  const count = (t: ResolveType) => queue.filter((i) => i.type === t && !i.done).length;
  const shown = queue.filter((i) => only === "all" || i.type === only);
  const pct = (n: number) => (ready.total ? `${(n / ready.total) * 100}%` : "0%");

  return (
    <div className="dm-resolve">
      <div className="dm-ready">
        <div className="dm-tile dm-verdict">
          <b>{ready.ready ? "Ready to build" : "Not ready to build yet"}</b>
          {ready.total > 0 && (
            <div className="dm-meter" title="Requirements by what they rest on">
              <i style={{ width: pct(ready.cited), background: "var(--success)" }} />
              <i style={{ width: pct(ready.reasoned), background: "var(--studio-ai-violet)" }} />
            </div>
          )}
          <span>
            {ready.total > 0 ? `${ready.cited} of ${ready.total} requirements cite a source, ${ready.reasoned} give a reason. ` : ""}
            {ready.open === 0 ? "Nothing waits for a decision." : `${ready.open} thing${ready.open === 1 ? "" : "s"} wait for a decision.`}
          </span>
        </div>
        <Tile type="finding" n={count("finding")} label="problems in the documents" tone="bad" only={only} setOnly={setOnly} />
        <Tile type="question" n={count("question")} label="open questions" tone="bad" only={only} setOnly={setOnly} />
        <Tile type="assumption" n={count("assumption")} label="assumptions to confirm" tone="warn" only={only} setOnly={setOnly} />
        <Tile type="nobasis" n={count("nobasis")} label="requirements with no basis" tone="warn" only={only} setOnly={setOnly} />
      </div>

      <div className="dm-queue-head">
        <b>{only === "all" ? "Everything to decide, most blocking first" : RESOLVE_LABEL[only]}</b>
        {only !== "all" && (
          <button type="button" className="dm-link" onClick={() => setOnly("all")}>
            show all
          </button>
        )}
        <span className="hint">{shown.length} shown</span>
      </div>
      {shown.length === 0 && (
        <div className="empty">
          {built ? "Nothing to decide here." : "Every reference resolves. Build the model to look for disagreements between documents."}
        </div>
      )}
      <div className="dm-queue">
        {shown.slice(0, 80).map((i) => (
          <QueueItem key={i.key} item={i} onDecide={onDecide} onTrace={onTrace} onOpenFile={onOpenFile} />
        ))}
        {shown.length > 80 && <p className="hint">and {shown.length - 80} more; pick a tile above to narrow it.</p>}
      </div>
    </div>
  );
}

function Tile({
  type,
  n,
  label,
  tone,
  only,
  setOnly,
}: {
  type: ResolveType;
  n: number;
  label: string;
  tone: "bad" | "warn";
  only: ResolveType | "all";
  setOnly: (t: ResolveType | "all") => void;
}) {
  return (
    <button type="button" className={`dm-tile dm-${tone}`} aria-pressed={only === type} onClick={() => setOnly(only === type ? "all" : type)}>
      <b>{n}</b>
      <span>{label}</span>
    </button>
  );
}

function QueueItem({
  item,
  onDecide,
  onTrace,
  onOpenFile,
}: {
  item: ResolveItem;
  onDecide: (f: SpecModelFinding, d: "confirmed" | "dismissed") => void;
  onTrace: (id: string) => void;
  onOpenFile: OpenFile;
}) {
  const f = item.finding;
  const r = item.requirement;
  return (
    <article className={`card dm-item${item.done ? " dm-done" : ""}`} data-item={item.key}>
      <header>
        <span className={`dm-pill dm-${item.tone}`}>{RESOLVE_LABEL[item.type]}</span>
        <b>
          <Prose text={item.title} />
        </b>
        {r && (
          <button type="button" className="dm-link" onClick={() => onTrace(r.id)}>
            trace it
          </button>
        )}
      </header>
      <div className="hint">{item.hint}</div>
      <div className="sm-sides sm-two">
        {item.sides.slice(0, 3).map((s, i) => (
          <SideLink key={i} side={s} onOpenFile={onOpenFile} />
        ))}
        {item.sides.length > 3 && <div className="hint">and {item.sides.length - 3} more places</div>}
      </div>
      {f?.edit && (
        <div className="sm-fix">
          <span className="hint">Fix in {f.edit.path}:</span>
          <del>{f.edit.replace}</del>
          <ins>{f.edit.with}</ins>
        </div>
      )}
      {f && !f.edit && f.decide.length > 0 && (
        <div className="sm-fix">
          <span className="hint">Choose:</span>
          <ul>
            {f.decide.map((o) => (
              <li key={o}>
                <Prose text={o} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="dm-actions">
        {f ? (
          item.done ? (
            <>
              <span className="hint">{f.decision === "confirmed" ? "✓ Marked as a real problem" : "✓ Marked as fine"}</span>
            </>
          ) : (
            <>
              {f.sides[0] && onOpenFile && (
                <button type="button" className="primary" onClick={() => onOpenFile(f.sides[0].path)}>
                  Fix it in the editor
                </button>
              )}
              <button type="button" className="ghost" onClick={() => onDecide(f, "confirmed")} title="Keep it on the list as a real problem">
                It is a real problem
              </button>
              <button type="button" className="ghost" onClick={() => onDecide(f, "dismissed")} title="Take it off the list">
                It is fine
              </button>
            </>
          )
        ) : (
          r && (
            <>
              {onOpenFile && (
                <button type="button" className="primary" onClick={() => onOpenFile(r.defined_in.path)}>
                  {item.type === "question" ? "Answer it in the document" : item.type === "assumption" ? "Confirm it in the document" : "Add its source"}
                </button>
              )}
            </>
          )
        )}
      </div>
    </article>
  );
}

// ── 2 · Model map ───────────────────────────────────────────────────────────

/** Area colours, readable on both themes. */
const AREA_COLOURS = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#64748b"];
const W = 900;
const H = 620;

export function ModelMapView({ entities, onOpenFile }: { entities: Entity[]; onOpenFile: OpenFile }) {
  const [area, setArea] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const [declaredOnly, setDeclaredOnly] = useState(false);

  const areaOf = useMemo(() => new Map(entities.map((e) => [e.key, entityArea(e)])), [entities]);
  const areas = useMemo(() => {
    const n = new Map<string, number>();
    for (const a of areaOf.values()) n.set(a, (n.get(a) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
  }, [areaOf]);
  const colour = (a: string) => AREA_COLOURS[areas.findIndex(([x]) => x === a) % AREA_COLOURS.length];

  const shown = useMemo(
    () => findEntities(entities, query).filter((e) => !area || areaOf.get(e.key) === area),
    [entities, query, area, areaOf],
  );
  const allEdges = useMemo(() => mapEdges(entities), [entities]);
  const edges = useMemo(() => {
    const keep = new Set(shown.map((e) => e.key));
    return allEdges.filter((e) => keep.has(e.from) && keep.has(e.to) && (!declaredOnly || e.kind === "relation"));
  }, [allEdges, shown, declaredOnly]);
  const sel = entities.find((e) => e.key === selected) ?? null;

  if (entities.length === 0) return <div className="empty">Nothing read yet. Build the model to read the documents.</div>;

  return (
    <div className="dm-map">
      <aside className="card dm-areas" aria-label="Where it is described">
        <input type="search" placeholder="Find an entity" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find an entity" />
        <div className="dm-h">Where it is described</div>
        <button type="button" className="dm-area" aria-pressed={!area} onClick={() => setArea(null)}>
          All <span>{entities.length}</span>
        </button>
        {areas.map(([a, n]) => (
          <button key={a} type="button" className="dm-area" aria-pressed={area === a} onClick={() => setArea(area === a ? null : a)}>
            <i style={{ background: colour(a) }} />
            {a} <span>{n}</span>
          </button>
        ))}
      </aside>

      <div className="card dm-canvas">
        <div className="dm-mapbar">
          <span className="dm-seg" role="group" aria-label="How to show it">
            <button type="button" aria-pressed={mode === "graph"} onClick={() => setMode("graph")}>
              Graph
            </button>
            <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>
              List
            </button>
          </span>
          {mode === "graph" && (
            <label className="hint">
              <input type="checkbox" checked={declaredOnly} onChange={(e) => setDeclaredOnly(e.target.checked)} /> only relations the documents declare
            </label>
          )}
          <span className="hint" style={{ marginLeft: "auto" }}>
            {shown.length} entities{mode === "graph" ? ` · ${edges.length} links` : ""}
          </span>
        </div>
        {mode === "graph" ? (
          <Graph
            entities={shown}
            edges={edges}
            declaredOnly={declaredOnly}
            selected={selected}
            onSelect={setSelected}
            colour={(k) => colour(areaOf.get(k) ?? "")}
          />
        ) : (
          <div className="dm-list">
            {shown.map((e) => (
              <button key={e.key} type="button" className={`dm-ent${e.key === selected ? " on" : ""}`} onClick={() => setSelected(e.key)}>
                <i style={{ background: colour(areaOf.get(e.key) ?? "") }} />
                <b>{e.name}</b>
                <span className="hint">
                  {e.facts.length} facts · {e.documents} doc{e.documents === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </div>
        )}
        {mode === "graph" && (
          <div className="dm-legend">
            <span>
              <svg viewBox="0 0 26 8" width="26" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="26" y2="4" className="dm-edge relation" />
              </svg>
              a document declares the relation
            </span>
            <span>
              <svg viewBox="0 0 26 8" width="26" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="26" y2="4" className="dm-edge mentions" />
              </svg>
              one names the other
            </span>
            <span className="hint">scroll to zoom · drag to move</span>
          </div>
        )}
      </div>

      <aside className="card dm-card" aria-label="The selected entity">
        {sel ? (
          <EntityCard
            entity={sel}
            area={areaOf.get(sel.key) ?? ""}
            linked={[...neighbours(sel.key, allEdges)].map((k) => entities.find((e) => e.key === k)).filter((e): e is Entity => !!e)}
            onSelect={setSelected}
            onOpenFile={onOpenFile}
          />
        ) : (
          <>
            <div className="dm-h">How to read the map</div>
            <p className="hint" style={{ margin: 0 }}>
              Every circle is something the documents talk about; the bigger, the more they say about it. A solid line is a relation a
              document declares, a dashed one means one entity&apos;s description names the other. Pick one to see what it holds, what
              must always be true of it, how it changes and which passages say so.
            </p>
          </>
        )}
      </aside>
    </div>
  );
}

function Graph({
  entities,
  edges,
  declaredOnly,
  selected,
  onSelect,
  colour,
}: {
  entities: Entity[];
  edges: ReturnType<typeof mapEdges>;
  declaredOnly: boolean;
  selected: string | null;
  onSelect: (k: string | null) => void;
  colour: (key: string) => string;
}) {
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) {
      d.set(e.from, (d.get(e.from) ?? 0) + 1);
      d.set(e.to, (d.get(e.to) ?? 0) + 1);
    }
    return d;
  }, [edges]);
  // With only declared relations, an entity with none is left out.
  const nodes = useMemo(() => (declaredOnly ? entities.filter((e) => degree.has(e.key)) : entities), [entities, declaredOnly, degree]);
  // The drawing grows with the model, about sixty nodes to a screen, so a
  // big one spreads out instead of piling against the frame; the view starts
  // on all of it and zooms in from there.
  const scale = Math.max(1, Math.sqrt(nodes.length / 60));
  const LW = W * scale;
  const LH = H * scale;
  const placed = useMemo(() => {
    const p = layout(nodes.map((e) => e.key), edges, LW, LH);
    return new Map(p.map((n) => [n.key, n]));
  }, [nodes, edges, LW, LH]);
  const top = useMemo(() => new Set([...nodes].sort((a, b) => (degree.get(b.key) ?? 0) - (degree.get(a.key) ?? 0)).slice(0, 15).map((e) => e.key)), [nodes, degree]);
  const near = selected ? new Set([selected, ...neighbours(selected, edges)]) : null;

  // Pan and zoom by moving the viewBox.
  // Start on what the nodes cover, with a margin for their names.
  const fit = useMemo(() => {
    const ps = [...placed.values()];
    if (ps.length === 0) return { x: 0, y: 0, w: LW, h: LH };
    const pad = 40 * scale;
    let x0 = Math.min(...ps.map((q) => q.x)) - pad;
    let y0 = Math.min(...ps.map((q) => q.y)) - pad;
    let w = Math.max(...ps.map((q) => q.x)) + pad - x0;
    let h = Math.max(...ps.map((q) => q.y)) + pad - y0;
    // Keep the frame's proportions, so nothing is stretched.
    const ratio = W / H;
    if (w / h > ratio) {
      const nh = w / ratio;
      y0 -= (nh - h) / 2;
      h = nh;
    } else {
      const nw = h * ratio;
      x0 -= (nw - w) / 2;
      w = nw;
    }
    return { x: x0, y: y0, w, h };
  }, [placed, LW, LH, scale]);
  const [view, setView] = useState(fit);
  useEffect(() => setView(fit), [fit]);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const toUnits = (dx: number) => (svg.current ? dx * (view.w / svg.current.clientWidth) : dx);
  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const w = Math.min(LW * 2, Math.max(W / 5, view.w * f));
    const h = (w / view.w) * view.h;
    const px = view.x + ((e.clientX - box.left) / box.width) * view.w;
    const py = view.y + ((e.clientY - box.top) / box.height) * view.h;
    setView({ x: px - ((px - view.x) * w) / view.w, y: py - ((py - view.y) * h) / view.h, w, h });
  };
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
    setView((v) => ({ ...v, x: d.vx - toUnits(e.clientX - d.x), y: d.vy - toUnits(e.clientY - d.y) }));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) onSelect(null);
  };

  // Sizes in screen terms at the starting zoom, so a bigger drawing does not
  // shrink its circles and names to dots.
  const unit = fit.w / W;
  const radius = (e: Entity) => (5 + Math.sqrt(e.facts.length) * 2.2) * unit;
  return (
    <svg
      ref={svg}
      className="dm-graph"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      role="img"
      aria-label="Entities and how they connect"
    >
      {edges.map((e) => {
        const a = placed.get(e.from);
        const b = placed.get(e.to);
        if (!a || !b) return null;
        const hot = !!selected && (e.from === selected || e.to === selected);
        return (
          <line
            key={`${e.from}|${e.to}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            className={`dm-edge ${e.kind}${hot ? " hot" : selected ? " cold" : ""}`}
            strokeWidth={Math.min(1 + e.n * 0.5, 4)}
          />
        );
      })}
      {nodes.map((e) => {
        const p = placed.get(e.key);
        if (!p) return null;
        const r = radius(e);
        const cold = !!near && !near.has(e.key);
        const label = near ? near.has(e.key) : top.has(e.key);
        return (
          <g
            key={e.key}
            transform={`translate(${p.x},${p.y})`}
            className={`dm-node${e.key === selected ? " sel" : ""}${cold ? " cold" : ""}`}
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => {
              ev.stopPropagation();
              onSelect(e.key === selected ? null : e.key);
            }}
            role="button"
            tabIndex={0}
            aria-label={e.name}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelect(e.key);
              }
            }}
          >
            <circle r={r} fill={colour(e.key)}>
              <title>{e.name}</title>
            </circle>
            {label && (
              <text x={r + 3 * unit} y={4 * unit} style={{ fontSize: 11 * unit, strokeWidth: 3 * unit }}>
                {e.name}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function EntityCard({
  entity,
  area,
  linked,
  onSelect,
  onOpenFile,
}: {
  entity: Entity;
  area: string;
  linked: Entity[];
  onSelect: (k: string) => void;
  onOpenFile: OpenFile;
}) {
  const definition = entity.facts.find((f) => f.kind === "entity");
  return (
    <>
      <div>
        <div className="hint">{area}</div>
        <h2 style={{ margin: 0 }}>{entity.name}</h2>
        <div className="hint">
          {entity.facts.length} facts from {entity.documents} document{entity.documents === 1 ? "" : "s"}
        </div>
      </div>
      {definition && <blockquote className="sm-quote">{definition.text}</blockquote>}
      {linked.length > 0 && (
        <div className="sm-related">
          Connects to:{" "}
          {linked.map((e) => (
            <button key={e.key} type="button" className="chip" onClick={() => onSelect(e.key)}>
              {e.name}
            </button>
          ))}
        </div>
      )}
      {factsByKind(entity.facts.filter((f) => f !== definition)).map((g) => (
        <section key={g.kind} className="sm-kind">
          <h3>{KIND_TITLE[g.kind] ?? g.kind}</h3>
          {g.facts.map((f, i) => (
            <FactRow key={i} fact={f} onOpenFile={onOpenFile} />
          ))}
        </section>
      ))}
    </>
  );
}

const KIND_TITLE: Record<string, string> = {
  entity: "What it is",
  attribute: "What it holds",
  relation: "How it relates",
  constraint: "Must always be true",
  lifecycle: "How it changes",
  requirement: "Asked of it",
  decision: "Decided",
};

// ── 3 · Requirements ────────────────────────────────────────────────────────

export function RequirementsView({
  read,
  traces,
  work,
  selected,
  onSelect,
  onOpenFile,
}: {
  read: SpecRequirements | { error: string } | null;
  traces: RequirementTraces | { error: string } | null;
  work: WorkLinks | { error: string } | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenFile: OpenFile;
}) {
  const [basis, setBasis] = useState<string>("all");
  const [text, setText] = useState("");
  const traceById = useMemo(
    () => new Map(traces && "items" in traces ? traces.items.map((t) => [t.id, t]) : []),
    [traces],
  );
  const workById = useMemo(() => new Map(work && "items" in work ? work.items.map((w) => [w.id, w.work]) : []), [work]);
  if (!read) return <div className="empty">Loading…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;
  const list = findRequirements(read.items, basis, text);
  const sel = read.items.find((r) => r.id === selected) ?? null;
  const codeOf = (id: string) => traceById.get(id)?.code.length ?? 0;
  const testsOf = (id: string) => traceById.get(id)?.tests.length ?? 0;

  return (
    <div className="dm-reqs">
      <div className="card dm-reqlist">
        <div className="dm-filters">
          <button type="button" className={basis === "all" ? "chip on" : "chip"} onClick={() => setBasis("all")}>
            All <span className="chip-n">{read.total}</span>
          </button>
          {BASIS_ORDER.map((b) => (
            <button key={b} type="button" className={basis === b ? "chip on" : "chip"} onClick={() => setBasis(b)}>
              {BASIS_LABEL[b]} <span className="chip-n">{read.by_basis[b] ?? 0}</span>
            </button>
          ))}
          <input type="search" placeholder="Find by id, title or text" value={text} onChange={(e) => setText(e.target.value)} aria-label="Find a requirement" />
        </div>
        <div className="dm-rows">
          {list.slice(0, 300).map((r) => (
            <button key={r.id} type="button" className={`dm-row${r.id === selected ? " on" : ""}`} onClick={() => onSelect(r.id)}>
              <b>{r.title ?? r.id}</b>
              <span className="dm-marks">
                <Mark n={codeOf(r.id)} what="code" known={!!traces && "items" in traces} />
                <Mark n={(workById.get(r.id) ?? []).length || r.work} what="work" known />
                <Mark n={testsOf(r.id)} what="tests" known={!!traces && "items" in traces} />
              </span>
              <span className="dm-meta">
                <span className={`sm-sev sm-basis-${r.basis}`}>{BASIS_LABEL[r.basis]}</span>
                {r.kind && <span className="sm-sev">{r.kind}</span>}
                {r.priority && <span className="sm-sev">{r.priority}</span>}
                <code className="hint">{r.id}</code>
              </span>
            </button>
          ))}
          {list.length > 300 && <div className="empty">{list.length - 300} more; narrow the search.</div>}
          {list.length === 0 && <div className="empty">Nothing matches.</div>}
        </div>
      </div>
      <aside className="card dm-chain" aria-label="Where the requirement comes from and how far it got">
        {sel ? (
          <Chain r={sel} traces={traces} work={workById.get(sel.id) ?? []} onSelect={onSelect} onOpenFile={onOpenFile} />
        ) : (
          <>
            <div className="dm-h">Trace a requirement</div>
            <p className="hint" style={{ margin: 0 }}>
              Pick a requirement to follow it from the passage that states it, through the documents that use it and the work that names
              it, to the code and tests that carry it.
            </p>
          </>
        )}
      </aside>
    </div>
  );
}

function Mark({ n, what, known }: { n: number; what: string; known: boolean }) {
  return (
    <span className={`dm-mark${n ? " on" : ""}`} title={!known ? `${what}: not read yet` : n ? `${n} ${what}` : `no ${what} yet`}>
      {n ? "✓" : "–"} {what}
    </span>
  );
}

function Block({ text, onSelect }: { text: string; onSelect: (id: string) => void }) {
  const items = blockItems(text);
  const tokens = (item: ReturnType<typeof blockItems>[number]) =>
    item.map((t, i) => {
      switch (t.t) {
        case "done":
          return (
            <span key={i} className="dm-pill dm-ok">
              done
            </span>
          );
        case "todo":
          return (
            <span key={i} className="dm-pill dm-warn">
              to do
            </span>
          );
        case "priority":
          return (
            <span key={i} className="sm-sev">
              {t.v}
            </span>
          );
        case "id":
          return (
            <button key={i} type="button" className="dm-idchip" onClick={() => onSelect(t.v)}>
              {t.v}
            </button>
          );
        case "code":
          return <code key={i}>{t.v}</code>;
        default:
          return <span key={i}>{t.v}</span>;
      }
    });
  if (items.length <= 1) return <div className="dm-block">{items[0] ? tokens(items[0]) : null}</div>;
  return (
    <ul className="dm-block">
      {items.map((item, i) => (
        <li key={i}>{tokens(item)}</li>
      ))}
    </ul>
  );
}

function Chain({
  r,
  traces,
  work,
  onSelect,
  onOpenFile,
}: {
  r: SpecRequirement;
  traces: RequirementTraces | { error: string } | null;
  work: WorkItem[];
  onSelect: (id: string) => void;
  onOpenFile: OpenFile;
}) {
  const trace = traces && "items" in traces ? (traces.items.find((t) => t.id === r.id) ?? null) : null;
  const steps = traceChain(r, trace, work);
  return (
    <>
      <div>
        <code className="hint">{r.id}</code>
        <h2 style={{ margin: "2px 0 4px" }}>{r.title ?? r.id}</h2>
        <span className={`sm-sev sm-basis-${r.basis}`}>{BASIS_LABEL[r.basis]}</span>
        {r.because && <span className="hint"> “{r.because}”</span>}
      </div>
      <Block text={r.text} onSelect={onSelect} />
      {traces && "error" in traces && <div className="hint">The code could not be read: {traces.error}</div>}
      <div className="dm-h" style={{ marginTop: 8 }}>
        From the passage to the code
      </div>
      <ol className="dm-steps">
        {steps.map((s) => (
          <li key={s.label} className={s.on ? "on" : "off"}>
            <b>{s.label}</b>
            {s.sides.slice(0, 6).map((side, i) => (
              <SideLink key={i} side={side} onOpenFile={onOpenFile} />
            ))}
            {s.ids.length > 0 && (
              <div className="dm-ids">
                {s.ids.map((id) => (
                  <button key={id} type="button" className="dm-idchip" onClick={() => onSelect(id)}>
                    {id}
                  </button>
                ))}
              </div>
            )}
            {s.work.map((w, i) => (
              <div key={i} className="sm-work-title">
                {w.url ? (
                  <a href={w.url} target="_blank" rel="noreferrer">
                    {workLabel(w)}
                  </a>
                ) : (
                  workLabel(w)
                )}{" "}
                {w.title} <span className="sm-sev">{workState(w)}</span>
              </div>
            ))}
          </li>
        ))}
      </ol>
    </>
  );
}
