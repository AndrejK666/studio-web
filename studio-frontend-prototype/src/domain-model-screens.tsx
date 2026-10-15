/* The Domain model tab's three views (domain-model-views.ts): what to resolve
 * before building, the model as a map of connected entities, and each
 * requirement followed from its passage to its code. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import {
  cardFields,
  cardSize,
  LAYER_TITLE,
  LAYER_WHAT,
  layerOf,
  placeCards,
  relationEdges,
  weight,
  type DiagramEdge,
  type Layer,
  type PlacedCard,
} from "./domain-layers";
import {
  blockItems,
  findEntities,
  findRequirements,
  mapEdges,
  neighbours,
  readiness,
  RESOLVE_LABEL,
  resolveQueue,
  traceChain,
  type MapEdge,
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
      <p className="dm-howto">
        <b>Decide what blocks a build.</b> Work down the list: fix a document in the editor, or say a finding is fine.
        A tile narrows the list to one kind.
      </p>
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

/** How many entities a layer shows at first: few enough to read. */
const SHOW_STEPS = [25, 40, 80, Infinity] as const;

export function ModelMapView({ entities, onOpenFile }: { entities: Entity[]; onOpenFile: OpenFile }) {
  const [layer, setLayer] = useState<Layer>("domain");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"diagram" | "list">("diagram");
  const [show, setShow] = useState<number>(25);
  const [mentions, setMentions] = useState(false);

  const layerOfKey = useMemo(() => new Map(entities.map((e) => [e.key, layerOf(e)])), [entities]);
  const counts = useMemo(() => {
    const c: Record<Layer, number> = { domain: 0, system: 0, deployment: 0 };
    let hidden = 0;
    for (const l of layerOfKey.values()) l ? c[l]++ : hidden++;
    return { ...c, hidden };
  }, [layerOfKey]);
  const pool = useMemo(
    () => findEntities(entities, query).filter((e) => layerOfKey.get(e.key) === layer),
    [entities, query, layer, layerOfKey],
  );
  const shown = useMemo(() => [...pool].sort((a, b) => weight(b) - weight(a)).slice(0, show), [pool, show]);
  const relations = useMemo(() => relationEdges(entities), [entities]);
  const allMentions = useMemo(() => (mentions ? mapEdges(entities).filter((e) => e.kind === "mentions") : []), [entities, mentions]);
  const edges = useMemo(() => {
    const keep = new Set(shown.map((e) => e.key));
    const rel = relations.filter((e) => keep.has(e.from) && keep.has(e.to));
    const men = allMentions.filter((e) => keep.has(e.from) && keep.has(e.to) && !rel.some((r) => (r.from === e.from && r.to === e.to) || (r.from === e.to && r.to === e.from)));
    return { rel, men };
  }, [shown, relations, allMentions]);
  const sel = entities.find((e) => e.key === selected) ?? null;

  if (entities.length === 0) return <div className="empty">Nothing read yet. Build the model to read the documents.</div>;

  return (
    <div className="dm-layered">
      <p className="dm-howto">
        <b>See what the application is.</b> Pick a layer, then a card: what it holds, how it relates and which passages
        say so. Missing a relation? A document has to declare it; the model reads it on the next build.
      </p>
      <div className="dm-layers" role="tablist" aria-label="Layer">
        {(Object.keys(LAYER_TITLE) as Layer[]).map((l) => (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={layer === l}
            className={`dm-layer dm-layer-${l}${layer === l ? " on" : ""}`}
            onClick={() => {
              setLayer(l);
              setSelected(null);
            }}
          >
            <i />
            <b>{LAYER_TITLE[l]}</b>
            <span className="dm-layer-n">{counts[l]}</span>
            <small>{LAYER_WHAT[l]}</small>
          </button>
        ))}
      </div>
      <p className="hint" style={{ margin: "0 0 8px" }}>
        Left out: {counts.hidden} words that are not things the product has — identifiers such as ADR-0007 or cpt-…, a word
        used once in passing, what a kit&apos;s templates and examples say. They stay in Requirements and the Glossary.
      </p>
      <div className="dm-map2">
        <div className="card dm-canvas">
          <div className="dm-mapbar">
            <input type="search" placeholder="Find an entity" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find an entity" />
            <span className="dm-seg" role="group" aria-label="How many">
              {SHOW_STEPS.map((n) => (
                <button key={n} type="button" aria-pressed={show === n} onClick={() => setShow(n)}>
                  {n === Infinity ? "all" : n === 25 ? "25 main" : n}
                </button>
              ))}
            </span>
            <label className="hint">
              <input type="checkbox" checked={mentions} onChange={(e) => setMentions(e.target.checked)} /> show mentions
            </label>
            <span className="dm-seg" role="group" aria-label="How to show it">
              <button type="button" aria-pressed={mode === "diagram"} onClick={() => setMode("diagram")}>
                Diagram
              </button>
              <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>
                List
              </button>
            </span>
            <span className="hint" style={{ marginLeft: "auto" }}>
              {shown.length} of {pool.length} · {edges.rel.length} declared relation{edges.rel.length === 1 ? "" : "s"}
            </span>
          </div>
          {mode === "diagram" ? (
            <Diagram entities={shown} layer={layer} relations={edges.rel} mentions={edges.men} selected={selected} onSelect={setSelected} />
          ) : (
            <div className="dm-list">
              {shown.map((e) => (
                <button key={e.key} type="button" className={`dm-ent${e.key === selected ? " on" : ""}`} onClick={() => setSelected(e.key)}>
                  <b>{e.name}</b>
                  <span className="hint">
                    {e.facts.length} facts · {e.documents} doc{e.documents === 1 ? "" : "s"}
                  </span>
                </button>
              ))}
            </div>
          )}
          {mode === "diagram" && (
            <div className="dm-legend">
              <span>
                <svg viewBox="0 0 26 8" width="26" height="8" aria-hidden="true">
                  <line x1="0" y1="4" x2="26" y2="4" className="dm-edge relation" />
                </svg>
                a relation a document declares, named by its verb
              </span>
              {mentions && (
                <span>
                  <svg viewBox="0 0 26 8" width="26" height="8" aria-hidden="true">
                    <line x1="0" y1="4" x2="26" y2="4" className="dm-edge mentions" />
                  </svg>
                  one names the other
                </span>
              )}
              <span className="hint">scroll to zoom · drag to move</span>
            </div>
          )}
        </div>
        <aside className="card dm-card" aria-label="The selected entity">
          {sel ? (
            <EntityCard
              entity={sel}
              layer={layerOfKey.get(sel.key) ?? null}
              related={relations
                .filter((r) => r.from === sel.key || r.to === sel.key)
                .map((r) => ({ other: entities.find((e) => e.key === (r.from === sel.key ? r.to : r.from)), verbs: r.verbs }))
                .filter((r): r is { other: Entity; verbs: string[] } => !!r.other)}
              onSelect={(k) => {
                const l = layerOfKey.get(k);
                if (l && l !== layer) setLayer(l);
                setSelected(k);
              }}
              onOpenFile={onOpenFile}
            />
          ) : (
            <>
              <div className="dm-h">{LAYER_TITLE[layer]}</div>
              <p style={{ margin: 0 }}>{LAYER_WHAT[layer]}.</p>
              <p className="hint" style={{ margin: 0 }}>
                The entities the documents say most about and relate most come first. A line is a relation a document
                declares, named by its verb. Pick a card to see what it holds, how it relates, what must always be true of
                it and which passages say so.
              </p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function Diagram({
  entities,
  layer,
  relations,
  mentions,
  selected,
  onSelect,
}: {
  entities: Entity[];
  layer: Layer;
  relations: DiagramEdge[];
  mentions: MapEdge[];
  selected: string | null;
  onSelect: (k: string | null) => void;
}) {
  const cards = useMemo(
    () =>
      entities.map((e) => {
        const fields = cardFields(e);
        return { key: e.key, name: e.name, fields, ...cardSize(e.name, fields) };
      }),
    [entities],
  );
  const placed = useMemo(() => placeCards(cards, relations), [cards, relations]);
  const at = useMemo(() => new Map(placed.cards.map((c) => [c.key, c])), [placed]);
  const near = selected ? new Set([selected, ...neighbours(selected, relations)]) : null;
  const few = entities.length <= 25;

  // Start on the whole drawing, with a margin, at the frame's proportions.
  const fit = useMemo(() => {
    const pad = 40;
    const w = placed.width + 2 * pad;
    const h = placed.height + 2 * pad;
    const ratio = 900 / 620;
    return w / h > ratio
      ? { x: -pad, y: -pad - (w / ratio - h) / 2, w, h: w / ratio }
      : { x: -pad - (h * ratio - w) / 2, y: -pad, w: h * ratio, h };
  }, [placed]);
  const [view, setView] = useState(fit);
  useEffect(() => setView(fit), [fit]);
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const units = (px: number) => (svg.current ? px * (view.w / svg.current.clientWidth) : px);
  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const w = Math.min(fit.w * 2, Math.max(fit.w / 8, view.w * f));
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
    setView((v) => ({ ...v, x: d.vx - units(e.clientX - d.x), y: d.vy - units(e.clientY - d.y) }));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) onSelect(null);
  };

  // A line leaves a card at its centre and bends a little, so two lines
  // between neighbours do not lie on each other.
  const curve = (a: PlacedCard, b: PlacedCard) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (a.x + b.x) / 2 - (dy / len) * 0.12 * len;
    const my = (a.y + b.y) / 2 + (dx / len) * 0.12 * len;
    return { d: `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`, lx: (a.x + b.x) / 2 - (dy / len) * 0.06 * len, ly: (a.y + b.y) / 2 + (dx / len) * 0.06 * len };
  };

  return (
    <svg
      ref={svg}
      className="dm-diagram"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      role="img"
      aria-label={`${LAYER_TITLE[layer]} entities and how they relate`}
    >
      {mentions.map((e) => {
        const a = at.get(e.from);
        const b = at.get(e.to);
        if (!a || !b) return null;
        const cold = !!near && !(near.has(e.from) && near.has(e.to));
        return <path key={`m${e.from}|${e.to}`} d={curve(a, b).d} className={`dm-edge mentions${cold ? " cold" : ""}`} />;
      })}
      {relations.map((e) => {
        const a = at.get(e.from);
        const b = at.get(e.to);
        if (!a || !b) return null;
        const hot = !!selected && (e.from === selected || e.to === selected);
        return <path key={`r${e.from}|${e.to}`} d={curve(a, b).d} className={`dm-edge relation${hot ? " hot" : selected ? " cold" : ""}`} />;
      })}
      {placed.looseTop !== null && (
        <text x={0} y={placed.looseTop} className="dm-loose">
          Not related yet: no document declares how these connect to the rest
        </text>
      )}
      {placed.cards.map((c) => {
        const card = cards.find((x) => x.key === c.key)!;
        const cold = !!near && !near.has(c.key);
        return (
          <g
            key={c.key}
            transform={`translate(${c.x - c.w / 2},${c.y - c.h / 2})`}
            className={`dm-cardnode dm-layer-${layer}${c.key === selected ? " sel" : ""}${cold ? " cold" : ""}`}
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => {
              ev.stopPropagation();
              onSelect(c.key === selected ? null : c.key);
            }}
            role="button"
            tabIndex={0}
            aria-label={card.name}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelect(c.key);
              }
            }}
          >
            <rect className="box" width={c.w} height={c.h} rx={8} />
            <rect className="band" x={1} y={1} width={c.w - 2} height={28} rx={7} />
            <rect className="stripe" x={8} y={6} width={4} height={18} rx={2} />
            <text className="title" x={18} y={19}>
              {card.name}
            </text>
            {card.fields.map((f, i) => (
              <text key={f} className="field" x={12} y={46 + 16 * i}>
                • {f}
              </text>
            ))}
          </g>
        );
      })}
      {relations.map((e) => {
        const a = at.get(e.from);
        const b = at.get(e.to);
        if (!a || !b || e.verbs.length === 0) return null;
        const hot = !!selected && (e.from === selected || e.to === selected);
        if (!few && !hot) return null;
        const { lx, ly } = curve(a, b);
        return (
          <text key={`l${e.from}|${e.to}`} x={lx} y={ly} className="dm-verb" textAnchor="middle">
            {e.verbs.slice(0, 2).join(" / ")}
          </text>
        );
      })}
    </svg>
  );
}

function EntityCard({
  entity,
  layer,
  related,
  onSelect,
  onOpenFile,
}: {
  entity: Entity;
  layer: Layer | null;
  related: { other: Entity; verbs: string[] }[];
  onSelect: (k: string) => void;
  onOpenFile: OpenFile;
}) {
  const definition = entity.facts.find((f) => f.kind === "entity");
  return (
    <>
      <div>
        {layer && <span className={`dm-layer-pill dm-layer-${layer}`}>{LAYER_TITLE[layer]}</span>}
        <h2 style={{ margin: "4px 0 0" }}>{entity.name}</h2>
        <div className="hint">
          {entity.facts.length} facts from {entity.documents} document{entity.documents === 1 ? "" : "s"}
        </div>
      </div>
      {definition && <blockquote className="sm-quote">{definition.text}</blockquote>}
      {related.length > 0 && (
        <section className="dm-rels">
          <div className="dm-h">How it relates</div>
          {related.map((r) => (
            <div key={r.other.key}>
              <b className="dm-verbtext" title={r.verbs.join(" / ")}>
                {r.verbs.length > 3 ? `${r.verbs.slice(0, 3).join(" / ")} …` : r.verbs.join(" / ") || "relates to"}
              </b>{" "}
              <button type="button" className="dm-link" onClick={() => onSelect(r.other.key)}>
                {r.other.name}
              </button>
            </div>
          ))}
        </section>
      )}
      {factsByKind(entity.facts.filter((f) => f !== definition && f.kind !== "relation")).map((g) => (
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
    <>
    <p className="dm-howto">
      <b>Follow a requirement to the code.</b> Pick one: the chain shows the passage that states it, what it rests
      on, the work that names it and where the code and tests carry it. An orange step is where it stops.
    </p>
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
    </>
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
