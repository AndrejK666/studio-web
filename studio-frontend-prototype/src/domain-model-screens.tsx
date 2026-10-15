/* The Domain model tab's three views (domain-model-views.ts): what to resolve
 * before building, the model as a map of connected entities, and each
 * requirement followed from its passage to its code. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import type { SpecModelEntityEdit, SpecModelWrite } from "./api";
import {
  cardFields,
  cardSize,
  entityDraft,
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
import { DOC_QUALITY_LABEL, docQuality, type DocQualityItem, type DocQualityType } from "./doc-quality";
import { PROVISIONAL_NOTE } from "./saved-entities";
import { entityGears, type GearRef, type Keeper } from "./entity-gears";
import { gearDraftFrom, type GearDraft } from "./gear-from-entity";
import {
  BASIS_LABEL,
  BASIS_ORDER,
  codeSpans,
  factsByKind,
  sideLabel,
  workLabel,
  workState,
  type Entity,
  type GlossaryEntry,
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
        {fact.provisional && <span className="sm-status dm-provisional">{PROVISIONAL_NOTE}</span>}
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
  entities = [],
  glossary = [],
  onDecide,
  onPropose,
  onSave,
  onSameThing,
  onTrace,
  onOpenFile,
  built,
}: {
  findings: SpecModelFinding[];
  requirements: SpecRequirements | null;
  /** The model's entities, saved edits laid over: what the documentation
   *  could say better is read off them. */
  entities?: Entity[];
  glossary?: GlossaryEntry[];
  /** Save an entity's section of docs/domain-model.md. */
  onSave?: (edit: SpecModelEntityEdit) => Promise<SpecModelWrite>;
  /** Read the second word as the first everywhere (the glossary's merge). */
  onSameThing?: (alias: string, of: string) => Promise<void>;
  onDecide: (f: SpecModelFinding, d: "confirmed" | "dismissed") => void;
  /** Open a pull request with a finding's fix on its document. */
  onPropose?: (f: SpecModelFinding) => Promise<SpecModelWrite>;
  /** Follow a requirement in the Requirements view. */
  onTrace: (id: string) => void;
  onOpenFile: OpenFile;
  built: boolean;
}) {
  const [only, setOnly] = useState<Only>("all");
  const queue = useMemo(() => resolveQueue(findings, requirements?.items ?? []), [findings, requirements]);
  // Kept apart from the queue's readiness: a thin passage does not stop a
  // build, it makes the next reader's job harder.
  const better = useMemo(() => docQuality(entities, glossary), [entities, glossary]);
  const ready = readiness(queue, requirements?.by_basis ?? {}, requirements?.total ?? 0);
  const count = (t: ResolveType) => queue.filter((i) => i.type === t && !i.done).length;
  const countDoc = (t: DocQualityType) => better.filter((i) => i.type === t).length;
  const isDoc = (o: Only): o is DocQualityType => o in DOC_QUALITY_LABEL;
  const shown = isDoc(only) ? [] : queue.filter((i) => only === "all" || i.type === only);
  const shownDoc = only === "all" ? better : isDoc(only) ? better.filter((i) => i.type === only) : [];
  const room = Math.max(0, 80 - shown.length);
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
      {better.length > 0 && (
        <div className="dm-ready dm-ready-docs">
          <div className="dm-tile dm-verdict">
            <b>Make the documentation better</b>
            <span>
              {better.length} change{better.length === 1 ? "" : "s"} ready to save. None blocks a build; each makes the model
              clearer to the next reader.
            </span>
          </div>
          <Tile type="onlyadr" n={countDoc("onlyadr")} label="only in an ADR or a feature" tone="warn" only={only} setOnly={setOnly} />
          <Tile type="nodefinition" n={countDoc("nodefinition")} label="things with no definition" tone="warn" only={only} setOnly={setOnly} />
          <Tile type="onesided" n={countDoc("onesided")} label="one-sided relations" tone="warn" only={only} setOnly={setOnly} />
          <Tile type="twonames" n={countDoc("twonames")} label="two names for one thing" tone="warn" only={only} setOnly={setOnly} />
        </div>
      )}

      <div className="dm-queue-head">
        <b>{only === "all" ? "Everything to decide, most blocking first" : isDoc(only) ? DOC_QUALITY_LABEL[only] : RESOLVE_LABEL[only]}</b>
        {only !== "all" && (
          <button type="button" className="dm-link" onClick={() => setOnly("all")}>
            show all
          </button>
        )}
        <span className="hint">{shown.length + shownDoc.length} shown</span>
      </div>
      {shown.length + shownDoc.length === 0 && (
        <div className="empty">
          {built ? "Nothing to decide here." : "Every reference resolves. Build the model to look for disagreements between documents."}
        </div>
      )}
      <div className="dm-queue">
        {shown.slice(0, 80).map((i) => (
          <QueueItem key={i.key} item={i} onDecide={onDecide} onPropose={onPropose} onTrace={onTrace} onOpenFile={onOpenFile} />
        ))}
        {shownDoc.slice(0, room).map((i) => (
          <DocItem key={i.key} item={i} onSave={onSave} onSameThing={onSameThing} onOpenFile={onOpenFile} />
        ))}
        {shown.length + shownDoc.length > 80 && (
          <p className="hint">and {shown.length + shownDoc.length - 80} more; pick a tile above to narrow it.</p>
        )}
      </div>
    </div>
  );
}

/** What a tile narrows the list to. */
type Only = ResolveType | DocQualityType | "all";

function Tile({
  type,
  n,
  label,
  tone,
  only,
  setOnly,
}: {
  type: ResolveType | DocQualityType;
  n: number;
  label: string;
  tone: "bad" | "warn";
  only: Only;
  setOnly: (t: Only) => void;
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
  onPropose,
  onTrace,
  onOpenFile,
}: {
  item: ResolveItem;
  onDecide: (f: SpecModelFinding, d: "confirmed" | "dismissed") => void;
  onPropose?: (f: SpecModelFinding) => Promise<SpecModelWrite>;
  onTrace: (id: string) => void;
  onOpenFile: OpenFile;
}) {
  const f = item.finding;
  const [proposal, setProposal] = useState<{ busy: boolean; done?: SpecModelWrite; error?: string } | null>(null);
  const propose = async () => {
    if (!f || !onPropose) return;
    setProposal({ busy: true });
    try {
      setProposal({ busy: false, done: await onPropose(f) });
    } catch (e) {
      setProposal({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
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
              {f.edit && onPropose && !proposal?.done && (
                <button type="button" className="primary" disabled={proposal?.busy} onClick={() => void propose()} title="Open a pull request with this change on the document">
                  {proposal?.busy ? "Proposing…" : "Propose this change"}
                </button>
              )}
              {proposal?.done && (
                <span className="dm-saved">
                  ✓ Proposed{" "}
                  {proposal.done.pr_url ? (
                    <a href={proposal.done.pr_url} target="_blank" rel="noreferrer">
                      as a pull request
                    </a>
                  ) : (
                    <>on {proposal.done.branch}</>
                  )}
                </span>
              )}
              {proposal?.error && <span className="error-inline">{proposal.error}</span>}
              {f.sides[0] && onOpenFile && (
                <button type="button" className={f.edit && onPropose ? "ghost" : "primary"} onClick={() => onOpenFile(f.sides[0].path)}>
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

/** A change that makes the documentation better, ready to save. The text it
 *  proposes is editable first; saving it goes through the same call as the
 *  model map's editor, and the item leaves the list at once because the tab
 *  lays the saved entity over the model (saved-entities.ts). */
function DocItem({
  item,
  onSave,
  onSameThing,
  onOpenFile,
}: {
  item: DocQualityItem;
  onSave?: (edit: SpecModelEntityEdit) => Promise<SpecModelWrite>;
  onSameThing?: (alias: string, of: string) => Promise<void>;
  onOpenFile: OpenFile;
}) {
  const [edit, setEdit] = useState(item.edit ?? null);
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const run = async (act: () => Promise<unknown>) => {
    setState({ busy: true });
    try {
      await act();
      setState({ busy: false });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  // The relation a one-sided item adds is the last of the draft's.
  const added = item.type === "onesided" && edit ? edit.relations[edit.relations.length - 1] : null;
  const pair = item.pair;
  return (
    <article className="card dm-item" data-item={item.key}>
      <header>
        <span className="dm-pill dm-warn">{DOC_QUALITY_LABEL[item.type]}</span>
        <b>{item.title}</b>
      </header>
      <div className="hint">{item.hint}</div>
      {item.sides.length > 0 && (
        <div className="sm-sides sm-two">
          {item.sides.map((s, i) => (
            <SideLink key={i} side={s} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
      {edit && !added && (
        <label className="dm-field">
          <span>What it is, as {edit.name}&apos;s section of docs/domain-model.md will say</span>
          <textarea rows={2} value={edit.definition ?? ""} onChange={(e) => setEdit({ ...edit, definition: e.target.value })} />
        </label>
      )}
      {edit && added && (
        <div className="dm-field">
          <span>Added to {edit.name}&apos;s section of docs/domain-model.md</span>
          <div className="dm-inverse">
            <b>{edit.name}</b>
            <input
              aria-label="Verb"
              value={added.verb}
              onChange={(e) => setEdit({ ...edit, relations: edit.relations.map((r) => (r === added ? { ...r, verb: e.target.value } : r)) })}
            />
            <b>{added.target}</b>
          </div>
        </div>
      )}
      <div className="dm-actions">
        {edit && onSave && (
          <button
            type="button"
            className="primary"
            disabled={state.busy || (added ? !added.verb.trim() : !edit.definition?.trim())}
            onClick={() => void run(() => onSave({ ...edit, definition: edit.definition?.trim() || null }))}
            title="Save the entity's section of docs/domain-model.md, the way the repository takes changes"
          >
            {state.busy ? "Saving…" : item.type === "nodefinition" ? "Save definition" : item.type === "onesided" ? "Add the other side" : "Add to the domain model"}
          </button>
        )}
        {pair && onSameThing && (
          <button type="button" className="primary" disabled={state.busy} onClick={() => void run(() => onSameThing(pair.b.key, pair.a.key))} title={`Read “${pair.b.name}” as “${pair.a.name}”`}>
            Same thing
          </button>
        )}
        {state.error && <span className="error-inline">{state.error}</span>}
      </div>
    </article>
  );
}

// ── 2 · Model map ───────────────────────────────────────────────────────────

/** How many entities a layer shows at first: few enough to read. */
const SHOW_STEPS = [25, 40, 80, Infinity] as const;

export function ModelMapView({
  entities,
  onOpenFile,
  onSave,
  saved = new Map(),
  gears,
  onCreateGear,
}: {
  entities: Entity[];
  onOpenFile: OpenFile;
  /** Save an edited entity to the project's documentation. */
  onSave?: (edit: SpecModelEntityEdit) => Promise<SpecModelWrite>;
  /** What was saved this visit, by key: shown until the next build reads it. */
  saved?: Map<string, SpecModelWrite>;
  /** The gears that could keep a Domain entity; null while unknown, so no gap is claimed. */
  gears?: GearRef[] | null;
  /** Open the project's Product tab with a gear for an entity drafted. */
  onCreateGear?: (draft: GearDraft) => void;
}) {
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
  // Only what the product is about is kept by a gear; System and Deployment
  // entities are the gears and where they run.
  const keepers = useMemo(
    () => (gears ? entityGears(entities.filter((e) => layerOfKey.get(e.key) === "domain"), gears).byEntity : null),
    [entities, gears, layerOfKey],
  );
  const gaps = useMemo(
    () => new Set(keepers ? [...keepers].filter(([, k]) => k === null).map(([key]) => key) : []),
    [keepers],
  );
  // The gaps as a list, the most described first: the ones a gear is most
  // clearly owed.
  const gapEntities = useMemo(
    () => entities.filter((e) => gaps.has(e.key)).sort((a, b) => weight(b) - weight(a)),
    [entities, gaps],
  );

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
      {layer === "domain" && onCreateGear && gapEntities.length > 1 && (
        <details className="dm-gaps hint" style={{ margin: "0 0 8px" }}>
          <summary style={{ cursor: "pointer" }}>
            {gapEntities.length} entities have no gear — create gears
          </summary>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {gapEntities.map((e) => (
              <li key={e.key} data-gap={e.key}>
                <button type="button" className="dm-link" onClick={() => setSelected(e.key)}>
                  {e.name}
                </button>{" "}
                ·{" "}
                <button type="button" className="dm-link" onClick={() => onCreateGear(gearDraftFrom(e))}>
                  Create a gear for it
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
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
            <Diagram entities={shown} layer={layer} relations={edges.rel} mentions={edges.men} selected={selected} onSelect={setSelected} gaps={gaps} />
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
              {layer === "domain" && gaps.size > 0 && (
                <span>
                  <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
                    <circle cx="5" cy="5" r="3.5" className="nogear" style={{ fill: "none", stroke: "var(--warning)", strokeWidth: 1.6 }} />
                  </svg>
                  no gear keeps it yet
                </span>
              )}
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
              key={sel.key}
              entity={sel}
              names={entities.filter((e) => layerOfKey.get(e.key)).map((e) => e.name)}
              saved={sel.keys.map((k) => saved.get(k)).find((w) => !!w) ?? null}
              onSave={onSave}
              layer={layerOfKey.get(sel.key) ?? null}
              keeper={keepers?.get(sel.key)}
              onCreateGear={onCreateGear}
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
  gaps,
}: {
  entities: Entity[];
  layer: Layer;
  relations: DiagramEdge[];
  mentions: MapEdge[];
  selected: string | null;
  onSelect: (k: string | null) => void;
  /** Entities no gear keeps: marked with a small hollow dot. */
  gaps?: Set<string>;
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
            {gaps?.has(c.key) && (
              <circle className="nogear" cx={c.w - 11} cy={15} r={4}>
                <title>No gear keeps it yet</title>
              </circle>
            )}
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
  names,
  saved,
  onSave,
  onSelect,
  onOpenFile,
  keeper,
  onCreateGear,
}: {
  entity: Entity;
  layer: Layer | null;
  /** The gear that keeps it; null when none does; undefined when not asked. */
  keeper?: Keeper | null;
  onCreateGear?: (draft: GearDraft) => void;
  related: { other: Entity; verbs: string[] }[];
  /** Every entity's name, for a relation's target. */
  names: string[];
  saved: SpecModelWrite | null;
  onSave?: (edit: SpecModelEntityEdit) => Promise<SpecModelWrite>;
  onSelect: (k: string) => void;
  onOpenFile: OpenFile;
}) {
  const definition = entity.facts.find((f) => f.kind === "entity");
  const [editing, setEditing] = useState(false);
  if (editing && onSave)
    return <EntityEditor entity={entity} names={names} onSave={onSave} onDone={() => setEditing(false)} />;
  return (
    <>
      <div>
        {layer && <span className={`dm-layer-pill dm-layer-${layer}`}>{LAYER_TITLE[layer]}</span>}
        {onSave && (
          <button type="button" className="ghost" style={{ float: "right" }} onClick={() => setEditing(true)} title="Correct what it is, what it holds or how it relates">
            Edit
          </button>
        )}
        <h2 style={{ margin: "4px 0 0" }}>{entity.name}</h2>
        {saved && <SavedNote saved={saved} />}
        <div className="hint">
          {entity.facts.length} facts from {entity.documents} document{entity.documents === 1 ? "" : "s"}
        </div>
      </div>
      {definition && (
        <blockquote className="sm-quote">
          {definition.text}
          {definition.provisional && <span className="sm-status dm-provisional">{PROVISIONAL_NOTE}</span>}
        </blockquote>
      )}
      {keeper && (
        <div className="dm-keeper" data-keeper={keeper.gear.id}>
          Kept by <b>{keeper.gear.label}</b>
          {keeper.gear.origin === "project" ? " (this project's gear)" : ""}
          <small>{keeper.why}</small>
        </div>
      )}
      {keeper === null && (
        <div className="dm-keeper gap" data-keeper="">
          <b>No gear keeps it.</b> Nothing in the gear catalogue or this project is named for it or says it in its
          description, so the product has nowhere to store it yet.
          {onCreateGear && (
            <div style={{ marginTop: 4 }}>
              <button type="button" className="dm-link" onClick={() => onCreateGear(gearDraftFrom(entity))}>
                Create a gear for it
              </button>
            </div>
          )}
        </div>
      )}
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

/** Where a saved edit went, and when the model will show it. */
function SavedNote({ saved }: { saved: SpecModelWrite }) {
  return (
    <div className="dm-saved">
      ✓ Saved to <code>{saved.path}</code>{" "}
      {saved.pr_url ? (
        <a href={saved.pr_url} target="_blank" rel="noreferrer">
          as a pull request
        </a>
      ) : (
        <>on {saved.branch}</>
      )}
      . The model reads it on its next build.
    </div>
  );
}

/** Correct an entity: what it is, what it holds, how it relates. Saved as
 *  its section of docs/domain-model.md, the way the repository takes changes. */
function EntityEditor({
  entity,
  names,
  onSave,
  onDone,
}: {
  entity: Entity;
  names: string[];
  onSave: (edit: SpecModelEntityEdit) => Promise<SpecModelWrite>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(() => entityDraft(entity));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = `dm-names-${entity.key.replace(/\W+/g, "-")}`;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: draft.name,
        definition: draft.definition.trim() || null,
        fields: draft.fields.filter((f) => f.name.trim()),
        relations: draft.relations.filter((r) => r.verb.trim() && r.target.trim()),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="dm-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="dm-h">Edit {entity.name}</div>
      <p className="hint" style={{ margin: 0 }}>
        Saved to <code>docs/domain-model.md</code> in the project&apos;s repository, one section per entity. The model reads
        it on its next build.
      </p>
      <label className="dm-field">
        <span>What it is</span>
        <textarea rows={3} value={draft.definition} onChange={(e) => setDraft({ ...draft, definition: e.target.value })} placeholder={`A ${entity.name} is …`} />
      </label>
      <div className="dm-field">
        <span>What it holds</span>
        {draft.fields.map((f, i) => (
          <div key={i} className="dm-row2">
            <input aria-label="Field" value={f.name} placeholder="field" onChange={(e) => setDraft({ ...draft, fields: draft.fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <input aria-label="What it holds" value={f.meaning} placeholder="what it holds" onChange={(e) => setDraft({ ...draft, fields: draft.fields.map((x, j) => (j === i ? { ...x, meaning: e.target.value } : x)) })} />
            <button type="button" className="ghost" aria-label="Remove field" onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}
        <button type="button" className="dm-link" onClick={() => setDraft({ ...draft, fields: [...draft.fields, { name: "", meaning: "" }] })}>
          + field
        </button>
      </div>
      <div className="dm-field">
        <span>How it relates</span>
        <datalist id={listId}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {draft.relations.map((r, i) => (
          <div key={i} className="dm-row2">
            <input aria-label="Verb" value={r.verb} placeholder="belongs to" onChange={(e) => setDraft({ ...draft, relations: draft.relations.map((x, j) => (j === i ? { ...x, verb: e.target.value } : x)) })} />
            <input aria-label="Entity" list={listId} value={r.target} placeholder="entity" onChange={(e) => setDraft({ ...draft, relations: draft.relations.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)) })} />
            <button type="button" className="ghost" aria-label="Remove relation" onClick={() => setDraft({ ...draft, relations: draft.relations.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}
        <button type="button" className="dm-link" onClick={() => setDraft({ ...draft, relations: [...draft.relations, { verb: "", target: "" }] })}>
          + relation
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="dm-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save to the documentation"}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
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
