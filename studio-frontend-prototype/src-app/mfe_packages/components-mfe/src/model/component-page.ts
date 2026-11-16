/* What a component's page and its list rows show, out of what the catalogue
 * answered (`GET /components`, `GET /components/{name}`) and the registry
 * entry: the type, and each section's items with their count. Nothing is
 * inferred here: a list the catalogue left empty is shown empty. */

import {
  catalogueComponentType,
  registryComponentType,
  isComponentType,
  COMPONENT_TYPES,
  type ComponentType,
} from "@constructor-studio/mfe-shared";
import type { CatalogNode, ComponentDetail, RegistryEntry } from "../api/types";
import { projectsOf } from "./registry";

/** A list row's type: what the catalogue laid on its node, else its registry kind. */
export function rowType(row: { node?: CatalogNode; entry?: RegistryEntry }): ComponentType {
  const fromNode = row.node ? catalogueComponentType(row.node.value) : "other";
  if (fromNode !== "other" || !row.entry) return fromNode;
  return registryComponentType(row.entry.kind);
}

/** For a plugin: the gears whose point it fills, as the catalogue laid them on its node. */
export function hostsOf(node: CatalogNode | undefined): string[] {
  const hosts = node?.value.component_hosts;
  return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
}

/** The page's type: the detail's, else the row's. */
export function detailType(detail: ComponentDetail | null, fallback: ComponentType): ComponentType {
  return detail && isComponentType(detail.component_type) ? detail.component_type : fallback;
}

/** How many rows of each type, in the order a filter offers them; types with none left out. */
export function typeCounts(types: readonly ComponentType[]): { type: ComponentType; count: number }[] {
  return COMPONENT_TYPES.map((type) => ({ type, count: types.filter((t) => t === type).length })).filter((c) => c.count > 0);
}

/** One line of a section: what kind of thing it is, its name, and a note. */
export interface PageItem {
  /** The i18n key of what it is (`item_capability`, …). */
  kind: string;
  name: string;
  note?: string;
  href?: string;
}

const items = (kind: string, names: readonly string[], note?: string): PageItem[] =>
  names.map((name) => ({ kind, name, note }));

/** What the component gives a product, one item each. */
export function providedItems(d: ComponentDetail): PageItem[] {
  const p = d.provides;
  const out: PageItem[] = [
    ...items("item_capability", p.capabilities),
    ...(p.implements ? [{ kind: "item_fills", name: p.implements }] : []),
    ...items("item_host", p.hosts),
    ...p.extension_points.map((x) => ({ kind: "item_point", name: x.spec, note: x.interface ?? undefined })),
    ...items("item_plugin", p.plugins),
    ...p.mcp_tools.map((x) => ({ kind: "item_tool", name: x.name, note: x.description })),
    ...items("item_type", p.types),
    ...items("item_port", p.ports),
    ...(p.health ? [{ kind: "item_health", name: p.health }] : []),
    ...items("item_variable", p.variables),
  ];
  if (p.openapi) out.push({ kind: "item_contract", name: "OpenAPI" });
  if (p.events) out.push({ kind: "item_events", name: "events" });
  return out;
}

/** What the component takes from elsewhere, one item each. */
export function neededItems(d: ComponentDetail): PageItem[] {
  const n = d.needs;
  return [
    ...items("item_dependency", n.components),
    ...items("item_service", n.services),
    ...items("item_database", n.databases),
    ...items("item_runtime", n.runtime),
    ...items("item_connection", n.connections),
  ];
}

/** Where the component is used: the projects declaring it, the projects and
 *  products using it (the registry's consumers by how), the components that
 *  depend on it, and the kits that claim it. */
export function usedItems(d: ComponentDetail | null, entry: RegistryEntry | undefined): PageItem[] {
  const out: PageItem[] = [];
  if (entry) {
    out.push(...items("item_declared_in", projectsOf(entry)));
    for (const c of entry.consumers ?? []) {
      const name = c.project_name || c.project_id;
      if (c.via.includes("product")) out.push({ kind: "item_product_of", name });
      const code = c.via.filter((v) => v !== "product");
      if (code.length > 0) out.push({ kind: "item_used_by_project", name, note: code.join(", ") });
    }
  }
  if (d) {
    out.push(...items("item_used_by_component", d.used_by.components));
    for (const k of d.used_by.kits) {
      const claimed = [...k.types, ...k.mcp_tools, ...k.routes];
      out.push({ kind: "item_kit", name: k.kit_name || k.kit, note: claimed.join(", ") });
    }
  }
  return out;
}

/** The projects a tile names as using the component: declaring it or consuming it. */
export function projectsUsing(entry: RegistryEntry | undefined): string[] {
  if (!entry) return [];
  const out = projectsOf(entry);
  for (const c of entry.consumers ?? []) {
    const name = c.project_name || c.project_id;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
