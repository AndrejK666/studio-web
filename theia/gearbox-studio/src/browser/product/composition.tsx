import React from "@theia/core/shared/react";
import type { ProductState } from "../product-store";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import { pointKey, pointsOf } from "../../common/extension-points";
import { describeInclusion } from "./inclusion";
import { gearHealth, inclusionChip, plural } from "./product-summary";
import type { Selection } from "../shell/selection-service";
import type { RevealService } from "../reveal-service";

export interface CompositionProps {
  state: ProductState;
  loadingLabel?: string;
  descriptors: readonly GearDescriptor[];
  selection: Selection | undefined;
  select: (selection: Selection) => void;
  add: (host?: string, point?: string) => void;
  create: () => void;
  remove: (host: string, entryIndex?: number) => void;
  settings: React.ReactNode;
  expanded: ReadonlySet<string>;
  toggleFold: (host: string) => void;
  reveals: RevealService;
}

/**
 * One gear's row: its name, one muted line under it, and on the right its
 * health and how many plugins it carries.
 *
 * The health is the worst diagnostic whose `subject` names this gear
 * (`gearHealth`); a problem about a binding or a profile marks no row, and is
 * on Checks. The "⋯" beside the row shows on hover and on focus (index.css).
 */
function GearRowText({ name, line, health, plugins }: {
  readonly name: string;
  readonly line: string | undefined;
  readonly health: "error" | "warning" | undefined;
  readonly plugins: number;
}): React.ReactElement {
  const healthWords = health === "error" ? "Has conflicts" : "Has warnings";
  return <>
    <span className="codicon codicon-package" aria-hidden />
    <span className="gbx-gear-row-text">
      <span className="gbx-gear-row-name">{name}</span>
      {line && <span className="gbx-gear-row-line">{line}</span>}
    </span>
    {health !== undefined &&
      <span className={`gbx-status-dot gbx-status-dot-${health}`} data-gear-health={health} role="img" aria-label={healthWords} title={healthWords} />}
    {plugins > 0 &&
      <span className="gbx-count-chip" title={plural(plugins, "plugin", "plugins")} aria-label={plural(plugins, "plugin", "plugins")}>
        <span className="codicon codicon-extensions" aria-hidden />{plugins}
      </span>}
  </>;
}

/** Product-local selection and search never replace the shared catalogue selection. */
export function Composition({ state, loadingLabel, descriptors, selection, select, add, create, remove, settings, expanded, toggleFold }: CompositionProps): React.ReactElement {
  const [search, setSearch] = React.useState("");
  const query = search.trim().toLowerCase();
  const descriptor = (id: string) => descriptors.find(d => d.id === id);
  const matches = (id: string) => `${id} ${descriptor(id)?.display_name ?? ""}`.toLowerCase().includes(query);
  const explicit = state.intent?.selected_gears ?? [];
  const pending = !state.intent && (state.status === "loading" || state.status === "resolving");
  const named = new Set(explicit.map(g => g.gear));
  const plugins = new Set(explicit.flatMap(g => (g.plugins ?? []).map(p => p.gear)));
  const automatic = Object.entries(state.resolution?.product?.gears ?? {}).filter(([id]) => !named.has(id) && !plugins.has(id));
  const visible = explicit.filter(g => matches(g.gear) || g.plugins?.some(p => matches(p.gear)));
  const automaticVisible = automatic.filter(([id]) => matches(id));
  const health = gearHealth(state.diagnostics ?? []);
  return <div className="gbx-composition" data-composition>
    <nav className="gbx-composition-tree" aria-label="Product composition">
      <div className="gbx-composition-tools">
        <div className="gbx-composition-tools-heading"><h3>Selected gears{pending ? "" : ` (${explicit.length})`}</h3>
          <button type="button" className="gbx-start-primary" data-add-gear onClick={() => add()}>Add gear</button>
          <details className="gbx-row-menu"><summary aria-label="More add actions">⋯</summary>
            <div className="gbx-menu-items"><button type="button" data-create-gear onClick={create}>Create Gear…</button></div>
          </details>
        </div>
        <input type="search" className="theia-input" aria-label="Search product gears" placeholder="Search gears and plugins" value={search} onChange={e => setSearch(e.currentTarget.value)} />
      </div>
      {explicit.length === 0 && (state.status === "loading" || state.status === "resolving") &&
        <div className="gbx-empty" role="status" data-composition-loading={state.status}>{state.status === "loading" ? loadingLabel ?? "Loading the product…" : "Checking…"}</div>}
      {explicit.length === 0 && state.status !== "loading" && state.status !== "resolving" && <p className="gbx-empty">Add your first gear, then configure it here.</p>}
      {query && visible.length === 0 && automaticVisible.length === 0 && <p role="status">No matching gears or plugins.</p>}
      {visible.map(host => {
        const d = descriptor(host.gear);
        const points = d ? pointsOf(d).map(p => ({ key: pointKey(p), label: p.trait_ident })) : [];
        const connections = (host.plugins ?? []).map(p => ({ p, entryIndex: p.entry_index, spec: descriptor(p.gear)?.implements?.spec }));
        const active = (entry: typeof connections[number]) => !entry.p.profiles?.length || entry.p.profiles.includes(state.profile ?? "");
        const renderConnection = ({ p, entryIndex }: typeof connections[number]) => {
          const selected = selection?.kind === "plugin" && selection.host === host.gear && selection.entryIndex === entryIndex;
          const isActive = !p.profiles?.length || p.profiles.includes(state.profile ?? "");
          return <div className="gbx-composition-connection" key={entryIndex} data-plugin-host={host.gear} data-plugin-index={entryIndex} data-plugin-id={p.gear} data-plugin-active={isActive}>
            <button type="button" aria-pressed={selected} className={`gbx-choice ${selected ? "gbx-choice-on" : ""}`}
              onClick={() => select({ kind: "plugin", host: host.gear, id: p.gear, entryIndex, path: state.open?.path ?? "" })}>
              {descriptor(p.gear)?.display_name || p.gear}
            </button>
            <small>{p.profiles?.join(", ") || "All profiles"}{!isActive ? " · inactive here" : ""}</small>
            {/* Constructor Studio: beside the plugin, not only in its settings.
                The gear's own Remove takes the host and every plugin with it --
                a person dropping one plugin found that out only after the
                description lost two gears. */}
            <details className="gbx-row-menu"><summary aria-label={`Actions for ${p.gear}`}>⋯</summary>
              <div className="gbx-menu-items"><button type="button" className="gbx-composition-remove-plugin" data-remove-plugin={`${host.gear}:${entryIndex}`}
                aria-label={`Remove ${p.gear} from ${host.gear}`} title={`Remove ${p.gear} from ${host.gear}; ${host.gear} stays`}
                onClick={() => remove(host.gear, entryIndex)}>Remove from {d?.display_name || host.gear}</button></div>
            </details>
          </div>;
        };
        const renderConnections = (entries: typeof connections) => <>
          {entries.filter(active).map(renderConnection)}
          {entries.some(e => !active(e)) && <details className="gbx-inactive-connections" open={query ? true : undefined}>
            <summary>Other profiles ({entries.filter(e => !active(e)).length})</summary>
            {entries.filter(e => !active(e)).map(renderConnection)}
          </details>}
        </>;
        const unassigned = connections.filter(c => !c.spec || !points.some(p => p.key === c.spec));
        const chosen = selection?.kind === "gear" && selection.id === host.gear;
        const shut = !expanded.has(host.gear) && !query;
        const hasChildren = points.length > 0 || connections.length > 0;
        return <div key={host.gear} className={`gbx-composition-host ${chosen ? "gbx-composition-host-selected" : ""}`} data-asked-for={host.gear} data-collapsed={shut ? "true" : "false"}>
          <div className="gbx-composition-host-row">
            {hasChildren ? <button type="button" className={`gbx-twistie codicon codicon-chevron-${shut ? "right" : "down"}`}
              aria-expanded={!shut} aria-label={`${shut ? "Expand" : "Collapse"} ${host.gear}`} data-composition-expand={host.gear} onClick={() => toggleFold(host.gear)} />
              : <span className="gbx-twistie-space" />}
            <button type="button" data-composition-gear={host.gear} aria-pressed={chosen} className="gbx-composition-host-name" onClick={() => select({ kind: "gear", id: host.gear })}>
              <GearRowText name={d?.display_name || host.gear} line={d?.description ?? undefined}
                health={health.get(host.gear)} plugins={connections.length} />
            </button>
            <details className="gbx-row-menu"><summary aria-label={`Actions for ${host.gear}`}>⋯</summary>
              <div className="gbx-menu-items"><button type="button" aria-label={`Remove ${host.gear} from product`}
                title={(host.plugins ?? []).length > 0 ? `Remove ${host.gear} and its plugins (${(host.plugins ?? []).map(p => p.gear).join(", ")})` : `Remove ${host.gear} from the product`}
                onClick={() => remove(host.gear)}>Remove from product</button></div>
            </details>
          </div>
          {!shut && <>
            {!d && <small>Descriptor unavailable or still loading. This gear remains in your product.</small>}
            {points.map(point => <section className="gbx-composition-slot" key={point.key}>
              <h4>{point.label}</h4>{renderConnections(connections.filter(c => c.spec === point.key))}
              <button type="button" className="gbx-choice" data-add-plugin-for={`${host.gear}:${point.key}`} onClick={() => add(host.gear, point.key)}>Add compatible plugin</button>
            </section>)}
            {unassigned.length > 0 && <section className="gbx-composition-slot"><h4>Connections needing review</h4>{renderConnections(unassigned)}</section>}
          </>}
        </div>;
      })}
      {/* **A second group, not a fold.** The gears the closure pulled in were
          behind a `<details>` that started shut, so a product read as having
          only what was asked for. They are part of what runs; they get the same
          rows, under their own caption, with why each is here as its line. */}
      {automatic.length > 0 && <section className="gbx-composition-group gbx-composition-automatic" aria-label="Automatically included gears">
        <h3 className="gbx-group-caption">Automatically included ({automatic.length})</h3>
        {automaticVisible.map(([id, gear]) => {
          const d = descriptor(id);
          const points = d ? pointsOf(d) : [];
          const chosen = selection?.kind === "gear" && selection.id === id;
          const why = gear.selected_by.find(reason => reason.reason !== "selected") ?? gear.selected_by[0];
          const requiredBy = gear.selected_by.flatMap(reason => reason.reason === "colocated_by" ? [reason.gear] : []);
          return <div key={id} className={`gbx-composition-host gbx-automatic-gear ${chosen ? "gbx-composition-host-selected" : ""}`} data-pulled-in={id}>
            <div className="gbx-composition-host-row">
              <span className="gbx-twistie-space" />
              <button type="button" aria-pressed={chosen} className="gbx-composition-host-name"
                title={[d?.description, ...gear.selected_by.map(describeInclusion)].filter(Boolean).join("\n")}
                onClick={() => select({ kind: "gear", id })}>
                <GearRowText name={d?.display_name || id} line={why ? inclusionChip(why) : undefined} health={health.get(id)} plugins={0} />
              </button>
              <details className="gbx-row-menu"><summary aria-label={`Actions for ${id}`}>⋯</summary>
                <div className="gbx-menu-items">
                  {requiredBy.map(gearId => <button type="button" key={gearId} onClick={() => select({ kind: "gear", id: gearId })}>Go to {gearId}</button>)}
                  {points.length > 0 &&
                    <button type="button" data-add-plugin-for={`${id}:${points.length === 1 ? pointKey(points[0]!) : ""}`} title={`${id} becomes an explicitly selected gear`}
                      onClick={() => add(id, points.length === 1 ? pointKey(points[0]!) : undefined)}>Add compatible plugin</button>}
                </div>
              </details>
            </div>
          </div>;
        })}
      </section>}
    </nav>
    <section className="gbx-composition-settings" aria-label="Selected object settings" tabIndex={-1}>{settings}</section>
  </div>;
}
