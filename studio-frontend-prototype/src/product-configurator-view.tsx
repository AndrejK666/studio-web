/* The product as a map (product-configurator.ts): the parts one can add on
 * the left, found by what they do; the product's subsystems in the middle,
 * one zone per gear `category`, each part a gear with sockets for its
 * choices; the selected part on the right, with what it is, why one adds
 * it, its choices and its settings. What the engine added by itself sits in
 * its own zone, and one line on top says what is left to do.
 */
import { useEffect, useMemo, useState, type DragEvent } from "react";

import { api, type GearConfig, type ProductPreview } from "./api";
import { layerOf } from "./domain-layers";
import { entityGears, gearRefs } from "./entity-gears";
import { BringsWithIt } from "./gear-brings-view";
import { GearConfigForm } from "./gear-config-form";
import {
  choosePlugin,
  compose,
  gearFacts,
  indexCatalogue,
  offers,
  removePart,
  subsystemOf,
  subsystems,
  todos,
  type CatalogueIndex,
  type Part,
} from "./product-configurator";
import { gearLabel } from "./product";
import { entitiesOf, type GlossaryEntry } from "./spec-model";

/** What the map needs of the project's product. */
export type ConfiguredProduct = {
  picks: string[];
  config: GearConfig;
  setPicks: (update: (current: string[]) => string[]) => void;
  setField: (gear: string, field: string, value: unknown) => void;
  toggle: (name: string) => void;
  /** Start from these picks, completed by the engine into a set that resolves. */
  seed: (picks: string[]) => Promise<void>;
  /** Complete the current picks. */
  complete: () => Promise<void>;
};

type Catalogue = { index: CatalogueIndex } | { error: string } | null;

/** The engine's catalogue, read once per token; null while it is read. */
export function useGearCatalogue(token: string, on: boolean): Catalogue {
  const [read, setRead] = useState<Catalogue>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    api
      .gearboxCatalogue(token)
      .then((r) => live && setRead({ index: indexCatalogue(r.catalogue) }))
      .catch((e: unknown) => live && setRead({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [token, on]);
  return read;
}

/** The project's Domain entities each catalogue gear keeps, by engine id
 *  (entity-gears.ts): read once the catalogue is there, from the model the
 *  documents were last read into. Empty when there is no model or it cannot
 *  be read: the map does not need it. */
export function useKeptEntities(token: string, projectId: string, index: CatalogueIndex | null): Map<string, string[]> {
  const [kept, setKept] = useState<Map<string, string[]>>(new Map());
  useEffect(() => {
    if (!index) return;
    let live = true;
    Promise.all([
      api.specModel(token, projectId),
      api.glossary(token, projectId).catch(() => ({ items: [] as GlossaryEntry[], total: 0 })),
    ])
      .then(([model, glossary]) => {
        if (!live) return;
        const domain = entitiesOf(model.facts, glossary.items).filter((e) => layerOf(e) === "domain");
        const { byGear } = entityGears(domain, gearRefs(index));
        setKept(new Map([...byGear].map(([id, es]) => [id, es.map((e) => e.name)])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [token, projectId, index]);
  return kept;
}

function Cog({ size = 24 }: { size?: number }) {
  // Eight teeth around a hub.
  const d = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i < 16; i++) {
      const r = i % 2 ? 11 : 14;
      const a0 = (i / 16) * Math.PI * 2 + 0.06;
      const a1 = ((i + 1) / 16) * Math.PI * 2 - 0.06;
      pts.push(`${(16 + r * Math.cos(a0)).toFixed(1)} ${(16 + r * Math.sin(a0)).toFixed(1)}`);
      pts.push(`${(16 + r * Math.cos(a1)).toFixed(1)} ${(16 + r * Math.sin(a1)).toFixed(1)}`);
    }
    return `M${pts.join("L")}Z`;
  }, []);
  return (
    <svg className="pm-cog" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path d={d} fill="currentColor" opacity={0.15} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" />
      <circle cx={16} cy={16} r={4.2} fill="none" stroke="currentColor" strokeWidth={1.6} />
    </svg>
  );
}

export function ProductConfigurator({
  token,
  index,
  product,
  preview,
  stale,
  busy,
  onBuild,
  onOpen,
  kept,
}: {
  token: string;
  index: CatalogueIndex;
  /** The Domain entities each gear keeps, by engine id (useKeptEntities). */
  kept?: Map<string, string[]>;
  product: ConfiguredProduct;
  /** The engine's last answer about this product, if any. */
  preview: Pick<ProductPreview, "gears" | "ok" | "diagnostics" | "applications" | "profile"> | null;
  /** The answer is about a product that has changed since. */
  stale: boolean;
  busy: boolean;
  onBuild: () => void;
  /** Open a gear's catalogue page, when the portal can. */
  onOpen?: (name: string) => void;
}) {
  const { picks, config } = product;
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const composition = useMemo(() => compose(index, picks, config, preview), [index, picks, config, preview]);
  const zones = useMemo(() => subsystems(index), [index]);
  const left = todos(composition);
  const chosen = composition.parts.find((p) => p.name === selected) ?? null;

  const add = (name: string) => {
    if (busy || picks.includes(name)) return;
    setSelected(name);
    // Completion fills the new part's slots and brings what it needs.
    void product.seed([...picks, name]);
  };
  const targetZone = dragging ? subsystemOf(index.find(dragging) ?? {}) : null;
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const name = e.dataTransfer.getData("text/plain") || dragging;
    setDragging(null);
    if (name) add(name);
  };

  // Only zones with a part in them, plus the one a dragged part would land in.
  const shown = zones.filter((z) => z === targetZone || composition.parts.some((p) => p.category === z));
  const errors = preview?.diagnostics.filter((d) => d.severity === "error").length ?? 0;

  return (
    <div className="pm" data-configurator>
      <div className="pm-status" role="status">
        {composition.parts.length === 0 ? (
          <span className="pm-pill">Empty</span>
        ) : left.length > 0 ? (
          <>
            <span className="pm-pill todo">
              {left.length} thing{left.length === 1 ? "" : "s"} to finish
            </span>
            <ul>
              {left.map((t) => (
                <li key={t.text}>
                  <button type="button" onClick={() => setSelected(t.part)}>
                    {t.text}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : preview && !stale && !preview.ok ? (
          <>
            <span className="pm-pill todo">The engine cannot build it yet</span>
            <span>
              {errors} problem{errors === 1 ? "" : "s"}, listed under Engine details.
            </span>
            <button type="button" className="ghost" disabled={busy} onClick={() => void product.complete()}>
              Fix it for me
            </button>
          </>
        ) : preview && !stale && preview.ok ? (
          <>
            <span className="pm-pill ok">✓ Ready to build</span>
            <button type="button" className="primary" disabled={busy} onClick={onBuild}>
              Build it
            </button>
          </>
        ) : (
          <span className="pm-pill">{busy ? "Checking…" : "Not checked yet"}</span>
        )}
        <span className="pm-summary">
          {composition.parts.length} part{composition.parts.length === 1 ? "" : "s"} you chose ·{" "}
          {composition.automatic.length} added for you
          {preview && !stale && preview.applications.length > 0
            ? ` · runs as ${preview.applications.length} application${preview.applications.length === 1 ? "" : "s"} (${preview.profile})`
            : ""}
        </span>
      </div>

      <div className="pm-work">
        <Palette token={token} index={index} product={product} onAdd={add} onDrag={setDragging} />

        <div className="pm-box">
          <div className="pm-h">Product map</div>
          <div
            className={`pm-zones${dragging ? " over" : ""}`}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={onDrop}
          >
            {shown.length === 0 && (
              <div className="pm-zone target" style={{ gridColumn: "1 / -1" }}>
                <div className="pm-hint">
                  Drag a part here from the left, or press Add. It lands in its subsystem.
                </div>
              </div>
            )}
            {shown.map((z) => {
              const parts = composition.parts.filter((p) => p.category === z);
              return (
                <section key={z} className={`pm-zone${z === targetZone ? " target" : ""}`} data-zone={z} aria-label={z}>
                  <header>
                    <b>{z}</b>
                    <span>{parts.length || ""}</span>
                  </header>
                  {parts.length === 0 && <div className="pm-hint">Drop it here</div>}
                  {parts.map((p) => (
                    <Tile key={p.name} part={p} keeps={kept?.get(p.id)} selected={p.name === selected} onSelect={() => setSelected(p.name)} />
                  ))}
                </section>
              );
            })}
            {composition.automatic.length > 0 && (
              <section className="pm-zone" style={{ background: "transparent" }} aria-label="Added for you">
                <header>
                  <b>Added for you</b>
                  <span>{composition.automatic.length}</span>
                </header>
                {composition.automatic.map((a) => (
                  <div key={a.id} className="pm-tile auto" title={a.why}>
                    <Cog size={22} />
                    <b>{a.label}</b>
                    <small>{a.why}</small>
                  </div>
                ))}
              </section>
            )}
          </div>
          {composition.unknown.length > 0 && (
            <p className="hint" style={{ fontSize: 12, marginBottom: 0 }} data-unknown>
              Not in the gear catalogue, so left out:{" "}
              {composition.unknown.map((n) => (
                <span key={n} style={{ marginRight: 8 }}>
                  <code>{gearLabel(n)}</code>{" "}
                  <button type="button" className="pm-link" onClick={() => product.toggle(n)}>
                    remove
                  </button>
                </span>
              ))}
            </p>
          )}
        </div>

        <Inspector
          token={token}
          index={index}
          part={chosen}
          keeps={chosen ? kept?.get(chosen.id) : undefined}
          product={product}
          busy={busy}
          onOpen={onOpen}
          onRemove={(p) => {
            setSelected(null);
            product.setPicks((current) => removePart(current, p));
          }}
        />
      </div>
    </div>
  );
}

/** "Keeps: Project, Workspace and 2 more": the Domain entities a part stores. */
function keepsLine(keeps: string[], max = 3): string {
  const shown = keeps.slice(0, max).join(", ");
  return keeps.length > max ? `${shown} and ${keeps.length - max} more` : shown;
}

function Tile({
  part,
  keeps,
  selected,
  onSelect,
}: {
  part: Part;
  keeps?: string[];
  selected: boolean;
  onSelect: () => void;
}) {
  const open = part.unset.length > 0 || part.slots.some((s) => s.chosen.length === 0 || s.unset.length > 0);
  return (
    <button type="button" className={`pm-tile${selected ? " selected" : ""}`} onClick={onSelect} data-part={part.name}>
      {open && <span className="pm-flag" title="Needs something from you" />}
      <Cog size={24} />
      <b>{part.label}</b>
      <small>{part.description ?? (part.plugsInto ? `Plugs into ${part.plugsInto}` : gearLabel(part.name))}</small>
      {keeps && keeps.length > 0 && (
        <small data-keeps title={`Domain entities it keeps: ${keeps.join(", ")}`}>
          <b>Keeps:</b> {keepsLine(keeps)}
        </small>
      )}
      {part.slots.length > 0 && (
        <span className="pm-sockets">
          {part.slots.map((s) => {
            const c = s.options.find((o) => o.name === s.chosen[0]);
            return (
              <span key={s.key} className={`pm-socket${c ? "" : " empty"}`} title={s.label}>
                <i />
                {c ? c.label : `choose ${s.label}`}
              </span>
            );
          })}
        </span>
      )}
    </button>
  );
}

function Palette({
  token,
  index,
  product,
  onAdd,
  onDrag,
}: {
  token: string;
  index: CatalogueIndex;
  product: ConfiguredProduct;
  onAdd: (name: string) => void;
  onDrag: (name: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<string | null>(null);
  const [looking, setLooking] = useState<string | null>(null);
  const all = offers(index, product.picks, query);
  const groups = only ? all.filter((g) => g.category === only) : all;
  return (
    <div className="pm-box pm-palette" aria-label="Parts you can add">
      <div className="pm-h">Parts you can add</div>
      <input
        type="search"
        id="pm-find"
        placeholder="What should it do? files, chat, billing…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Find a part"
      />
      <div className="pm-chips">
        {[null, ...all.map((g) => g.category)].map((c) => (
          <button key={c ?? "*"} type="button" className="pm-chip" aria-pressed={only === c} onClick={() => setOnly(c)}>
            {c ?? "All"}
          </button>
        ))}
      </div>
      {groups.length === 0 && <div className="empty">Nothing matches. Try other words.</div>}
      {groups.map((g) => (
        <div key={g.category} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {!only && <div className="pm-h" style={{ margin: "4px 0 0" }}>{g.category}</div>}
          {g.items.map((o) => (
            <div
              key={o.name}
              className="pm-offer"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", o.name);
                e.dataTransfer.effectAllowed = "copy";
                onDrag(o.name);
              }}
              onDragEnd={() => onDrag(null)}
              data-offer={o.name}
            >
              <Cog size={18} />
              <b>{o.label}</b>
              <button type="button" className="ghost" style={{ fontSize: 11, padding: "0 6px" }} onClick={() => onAdd(o.name)}>
                Add
              </button>
              <p>
                {o.description || gearFacts(index, index.find(o.name)!).join(" ") || gearLabel(o.name)}
                {o.maturity && o.maturity !== "stable" ? ` · ${o.maturity}` : ""}{" "}
                <button type="button" className="pm-link" style={{ fontSize: 11 }} onClick={() => setLooking(looking === o.name ? null : o.name)}>
                  what comes with it
                </button>
              </p>
              {looking === o.name && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <BringsWithIt
                    token={token}
                    picks={product.picks}
                    config={product.config}
                    candidate={o.name}
                    onClose={() => setLooking(null)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Inspector({
  token,
  index,
  part,
  keeps,
  product,
  busy,
  onOpen,
  onRemove,
}: {
  token: string;
  index: CatalogueIndex;
  part: Part | null;
  keeps?: string[];
  product: ConfiguredProduct;
  busy: boolean;
  onOpen?: (name: string) => void;
  onRemove: (part: Part) => void;
}) {
  if (!part) {
    return (
      <div className="pm-box pm-inspector" aria-label="About the selected part">
        <div className="pm-h">How it works</div>
        <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, color: "var(--muted-foreground)" }}>
          <li>Find a part on the left by what the product should do.</li>
          <li>Drag it onto the map, or press Add. It lands in its subsystem.</li>
          <li>Where a part has a choice, the recommended one is already picked; click the part to change it.</li>
          <li>Do what the line on top asks for, then build.</li>
        </ol>
      </div>
    );
  }
  const gear = index.find(part.name);
  const facts = gear ? gearFacts(index, gear) : [];
  const own = [part.name, ...part.slots.flatMap((s) => s.chosen)];
  const scoped = {
    picks: own,
    config: Object.fromEntries(Object.entries(product.config).filter(([k]) => own.includes(k))),
    setField: product.setField,
  };
  return (
    <div className="pm-box pm-inspector" aria-label={`About ${part.label}`}>
      <h3>
        <Cog size={24} />
        {part.label}
      </h3>
      <div style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
        {part.category}
        {part.maturity && part.maturity !== "stable" ? ` · ${part.maturity}` : ""} · <code>{gearLabel(part.name)}</code>
        {onOpen && (
          <>
            {" "}
            ·{" "}
            <button type="button" className="pm-link" onClick={() => onOpen(part.name)}>
              catalogue page
            </button>
          </>
        )}
      </div>
      <div className="pm-why">
        {part.description ?? "Its gear.gdl does not say what it is for yet. What is known of it:"}
      </div>
      {keeps && keeps.length > 0 && (
        <div data-keeps>
          <b>Keeps:</b> {keeps.join(", ")}
          <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}> — from this project&apos;s domain model</span>
        </div>
      )}
      {facts.length > 0 && (
        <ul className="pm-facts">
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {part.plugsInto && <div>Plugs into {part.plugsInto}, which comes along with it.</div>}
      {part.slots.map((s) => (
        <section key={s.key} data-slot={s.label}>
          <b>{s.label}</b>
          {s.options.length === 0 && (
            <div style={{ color: "var(--destructive)" }}>Nothing in the catalogue fills this.</div>
          )}
          {s.options.map((o) => (
            <label key={o.name} className="pm-choice">
              <input
                type="radio"
                name={`${part.name}-${s.key}`}
                checked={s.chosen.includes(o.name)}
                disabled={busy}
                onChange={() => product.setPicks((current) => choosePlugin(current, s, o.name))}
              />
              <span>
                <b>{o.label}</b>
                {o.name === s.recommended && <em>recommended</em>}
              </span>
              {o.description && <small>{o.description}</small>}
            </label>
          ))}
        </section>
      ))}
      <section>
        <b>Settings</b>
        <GearConfigForm token={token} product={scoped} />
      </section>
      <div style={{ display: "flex" }}>
        <button
          type="button"
          className="ghost"
          style={{ marginLeft: "auto", color: "var(--destructive)" }}
          disabled={busy}
          onClick={() => onRemove(part)}
        >
          Remove from the product
        </button>
      </div>
    </div>
  );
}
